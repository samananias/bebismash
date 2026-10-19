/**
 * Conservative PDF Baseline Adapter
 * Strict parser load, encryption/signature preservation, object-stream rewriting,
 * and reopening validation adhering to Section 4.4 of Master Engineering Blueprint.
 */

import type { DocumentPolicy, ResourceLimits, PreservationReason } from '../core/types';
import { materializeStandaloneBuffer } from './types';
import { createPdfReport, inventoryPdf } from './pdfReport';
import type { PdfDiagnostics } from '../core/types';

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
  pdfDiagnostics?: PdfDiagnostics;
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
  const report = createPdfReport(policy);
  let phase: PdfDiagnostics['failure'] = 'parse';
  let encryptionError = (_error: unknown) => false;
  const original = (reason: PreservationReason): PdfRewriteResult => ({
    disposition: 'original',
    pdfDiagnostics: report,
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
  // Byte scans are hints, not proof: a page can literally contain '/Encrypt' or '/ByteRange'.
  if (!preflight.valid) return original('unsupported_content');
  try {
    const { PDFDocument, PDFDict, PDFName, EncryptedPDFError } = await import('pdf-lib');
    encryptionError = (error) => error instanceof EncryptedPDFError;
    const {
      PdfGraphRefusal,
      walkPdfGraph,
      trailerRoots,
      validatePdfTrailers,
      validateRetainedObjects,
      normalizePdfNullReferences,
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
    report.pages = pageCount;
    inventoryPdf(doc, report);
    phase = 'graph';
    if (doc.isEncrypted || doc.context.trailerInfo.Encrypt) return original('protected_document');
    let signed = false;
    // Inspect all objects, including compressed, unreachable and nested signatures.
    await walkPdfGraph(
      doc.context,
      doc.context.enumerateIndirectObjects().map(([, object]) => object),
      { ...budget, allowMissingReferences: true },
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
    report.nullReferencesNormalized = await normalizePdfNullReferences(doc.context, budget);
    phase = 'conformance';
    const { inspectPdfConformance } = await import('./pdfMetadata');
    const conformanceKnown = await inspectPdfConformance(doc, budget);
    if (!conformanceKnown) {
      report.failure = 'conformance-unknown';
      return original('unsupported_content');
    }
    phase = 'graph';
    let removed = 0;
    if (policy.pdfMetadata === 'remove-xmp') {
      const { removePdfMetadata } = await import('./pdfMetadata');
      removed = await removePdfMetadata(doc, budget, report);
      report.metadataRemoved = removed;
      report.metadata = removed
        ? report.metadataPreserved
          ? 'partial'
          : 'removed'
        : report.metadataPreserved
          ? 'skipped'
          : 'preserved';
    }
    const retained = await walkPdfGraph(doc.context, trailerRoots(doc.context), budget);
    for (const [ref] of doc.context.enumerateIndirectObjects())
      if (!retained.has(ref)) doc.context.delete(ref);
    report.objectsRemoved = Math.max(
      0,
      report.objects - doc.context.enumerateIndirectObjects().length
    );
    const { recompressPdfStreams } = await import('./pdfStreams');
    await recompressPdfStreams(doc, policy, limits, budget, report);
    const { optimizePdfImages } = await import('./pdfImages');
    await optimizePdfImages(doc, policy, limits, budget, report);
    const finalReferences = await walkPdfGraph(doc.context, trailerRoots(doc.context), budget);
    phase = 'serialize';
    await checkpoint();
    const saved = await doc.save({
      useObjectStreams: true,
      addDefaultPage: false,
      updateFieldAppearances: false,
      objectsPerTick: 100,
    });
    await checkpoint();
    if (saved.byteLength > limits.maxOutputBytes) {
      report.validation = 'failed';
      report.failure = 'serialize';
      return original('validation_failed');
    }
    validation = true;
    phase = 'validation';
    const reopened = await PDFDocument.load(saved, loadOptions);
    await checkpoint();
    if (reopened.getPageCount() !== pageCount) {
      report.validation = 'failed';
      report.failure = 'validation';
      return original('validation_failed');
    }
    try {
      await walkPdfGraph(reopened.context, trailerRoots(reopened.context), budget);
      await validateRetainedObjects(doc.context, reopened.context, finalReferences, budget);
    } catch (error) {
      if (error instanceof PdfGraphRefusal) {
        report.validation = 'failed';
        report.failure = 'validation';
        return original('validation_failed');
      }
      throw error;
    }
    await checkpoint();
    report.validation = 'passed';
    if (saved.byteLength >= buffer.byteLength) return original('no_smaller_candidate');
    return {
      disposition: 'transformed',
      pdfDiagnostics: report,
      buffer: materializeStandaloneBuffer(saved),
      pageCount,
      ...(removed ? { pdfMetadataRemoved: removed } : {}),
    };
  } catch (error) {
    if (isCancelled()) throw new Error('Cancelled', { cause: error });
    if (encryptionError(error)) return original('protected_document');
    report.failure = performance.now() >= deadline ? 'deadline' : phase;
    if (validation) report.validation = 'failed';
    const { PdfConformanceRefusal } = await import('./pdfMetadata');
    if (error instanceof PdfConformanceRefusal) {
      report.failure = 'conformance';
      return original('conformance_document');
    }
    return original(validation ? 'validation_failed' : 'unsupported_content');
  }
}
