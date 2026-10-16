import { decode, encode } from '@jsquash/webp';
import type { ImageCodecAdapter, DecodedImage } from './types';
import { materializeStandaloneBuffer } from './types';
import type { ImagePolicy } from '../core/types';

export const webpAdapter: ImageCodecAdapter = {
  async decode(buffer: ArrayBuffer): Promise<DecodedImage> {
    const imgData = await decode(buffer);
    if (!imgData) {
      throw new Error('WebP decode failed: empty or corrupted image data');
    }
    return {
      data: imgData.data,
      width: imgData.width,
      height: imgData.height,
    };
  },

  async encode(image: DecodedImage, policy: ImagePolicy): Promise<ArrayBuffer> {
    const quality = Math.max(1, Math.min(100, Math.round(policy.quality)));

    const encoded = await encode(
      {
        data: image.data as unknown as ImageData['data'],
        width: image.width,
        height: image.height,
      } as unknown as ImageData,
      {
        quality,
        lossless: policy.lossless ? 1 : 0,
      }
    );

    return materializeStandaloneBuffer(encoded);
  },
};
