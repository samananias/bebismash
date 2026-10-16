import { decode, encode } from '@jsquash/jpeg';
import type { ImageCodecAdapter, DecodedImage } from './types';
import { materializeStandaloneBuffer } from './types';
import type { ImagePolicy } from '../core/types';

export const jpegAdapter: ImageCodecAdapter = {
  async decode(buffer: ArrayBuffer): Promise<DecodedImage> {
    const imgData = await decode(buffer);
    if (!imgData) {
      throw new Error('JPEG decode failed: empty or corrupted image data');
    }
    return {
      data: imgData.data,
      width: imgData.width,
      height: imgData.height,
    };
  },

  async encode(image: DecodedImage, policy: ImagePolicy): Promise<ArrayBuffer> {
    const quality = Math.max(1, Math.min(100, Math.round(policy.quality)));
    // Blueprint Section 4.2: Gentle: 90, 4:4:4 (subsample: 1); Balanced/Heavy: 4:2:0 (subsample: 2)
    const subsample = quality >= 90 ? 1 : 2;

    const encoded = await encode(
      {
        data: image.data as unknown as ImageData['data'],
        width: image.width,
        height: image.height,
      } as unknown as ImageData,
      {
        quality,
        auto_subsample: false,
        chroma_subsample: subsample,
        baseline: false,
        progressive: true,
      }
    );

    return materializeStandaloneBuffer(encoded);
  },
};
