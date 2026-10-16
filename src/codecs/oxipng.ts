import { materializeStandaloneBuffer } from './types';
import init, { optimise as optimiseBytes } from '@jsquash/oxipng/codec/pkg/squoosh_oxipng.js';
/** Explicit single-threaded optimizer; the package wrapper otherwise creates a hidden pool. */
export default async function optimise(buffer: ArrayBuffer, options: { level: number }) {
  await init();
  return materializeStandaloneBuffer(
    optimiseBytes(new Uint8Array(buffer), options.level, false, true)
  );
}
