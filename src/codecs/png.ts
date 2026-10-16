import { decode, encode } from '@jsquash/png';
import { optimise } from '@jsquash/oxipng';
import type { ImageCodecAdapter, DecodedImage } from './types';
import { materializeStandaloneBuffer } from './types';
import type { ImagePolicy } from '../core/types';

export const pngAdapter: ImageCodecAdapter = {
  async decode(buffer: ArrayBuffer): Promise<DecodedImage> {
    const imgData = await decode(buffer);
    if (!imgData) {
      throw new Error('PNG decode failed: empty or corrupted image data');
    }
    return {
      data: imgData.data,
      width: imgData.width,
      height: imgData.height,
    };
  },

  async encode(image: DecodedImage, policy: ImagePolicy): Promise<ArrayBuffer> {
    // 1. Encode raw RGBA to PNG
    const pngBuffer = await encode({
      data: image.data as unknown as ImageData['data'],
      width: image.width,
      height: image.height,
    } as unknown as ImageData);

    // 2. Optimize with oxipng
    const level = policy.oxipngLevel || 3;
    try {
      const optimized = await optimise(pngBuffer, { level });
      if (optimized && optimized.byteLength < pngBuffer.byteLength) {
        return materializeStandaloneBuffer(optimized);
      }
    } catch {
      // Fallback to unoptimized PNG if oxipng fails
    }

    return materializeStandaloneBuffer(pngBuffer);
  },

  /**
   * Direct lossless optimization on an existing PNG buffer without re-decoding
   */
  async optimize(buffer: ArrayBuffer, policy: ImagePolicy): Promise<ArrayBuffer> {
    const level = policy.oxipngLevel || 3;
    const optimized = await optimise(buffer, { level });
    if (optimized && optimized.byteLength < buffer.byteLength) {
      return materializeStandaloneBuffer(optimized);
    }
    return materializeStandaloneBuffer(buffer);
  },
};
