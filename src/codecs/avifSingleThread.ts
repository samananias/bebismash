import factory from '@jsquash/avif/codec/enc/avif_enc.js';
import { defaultOptions } from '@jsquash/avif/meta.js';
let ready: ReturnType<typeof factory> | undefined;
/** The package auto-detects threads; use its single-threaded factory within our reservation. */
export default async function encode(data: ImageData, options: Partial<typeof defaultOptions>) {
  const module = await (ready ??= factory());
  const merged = { ...defaultOptions, ...options };
  if (merged.lossless) {
    merged.quality = 100;
    merged.qualityAlpha = -1;
    merged.subsample = 3;
  }
  const output = module.encode(new Uint8Array(data.data.buffer), data.width, data.height, merged);
  if (!output) throw new Error('AVIF encoding failed');
  return output.buffer;
}
