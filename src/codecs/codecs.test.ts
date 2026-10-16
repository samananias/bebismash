import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { jpegAdapter } from './jpeg';
import { pngAdapter } from './png';
import { webpAdapter } from './webp';
import { avifAdapter } from './avif';
import type { ImagePolicy } from '../core/types';

beforeAll(() => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const urlStr = String(url);
    if (urlStr.startsWith('file:')) {
      const filePath = fileURLToPath(urlStr);
      const buf = fs.readFileSync(filePath);
      return new Response(buf, { headers: { 'Content-Type': 'application/wasm' } });
    }
    return originalFetch(url, opts);
  };
});

const defaultImagePolicy: ImagePolicy = {
  kind: 'image',
  quality: 75,
  lossless: false,
  maxEdge: null,
  quantizeColors: null,
  oxipngLevel: 3,
  allowFormatChange: false,
};

describe('Media Codec Adapters', () => {
  const testWidth = 8;
  const testHeight = 8;
  const testData = new Uint8ClampedArray(testWidth * testHeight * 4);
  // Fill with test pixels
  for (let i = 0; i < testData.length; i += 4) {
    testData[i] = 180; // R
    testData[i + 1] = 120; // G
    testData[i + 2] = 60; // B
    testData[i + 3] = 255; // A
  }
  const sampleImage = {
    data: testData,
    width: testWidth,
    height: testHeight,
  };

  it('encodes and decodes JPEG with MozJPEG and returns standalone buffer', async () => {
    const encoded = await jpegAdapter.encode(sampleImage, {
      ...defaultImagePolicy,
      quality: 80,
    });

    expect(encoded).toBeInstanceOf(ArrayBuffer);
    expect(encoded.byteLength).toBeGreaterThan(0);

    const decoded = await jpegAdapter.decode(encoded);
    expect(decoded.width).toBe(testWidth);
    expect(decoded.height).toBe(testHeight);
    expect(decoded.data.byteLength).toBe(testWidth * testHeight * 4);
  });

  it('encodes and decodes PNG and optimizes with oxipng', async () => {
    const encoded = await pngAdapter.encode(sampleImage, {
      ...defaultImagePolicy,
      oxipngLevel: 3,
    });

    expect(encoded).toBeInstanceOf(ArrayBuffer);
    expect(encoded.byteLength).toBeGreaterThan(0);

    const decoded = await pngAdapter.decode(encoded);
    expect(decoded.width).toBe(testWidth);
    expect(decoded.height).toBe(testHeight);

    // Direct lossless optimize
    const optimized = await pngAdapter.optimize!(encoded, defaultImagePolicy);
    expect(optimized.byteLength).toBeLessThanOrEqual(encoded.byteLength);
  });

  it('encodes and decodes WebP with normalized quality', async () => {
    const encoded = await webpAdapter.encode(sampleImage, {
      ...defaultImagePolicy,
      quality: 75,
    });

    expect(encoded).toBeInstanceOf(ArrayBuffer);
    expect(encoded.byteLength).toBeGreaterThan(0);

    const decoded = await webpAdapter.decode(encoded);
    expect(decoded.width).toBe(testWidth);
    expect(decoded.height).toBe(testHeight);
  });

  it('encodes and decodes AVIF with speed 6 and normalized quality', async () => {
    const encoded = await avifAdapter.encode(sampleImage, {
      ...defaultImagePolicy,
      quality: 70,
    });

    expect(encoded).toBeInstanceOf(ArrayBuffer);
    expect(encoded.byteLength).toBeGreaterThan(0);

    const decoded = await avifAdapter.decode(encoded);
    expect(decoded.width).toBe(testWidth);
    expect(decoded.height).toBe(testHeight);
  });
});
