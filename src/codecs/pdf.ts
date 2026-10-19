/**
 * Conservative PDF Baseline Adapter
 * Strict parser load, encryption/signature preservation, object-stream rewriting,
 * and reopening validation adhering to Section 4.4 of Master Engineering Blueprint.
 */

import type { DocumentPolicy, ResourceLimits, PreservationReason } from '../core/types';
import { materializeStandaloneBuffer } from './types';

export interface PdfPreflightResult {
  valid: boolean;
  isEncrypted: boolean;
  isSigned: boolean;
  version: string;
  reason?: string;
}

/**
 * Preflights a PDF buffer by inspecting leading bytes and markers.
 */
export function preflightPdf(buffer: ArrayBuffer, limits: ResourceLimits): PdfPreflightResult {
  const byteLength = buffer.byteLength;
  const view = new DataView(buffer);

  if (byteLength < 8) {
    return {
      valid: false,
      isEncrypted: false,
      isSigned: false,
      version: '',
      reason: 'file_too_small',
    };
  }

  // Strict check: %PDF- at offset 0
  if (
    view.getUint8(0) !== 0x25 || // %
    view.getUint8(1) !== 0x50 || // P
    view.getUint8(2) !== 0x44 || // D
    view.getUint8(3) !== 0x46 || // F
    view.getUint8(4) !== 0x2d // -
  ) {
    return {
      valid: false,
      isEncrypted: false,
      isSigned: false,
      version: '',
      reason: 'invalid_pdf_header',
    };
  }

  // Version e.g. "1.4", "1.7"
  let version = '';
  for (let i = 5; i < Math.min(byteLength, 12); i++) {
    const ch = view.getUint8(i);
    if ((ch >= 0x30 && ch <= 0x39) || ch === 0x2e) {
      version += String.fromCharCode(ch);
    } else {
      break;
    }
  }

  if (byteLength > limits.maxInputBytes) {
    return {
      valid: false,
      isEncrypted: false,
      isSigned: false,
      version,
      reason: 'max_input_bytes_exceeded',
    };
  }

  // Scan ASCII text for /Encrypt or /ByteRange (digital signatures)
  // Bounded scan: check trailer/cross-reference area (last 64 KiB) and first 64 KiB
  const scanLimit = Math.min(byteLength, 65536);
  const textDecoder = new TextDecoder('latin1');
  const headStr = textDecoder.decode(new Uint8Array(buffer, 0, scanLimit));
  const tailStart = Math.max(0, byteLength - scanLimit);
  const tailStr = textDecoder.decode(new Uint8Array(buffer, tailStart, byteLength - tailStart));
  const combined = headStr + '\n' + tailStr;

  const isEncrypted = /\/Encrypt\b/.test(combined);
  const isSigned = /\/Type\s*\/Sig\b|\/ByteRange\b/.test(combined);

  return {
    valid: true,
    isEncrypted,
    isSigned,
    version,
  };
}

export interface PdfRewriteResult {
  reason?: PreservationReason;
  pdfMetadataRemoved?: number;
  disposition: 'transformed' | 'original';
  buffer: ArrayBuffer;
  pageCount: number;
}

/** Admitted worker only. Original input remains owned by the caller until output settles.
 * Cooperative checks surround parser/save work; the scheduler also enforces a hard deadline.
 */
export async function rewritePdf(
  buffer: ArrayBuffer,
  policy: DocumentPolicy,
  limits: ResourceLimits,
  isCancelled: () => boolean = () => false
): Promise<PdfRewriteResult> {
  const deadline = performance.now() + limits.maxWallTimeMs;
  let pageCount = 0;
  let validation = false;
  const original = (reason: PreservationReason): PdfRewriteResult => ({
    disposition: 'original',
    reason,
    buffer,
    pageCount,
  });
  const checkpoint = async () => {
    if (isCancelled()) throw new Error('Cancelled');
    if (performance.now() >= deadline) throw new Error('PDF deadline exceeded');
  };
  let lastYield = performance.now();
  const budget = {
    maxNodes: 100_000,
    maxEdges: 400_000,
    checkpoint: async () => {
      await checkpoint();
      if (performance.now() - lastYield >= 8) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        lastYield = performance.now();
        await checkpoint();
      }
    },
  };
  const preflight = preflightPdf(buffer, limits);
  if (!preflight.valid || preflight.isEncrypted || preflight.isSigned)
    return original(
      preflight.isEncrypted || preflight.isSigned ? 'protected_document' : 'unsupported_content'
    );
  try {
    const { PDFDocument, PDFDict, PDFName } = await import('pdf-lib');
    const {
      PdfGraphRefusal,
      walkPdfGraph,
      trailerRoots,
      validatePdfTrailers,
      validateRetainedObjects,
    } = await import('./pdfGraph');
    const loadOptions = {
      ignoreEncryption: false,
      updateMetadata: false,
      throwOnInvalidObject: true,
      parseSpeed: 100,
    };
    await checkpoint();
    const doc = await PDFDocument.load(buffer, loadOptions);
    await checkpoint();
    pageCount = doc.getPageCount();
    if (doc.isEncrypted || doc.context.trailerInfo.Encrypt) return original('protected_document');
    let signed = false;
    // Inspect all objects, including compressed, unreachable and nested signatures.
    await walkPdfGraph(
      doc.context,
      doc.context.enumerateIndirectObjects().map(([, object]) => object),
      budget,
      (object) => {
        if (
          object instanceof PDFDict &&
          (object.has(PDFName.of('ByteRange')) ||
            object.get(PDFName.of('Type')) === PDFName.of('Sig') ||
            object.get(PDFName.of('FT')) === PDFName.of('Sig'))
        )
          signed = true;
      }
    );
    if (signed) return original('protected_document');
    await validatePdfTrailers(new Uint8Array(buffer), doc.context, budget);
    let removed = 0;
    if (policy.pdfMetadata === 'remove-xmp') {
      const { removePdfMetadata } = await import('./pdfMetadata');
      removed = await removePdfMetadata(doc, budget);
    }
    const retained = await walkPdfGraph(doc.context, trailerRoots(doc.context), budget);
    await checkpoint();
    const saved = await doc.save({
      useObjectStreams: true,
      addDefaultPage: false,
      updateFieldAppearances: false,
      objectsPerTick: 100,
    });
    await checkpoint();
    if (saved.byteLength > limits.maxOutputBytes) return original('validation_failed');
    validation = true;
    const reopened = await PDFDocument.load(saved, loadOptions);
    await checkpoint();
    if (reopened.getPageCount() !== pageCount) return original('validation_failed');
    try {
      await walkPdfGraph(reopened.context, trailerRoots(reopened.context), budget);
      await validateRetainedObjects(doc.context, reopened.context, retained, budget);
    } catch (error) {
      if (error instanceof PdfGraphRefusal) return original('validation_failed');
      throw error;
    }
    await checkpoint();
    if (saved.byteLength >= buffer.byteLength) return original('no_smaller_candidate');
    return {
      disposition: 'transformed',
      buffer: materializeStandaloneBuffer(saved),
      pageCount,
      ...(removed ? { pdfMetadataRemoved: removed } : {}),
    };
  } catch (error) {
    if (isCancelled()) throw new Error('Cancelled', { cause: error });
    return original(
      validation
        ? 'validation_failed'
        : policy.pdfMetadata === 'remove-xmp'
          ? 'cleanup_unsupported'
          : 'unsupported_content'
    );
  }
}
