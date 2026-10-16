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
  disposition: 'transformed' | 'original';
  buffer: ArrayBuffer;
  pageCount: number;
}

/**
 * Performs a conservative PDF rewrite using pdf-lib:
 * Loads document, saves with object streams, and reopens to validate output integrity.
 */
export async function rewritePdf(
  buffer: ArrayBuffer,
  _policy: DocumentPolicy,
  limits: ResourceLimits
): Promise<PdfRewriteResult> {
  const preflight = preflightPdf(buffer, limits);

  if (!preflight.valid || preflight.isEncrypted || preflight.isSigned) {
    return {
      disposition: 'original',
      reason:
        preflight.isEncrypted || preflight.isSigned ? 'protected_document' : 'unsupported_content',
      buffer: materializeStandaloneBuffer(buffer),
      pageCount: 0,
    };
  }

  try {
    const { PDFDocument, PDFDict, PDFName, PDFArray } = await import('pdf-lib');
    const pdfDoc = await PDFDocument.load(buffer, {
      ignoreEncryption: false,
      updateMetadata: false,
    });

    // Inspect parsed objects, including compressed object streams and nested field dictionaries.
    // Raw head/tail scans alone can miss signatures in the middle of a document.
    const visited = new Set<unknown>();
    const protectedObject = (object: unknown): boolean => {
      if (!object || visited.has(object)) return false;
      visited.add(object);
      if (object instanceof PDFDict) {
        if (
          object.has(PDFName.of('ByteRange')) ||
          object.get(PDFName.of('Type'))?.toString() === '/Sig' ||
          object.get(PDFName.of('FT'))?.toString() === '/Sig'
        )
          return true;
        return object.values().some((value) => protectedObject(value));
      }
      return object instanceof PDFArray && object.asArray().some((value) => protectedObject(value));
    };
    const isSigned = pdfDoc.context
      .enumerateIndirectObjects()
      .some(([, object]) => protectedObject(object));
    if (pdfDoc.isEncrypted || isSigned) {
      return {
        disposition: 'original',
        reason: 'protected_document',
        buffer: materializeStandaloneBuffer(buffer),
        pageCount: pdfDoc.getPageCount(),
      };
    }

    const originalPageCount = pdfDoc.getPageCount();

    // Conservative rewrite using object streams (PDF 1.5+ flate compression)
    const savedBytes = await pdfDoc.save({
      useObjectStreams: true,
      addDefaultPage: false,
    });

    // Validate reopened output per blueprint Section 4.4
    const reopened = await PDFDocument.load(savedBytes, {
      ignoreEncryption: false,
      updateMetadata: false,
    });

    if (
      savedBytes.byteLength > limits.maxOutputBytes ||
      reopened.getPageCount() !== originalPageCount
    ) {
      // Validation failure: fallback to original
      return {
        disposition: 'original',
        reason: 'validation_failed',
        buffer: materializeStandaloneBuffer(buffer),
        pageCount: originalPageCount,
      };
    }

    // Staging comparison: only commit if candidate is smaller than source
    if (savedBytes.byteLength < buffer.byteLength) {
      return {
        disposition: 'transformed',
        buffer: materializeStandaloneBuffer(savedBytes),
        pageCount: originalPageCount,
      };
    }

    return {
      disposition: 'original',
      reason: 'no_smaller_candidate',
      buffer: materializeStandaloneBuffer(buffer),
      pageCount: originalPageCount,
    };
  } catch {
    // If parsing or saving fails, preserve original byte-identical
    return {
      disposition: 'original',
      reason: 'unsupported_content',
      buffer: materializeStandaloneBuffer(buffer),
      pageCount: 0,
    };
  }
}
