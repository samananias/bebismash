import decode from '@jsquash/avif/decode.js';
import encode from './avifSingleThread';
import type { ImageCodecAdapter, DecodedImage } from './types';
import { materializeStandaloneBuffer } from './types';
import type { ImagePolicy } from '../core/types';

export const avifAdapter: ImageCodecAdapter = {
  async decode(buffer: ArrayBuffer): Promise<DecodedImage> {
    const imgData = await decode(buffer);
    if (!imgData) {
      throw new Error('AVIF decode failed: empty or corrupted image data');
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
        speed: 6,
        lossless: policy.lossless,
      }
    );

    return materializeStandaloneBuffer(encoded);
  },
};
