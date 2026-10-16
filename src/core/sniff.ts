import type { Category, Format, Engine, RouteDecision, Intensity } from './types';
import { calculateGenericReservation } from './hardware';

export interface SniffResult {
  format: Format;
  category: Category;
  engine: Engine;
  mime: string;
}

/**
 * Sniffs the first 4096 bytes of a binary file.
 * Bounds-checked and safe against truncated data.
 */
export function sniffBuffer(buffer: ArrayBuffer): SniffResult {
  const byteLength = buffer.byteLength;
  const view = new DataView(buffer);

  // Helper safe read
  const getUint8 = (offset: number): number | null => {
    return offset < byteLength ? view.getUint8(offset) : null;
  };

  const getAscii = (offset: number, length: number): string => {
    if (offset + length > byteLength) return '';
    let str = '';
    for (let i = 0; i < length; i++) {
      const b = view.getUint8(offset + i);
      if (b >= 32 && b <= 126) {
        str += String.fromCharCode(b);
      }
    }
    return str;
  };

  // 1. JPEG: FF D8 FF
  if (byteLength >= 3 && getUint8(0) === 0xff && getUint8(1) === 0xd8 && getUint8(2) === 0xff) {
    return { format: 'jpeg', category: 'image', engine: 'image', mime: 'image/jpeg' };
  }

  // 2. PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    byteLength >= 8 &&
    getUint8(0) === 0x89 &&
    getUint8(1) === 0x50 && // P
    getUint8(2) === 0x4e && // N
    getUint8(3) === 0x47 && // G
    getUint8(4) === 0x0d &&
    getUint8(5) === 0x0a &&
    getUint8(6) === 0x1a &&
    getUint8(7) === 0x0a
  ) {
    return { format: 'png', category: 'image', engine: 'image', mime: 'image/png' };
  }

  // 3. WebP: RIFF .... WEBP
  if (byteLength >= 12 && getAscii(0, 4) === 'RIFF' && getAscii(8, 4) === 'WEBP') {
    return { format: 'webp', category: 'image', engine: 'image', mime: 'image/webp' };
  }

  // 4. PDF: %PDF-
  if (byteLength >= 5 && getAscii(0, 5) === '%PDF-') {
    return { format: 'pdf', category: 'document', engine: 'officePdf', mime: 'application/pdf' };
  }

  // 5. ISO BMFF (AVIF, MP4, MOV) - Check box length and 'ftyp'
  if (byteLength >= 12 && getAscii(4, 4) === 'ftyp') {
    const majorBrand = getAscii(8, 4);
    if (majorBrand === 'avif' || majorBrand === 'avis') {
      return { format: 'avif', category: 'image', engine: 'image', mime: 'image/avif' };
    }
    // Check compatible brands in the rest of the ftyp box (up to 64 bytes)
    const scanLimit = Math.min(byteLength - 4, 64);
    let isAvif = false;
    for (let i = 12; i <= scanLimit; i += 4) {
      const brand = getAscii(i, 4);
      if (brand === 'avif' || brand === 'avis') {
        isAvif = true;
        break;
      }
    }
    if (isAvif) {
      return { format: 'avif', category: 'image', engine: 'image', mime: 'image/avif' };
    }

    if (majorBrand === 'qt  ') {
      return { format: 'mov', category: 'video', engine: 'video', mime: 'video/quicktime' };
    }
    return { format: 'mp4', category: 'video', engine: 'video', mime: 'video/mp4' };
  }

  // 6. WebM: EBML header 1A 45 DF A3
  if (
    byteLength >= 4 &&
    getUint8(0) === 0x1a &&
    getUint8(1) === 0x45 &&
    getUint8(2) === 0xdf &&
    getUint8(3) === 0xa3
  ) {
    // Scan for DocType 'webm' in first 64 bytes
    const textHeader = getAscii(4, Math.min(byteLength - 4, 60));
    if (textHeader.includes('webm')) {
      return { format: 'webm', category: 'video', engine: 'video', mime: 'video/webm' };
    }
  }

  // 7. ZIP / OOXML: 50 4B 03 04 or 50 4B 05 06
  if (byteLength >= 4 && getUint8(0) === 0x50 && getUint8(1) === 0x4b) {
    const b2 = getUint8(2);
    const b3 = getUint8(3);
    if ((b2 === 0x03 && b3 === 0x04) || (b2 === 0x05 && b3 === 0x06)) {
      // In M1 generic slice, ZIP and office packages are safely packaged/stored
      return { format: 'zip', category: 'archive', engine: 'generic', mime: 'application/zip' };
    }
  }

  // Fallback: Generic / Unknown
  return {
    format: 'unknown',
    category: 'other',
    engine: 'generic',
    mime: 'application/octet-stream',
  };
}

/**
 * Reads the first 4096 bytes of a File handle and sniffs format.
 */
export async function sniffFile(file: File): Promise<SniffResult> {
  const slice = file.slice(0, 4096);
  const buffer = await slice.arrayBuffer();
  return sniffBuffer(buffer);
}

/**
 * Creates routing decision based on sniffed format and current intensity.
 * In Milestone M1, all files route through the generic engine for safe zero-copy packaging.
 */
export function decideRoute(
  sniffResult: SniffResult,
  _sourceBytes: number,
  _intensity: Intensity
): RouteDecision {
  // In M1, generic slice handles all packaging
  return {
    format: sniffResult.format,
    category: sniffResult.category,
    engine: 'generic',
    disposition: 'original',
    reservationBytes: calculateGenericReservation(),
    reasonKey: 'm1_generic_slice',
  };
}
