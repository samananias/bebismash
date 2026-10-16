import { describe, it, expect } from 'vitest';
import { parseImageMeta, scaleImageData } from './parser';

describe('Bounded Image Header Parser', () => {
  it('parses JPEG SOF dimensions accurately', () => {
    // Construct minimal JPEG stream with SOF0 (0xFF 0xC0)
    // SOI: FF D8
    // SOF0: FF C0 [len: 00 11] [precision: 08] [height: 00 64 = 100] [width: 00 C8 = 200] [components: 03] ...
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x64, 0x00, 0xc8, 0x03, 0x01, 0x11, 0x00,
      0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    ]);

    const meta = parseImageMeta(jpeg.buffer);
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(100);
    expect(meta.isAnimated).toBe(false);
    expect(meta.hasAlpha).toBe(false);
  });

  it('parses PNG IHDR dimensions, alpha flag, and detects APNG animation', () => {
    // PNG signature (8 bytes) + IHDR (4 bytes len + 4 bytes 'IHDR' + 13 bytes data + 4 bytes CRC)
    // width: 300 (0x00 0x00 0x01 0x2C), height: 150 (0x00 0x00 0x00 0x96)
    // colorType: 6 (RGBA)
    const png = new Uint8Array([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      0x00,
      0x00,
      0x00,
      0x0d, // IHDR length 13
      0x49,
      0x48,
      0x44,
      0x52, // 'IHDR'
      0x00,
      0x00,
      0x01,
      0x2c, // width = 300
      0x00,
      0x00,
      0x00,
      0x96, // height = 150
      0x08, // bit depth 8
      0x06, // color type 6 (RGBA)
      0x00,
      0x00,
      0x00, // comp, filter, interlace
      0x00,
      0x00,
      0x00,
      0x00, // CRC
      // acTL chunk (APNG animation control)
      0x00,
      0x00,
      0x00,
      0x08, // length 8
      0x61,
      0x63,
      0x54,
      0x4c, // 'acTL'
      0x00,
      0x00,
      0x00,
      0x0a,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00, // CRC
    ]);

    const meta = parseImageMeta(png.buffer);
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(300);
    expect(meta.height).toBe(150);
    expect(meta.hasAlpha).toBe(true);
    expect(meta.isAnimated).toBe(true);
  });

  it('parses WebP VP8X dimensions, alpha, and detects animation flag', () => {
    // RIFF + size + WEBP + VP8X chunk
    const webp = new Uint8Array(38);
    const view = new DataView(webp.buffer);

    // 'RIFF' + len + 'WEBP'
    webp.set(new TextEncoder().encode('RIFF'), 0);
    view.setUint32(4, 30, true);
    webp.set(new TextEncoder().encode('WEBP'), 8);

    // 'VP8X' + len 10
    webp.set(new TextEncoder().encode('VP8X'), 12);
    view.setUint32(16, 10, true);

    // Flags: animation bit (0x02) + alpha bit (0x10) = 0x12
    view.setUint8(20, 0x12);

    // 24-bit canvas width - 1 = 399 -> width = 400 (0x018F)
    view.setUint8(24, 0x8f);
    view.setUint8(25, 0x01);
    view.setUint8(26, 0x00);

    // 24-bit canvas height - 1 = 299 -> height = 300 (0x012B)
    view.setUint8(27, 0x2b);
    view.setUint8(28, 0x01);
    view.setUint8(29, 0x00);

    const meta = parseImageMeta(webp.buffer);
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(400);
    expect(meta.height).toBe(300);
    expect(meta.hasAlpha).toBe(true);
    expect(meta.isAnimated).toBe(true);
  });

  it('parses AVIF ispe box dimensions and detects avis sequence brand', () => {
    // Construct minimal ISO BMFF box structure with ftyp(avis) + meta/iprp/ipco/ispe
    const avif = new Uint8Array(64);
    const view = new DataView(avif.buffer);

    // ftyp box (len 24): 'ftyp', major 'avis', comp 'avif'
    view.setUint32(0, 24);
    avif.set(new TextEncoder().encode('ftyp'), 4);
    avif.set(new TextEncoder().encode('avis'), 8);
    view.setUint32(12, 0); // minor version
    avif.set(new TextEncoder().encode('avif'), 16);

    // ispe box (len 20) at offset 24
    view.setUint32(24, 20);
    avif.set(new TextEncoder().encode('ispe'), 28);
    view.setUint32(32, 0); // version & flags
    view.setUint32(36, 1920); // width
    view.setUint32(40, 1080); // height

    const meta = parseImageMeta(avif.buffer);
    expect(meta.format).toBe('avif');
    expect(meta.width).toBe(1920);
    expect(meta.height).toBe(1080);
    expect(meta.isAnimated).toBe(true);
  });
});

describe('Image Downscaler (scaleImageData)', () => {
  it('preserves dimensions when image is already within maxEdge', () => {
    const data = new Uint8ClampedArray(100 * 50 * 4);
    const src = { data, width: 100, height: 50 };
    const scaled = scaleImageData(src, 1920);
    expect(scaled.width).toBe(100);
    expect(scaled.height).toBe(50);
  });

  it('proportionally scales down when max dimension exceeds maxEdge', () => {
    const srcW = 3840;
    const srcH = 2160;
    const data = new Uint8ClampedArray(srcW * srcH * 4);
    // Fill with pattern
    data.fill(200);

    const src = { data, width: srcW, height: srcH };
    const scaled = scaleImageData(src, 1920);

    expect(scaled.width).toBe(1920);
    expect(scaled.height).toBe(1080);
    expect(scaled.data.byteLength).toBe(1920 * 1080 * 4);
    expect(scaled.data[0]).toBe(200);
  });
});
