import type {
  Category,
  Format,
  Engine,
  RouteDecision,
  Intensity,
  ImagePolicy,
  DocumentPolicy,
} from './types';
import {
  calculateGenericReservation,
  calculateImageReservation,
  calculateOfficeReservation,
} from './hardware';

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
 * If ZIP signature is found and extension suggests OOXML, preflights for OOXML confirmation.
 */
export async function sniffFile(file: File): Promise<SniffResult> {
  const slice = file.slice(0, 4096);
  const buffer = await slice.arrayBuffer();
  const initial = sniffBuffer(buffer);

  if (initial.format === 'zip') {
    const extMatch = file.name.match(/\.(docx|pptx|xlsx)$/i);
    if (extMatch) {
      const ext = extMatch[1]!.toLowerCase() as 'docx' | 'pptx' | 'xlsx';
      const mimeMap: Record<'docx' | 'pptx' | 'xlsx', string> = {
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      };
      return {
        format: ext,
        category: 'document',
        engine: 'officePdf',
        mime: mimeMap[ext],
      };
    }
  }

  return initial;
}

/**
 * Creates routing decision based on sniffed format and current intensity.
 * In Milestone M2, images and OOXML documents are routed to their specialized engines.
 */
export function decideRoute(
  sniffResult: SniffResult,
  sourceBytes: number,
  _intensity: Intensity
): RouteDecision {
  if (sniffResult.engine === 'image') {
    return {
      format: sniffResult.format,
      category: sniffResult.category,
      engine: 'image',
      disposition: 'transform',
      reservationBytes: calculateImageReservation(sourceBytes, 1920, 1080),
      reasonKey: 'm2_image_adapter',
    };
  }

  if (
    sniffResult.engine === 'officePdf' &&
    (sniffResult.format === 'docx' ||
      sniffResult.format === 'pptx' ||
      sniffResult.format === 'xlsx')
  ) {
    return {
      format: sniffResult.format,
      category: sniffResult.category,
      engine: 'officePdf',
      disposition: 'transform',
      reservationBytes: calculateOfficeReservation(
        sourceBytes,
        Math.min(sourceBytes * 5, 64 * 1024 * 1024),
        16 * 1024 * 1024
      ),
      reasonKey: 'm2_ooxml_adapter',
    };
  }

  return {
    format: sniffResult.format,
    category: sniffResult.category,
    engine: 'generic',
    disposition: 'original',
    reservationBytes: calculateGenericReservation(),
    reasonKey: 'm1_generic_slice',
  };
}

/**
 * Creates appropriate policy for given engine and intensity
 */
export function createEnginePolicy(
  engine: Engine,
  format: Format,
  intensity: Intensity
): ImagePolicy | DocumentPolicy | { kind: 'generic'; level: 0 | 4 | 6 | 9 } {
  if (engine === 'image') {
    switch (intensity) {
      case 'heavy':
        return {
          kind: 'image',
          quality: 55,
          lossless: false,
          maxEdge: 1920,
          quantizeColors: null,
          oxipngLevel: 4,
          allowFormatChange: false,
        };
      case 'balanced':
        return {
          kind: 'image',
          quality: 75,
          lossless: false,
          maxEdge: null,
          quantizeColors: null,
          oxipngLevel: 3,
          allowFormatChange: false,
        };
      case 'gentle':
      default:
        return {
          kind: 'image',
          quality: 90,
          lossless: false,
          maxEdge: null,
          quantizeColors: null,
          oxipngLevel: 3,
          allowFormatChange: false,
        };
    }
  }

  if (engine === 'officePdf') {
    const imagePolicy: ImagePolicy =
      intensity === 'heavy'
        ? {
            kind: 'image',
            quality: 50,
            lossless: false,
            maxEdge: 1280,
            quantizeColors: null,
            oxipngLevel: 4,
            allowFormatChange: false,
          }
        : intensity === 'balanced'
          ? {
              kind: 'image',
              quality: 75,
              lossless: false,
              maxEdge: null,
              quantizeColors: null,
              oxipngLevel: 3,
              allowFormatChange: false,
            }
          : {
              kind: 'image',
              quality: 90,
              lossless: true,
              maxEdge: null,
              quantizeColors: null,
              oxipngLevel: 3,
              allowFormatChange: false,
            };

    return {
      kind: 'document',
      image: imagePolicy,
      deflateLevel: intensity === 'gentle' ? 6 : 9,
      pdfMode: 'rewrite',
      targetDpi: null,
    };
  }

  return {
    kind: 'generic',
    level: intensity === 'heavy' ? 9 : intensity === 'balanced' ? 6 : 4,
  };
}
