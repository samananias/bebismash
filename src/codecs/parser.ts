/**
 * Bounded Image Header & Metadata Parser
 * Extracts image dimensions and animation flags without decoding full raster data.
 * Adheres to Section 4.1 of Master Engineering Blueprint.
 */

export interface ParsedImageMeta {
  width: number;
  height: number;
  isAnimated: boolean;
  hasAlpha: boolean;
  format: 'jpeg' | 'png' | 'webp' | 'avif' | 'unknown';
}

/**
 * Parses image metadata from a bounded buffer slice (up to 1 MiB).
 */
export function parseImageMeta(buffer: ArrayBuffer): ParsedImageMeta {
  const byteLength = buffer.byteLength;
  const view = new DataView(buffer);

  if (byteLength < 16) {
    return { width: 0, height: 0, isAnimated: false, hasAlpha: false, format: 'unknown' };
  }

  // 1. JPEG: FF D8 FF
  if (view.getUint8(0) === 0xff && view.getUint8(1) === 0xd8 && view.getUint8(2) === 0xff) {
    const jpegMeta = parseJpeg(view, byteLength);
    return { ...jpegMeta, format: 'jpeg', isAnimated: false, hasAlpha: false };
  }

  // 2. PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    view.getUint8(0) === 0x89 &&
    view.getUint8(1) === 0x50 &&
    view.getUint8(2) === 0x4e &&
    view.getUint8(3) === 0x47
  ) {
    const pngMeta = parsePng(view, byteLength);
    return { ...pngMeta, format: 'png' };
  }

  // 3. WebP: RIFF .... WEBP
  if (byteLength >= 12 && getAscii(view, 0, 4) === 'RIFF' && getAscii(view, 8, 4) === 'WEBP') {
    const webpMeta = parseWebP(view, byteLength);
    return { ...webpMeta, format: 'webp' };
  }

  // 4. AVIF: ISO BMFF ftyp box
  if (byteLength >= 16 && getAscii(view, 4, 4) === 'ftyp') {
    const avifMeta = parseAvif(view, byteLength);
    return { ...avifMeta, format: 'avif' };
  }

  return { width: 0, height: 0, isAnimated: false, hasAlpha: false, format: 'unknown' };
}

function getAscii(view: DataView, offset: number, length: number): string {
  if (offset + length > view.byteLength) return '';
  let str = '';
  for (let i = 0; i < length; i++) {
    const b = view.getUint8(offset + i);
    str += String.fromCharCode(b);
  }
  return str;
}

/**
 * Bounded JPEG SOF marker walk (max 1 MiB scan)
 */
function parseJpeg(view: DataView, maxScan: number): { width: number; height: number } {
  let offset = 2; // skip SOI (FF D8)
  const limit = Math.min(view.byteLength, maxScan);

  while (offset + 4 < limit) {
    if (view.getUint8(offset) !== 0xff) {
      offset++;
      continue;
    }

    const marker = view.getUint8(offset + 1);
    offset += 2;

    // Standalone markers without payload
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      (marker >= 0xd0 && marker <= 0xd7) ||
      marker === 0x01
    ) {
      continue;
    }

    if (offset + 2 > limit) break;
    const length = view.getUint16(offset); // includes length bytes
    if (length < 2) break;

    // Check for SOF markers (SOF0 = 0xC0, SOF1 = 0xC1, SOF2 = 0xC2, etc.)
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);

    if (isSof && offset + 7 <= limit) {
      // payload: [precision: 1 byte][height: 2 bytes][width: 2 bytes]
      const height = view.getUint16(offset + 3);
      const width = view.getUint16(offset + 5);
      return { width, height };
    }

    offset += length;
  }

  return { width: 0, height: 0 };
}

/**
 * Bounded PNG IHDR & chunk walk to check dimensions, color type, and APNG animation
 */
function parsePng(
  view: DataView,
  maxScan: number
): { width: number; height: number; isAnimated: boolean; hasAlpha: boolean } {
  let width = 0;
  let height = 0;
  let hasAlpha = false;
  let isAnimated = false;

  const limit = Math.min(view.byteLength, maxScan);
  let offset = 8; // skip 8-byte signature

  while (offset + 8 <= limit) {
    const chunkLength = view.getUint32(offset);
    const chunkType = getAscii(view, offset + 4, 4);
    offset += 8;

    if (chunkType === 'IHDR' && chunkLength >= 13 && offset + 13 <= limit) {
      width = view.getUint32(offset);
      height = view.getUint32(offset + 4);
      const colorType = view.getUint8(offset + 9);
      // colorType: 4 = grayscale + alpha, 6 = RGBA
      if (colorType === 4 || colorType === 6) {
        hasAlpha = true;
      }
    } else if (chunkType === 'acTL') {
      // APNG animation control chunk
      isAnimated = true;
    } else if (chunkType === 'tRNS') {
      // Palette or single-color transparency
      hasAlpha = true;
    }

    // Skip chunk data + 4-byte CRC
    offset += chunkLength + 4;
  }

  return { width, height, isAnimated, hasAlpha };
}

/**
 * Bounded WebP parser for VP8 / VP8L / VP8X and animation
 */
function parseWebP(
  view: DataView,
  maxScan: number
): { width: number; height: number; isAnimated: boolean; hasAlpha: boolean } {
  let width = 0;
  let height = 0;
  let isAnimated = false;
  let hasAlpha = false;

  const limit = Math.min(view.byteLength, maxScan);
  let offset = 12; // skip RIFF + size + WEBP

  while (offset + 8 <= limit) {
    const chunkType = getAscii(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true); // WebP uses little-endian chunk sizes
    offset += 8;

    if (chunkType === 'VP8X' && chunkSize >= 10 && offset + 10 <= limit) {
      const flags = view.getUint8(offset);
      // Bit 1: Animation flag (0x02)
      if ((flags & 0x02) !== 0) {
        isAnimated = true;
      }
      // Bit 4: Alpha flag (0x10)
      if ((flags & 0x10) !== 0) {
        hasAlpha = true;
      }
      // 24-bit canvas width and height (little-endian)
      const w0 = view.getUint8(offset + 4);
      const w1 = view.getUint8(offset + 5);
      const w2 = view.getUint8(offset + 6);
      width = 1 + (w0 | (w1 << 8) | (w2 << 16));

      const h0 = view.getUint8(offset + 7);
      const h1 = view.getUint8(offset + 8);
      const h2 = view.getUint8(offset + 9);
      height = 1 + (h0 | (h1 << 8) | (h2 << 16));
    } else if (chunkType === 'VP8 ' && chunkSize >= 10 && offset + 10 <= limit) {
      // Lossy VP8 frame header
      // Check start code: 0x9D 0x01 0x2A at offset + 3
      if (
        view.getUint8(offset + 3) === 0x9d &&
        view.getUint8(offset + 4) === 0x01 &&
        view.getUint8(offset + 5) === 0x2a
      ) {
        width = view.getUint16(offset + 6, true) & 0x3fff;
        height = view.getUint16(offset + 8, true) & 0x3fff;
      }
    } else if (chunkType === 'VP8L' && chunkSize >= 5 && offset + 5 <= limit) {
      // Lossless VP8L header: signature 0x2F at offset 0
      if (view.getUint8(offset) === 0x2f) {
        const b0 = view.getUint8(offset + 1);
        const b1 = view.getUint8(offset + 2);
        const b2 = view.getUint8(offset + 3);
        const b3 = view.getUint8(offset + 4);
        width = 1 + (((b1 & 0x3f) << 8) | b0);
        height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
        hasAlpha = (b3 & 0x10) !== 0;
      }
    } else if (chunkType === 'ANIM') {
      isAnimated = true;
    }

    // Advance with padding: WebP chunks are padded to even lengths
    offset += chunkSize + (chunkSize % 2);
  }

  return { width, height, isAnimated, hasAlpha };
}

/**
 * Bounded AVIF ISO BMFF box parser
 */
function parseAvif(
  view: DataView,
  maxScan: number
): { width: number; height: number; isAnimated: boolean; hasAlpha: boolean } {
  let width = 0;
  let height = 0;
  let isAnimated = false;
  const hasAlpha = false;

  const limit = Math.min(view.byteLength, maxScan);

  // Check ftyp box for 'avis' (AVIF animated sequence)
  const ftypLen = Math.min(view.getUint32(0), limit);
  for (let i = 8; i + 4 <= ftypLen; i += 4) {
    const brand = getAscii(view, i, 4);
    if (brand === 'avis') {
      isAnimated = true;
    }
  }

  // Scan for 'ispe' (Image Spatial Extents) box inside meta box
  // Recursively or iteratively scan top-level and container boxes
  function scanBoxes(start: number, end: number, depth = 0): void {
    if (depth > 5) return;
    let offset = start;
    while (offset + 8 <= end) {
      let boxSize = view.getUint32(offset);
      const boxType = getAscii(view, offset + 4, 4);
      if (boxSize === 0) boxSize = end - offset;
      if (boxSize === 1 && offset + 16 <= end) {
        // Extended 64-bit size: take lower 32 bits if safe
        boxSize = view.getUint32(offset + 12);
      }
      if (boxSize < 8 || offset + boxSize > end) break;

      if (boxType === 'ispe' && offset + 20 <= end) {
        // FullBox: 4 bytes version & flags + 4 bytes width + 4 bytes height
        width = view.getUint32(offset + 12);
        height = view.getUint32(offset + 16);
        return;
      }

      if (boxType === 'meta') {
        // meta is a FullBox in ISO BMFF (4 bytes version/flags at offset + 8)
        scanBoxes(offset + 12, offset + boxSize, depth + 1);
      } else if (boxType === 'iprp' || boxType === 'ipco') {
        scanBoxes(offset + 8, offset + boxSize, depth + 1);
      }

      offset += boxSize;
    }
  }

  scanBoxes(0, limit);

  return { width, height, isAnimated, hasAlpha };
}

/**
 * Bilinear image downscaler when maxEdge constraint is enabled.
 * Returns a new ImageData with preserved aspect ratio.
 */
export function scaleImageData(
  source: { data: Uint8ClampedArray; width: number; height: number },
  maxEdge: number
): { data: Uint8ClampedArray; width: number; height: number } {
  const { width: srcW, height: srcH, data: srcData } = source;
  const maxSrcEdge = Math.max(srcW, srcH);

  if (maxSrcEdge <= maxEdge || maxEdge <= 0) {
    return source;
  }

  const scale = maxEdge / maxSrcEdge;
  const dstW = Math.max(1, Math.round(srcW * scale));
  const dstH = Math.max(1, Math.round(srcH * scale));
  const dstData = new Uint8ClampedArray(dstW * dstH * 4);

  const xRatio = srcW / dstW;
  const yRatio = srcH / dstH;

  for (let dy = 0; dy < dstH; dy++) {
    const srcY = Math.min(dy * yRatio, srcH - 1);
    const y0 = Math.floor(srcY);
    const y1 = Math.min(y0 + 1, srcH - 1);
    const yWeight = srcY - y0;

    for (let dx = 0; dx < dstW; dx++) {
      const srcX = Math.min(dx * xRatio, srcW - 1);
      const x0 = Math.floor(srcX);
      const x1 = Math.min(x0 + 1, srcW - 1);
      const xWeight = srcX - x0;

      const idxDst = (dy * dstW + dx) * 4;
      const idx00 = (y0 * srcW + x0) * 4;
      const idx10 = (y0 * srcW + x1) * 4;
      const idx01 = (y1 * srcW + x0) * 4;
      const idx11 = (y1 * srcW + x1) * 4;

      for (let c = 0; c < 4; c++) {
        const top = srcData[idx00 + c]! * (1 - xWeight) + srcData[idx10 + c]! * xWeight;
        const bottom = srcData[idx01 + c]! * (1 - xWeight) + srcData[idx11 + c]! * xWeight;
        dstData[idxDst + c] = Math.round(top * (1 - yWeight) + bottom * yWeight);
      }
    }
  }

  return { data: dstData, width: dstW, height: dstH };
}
