import type { ImagePolicy } from '../core/types';

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface DecodedImage extends ImageDimensions {
  data: Uint8ClampedArray;
}

export interface ImageCodecAdapter {
  decode(buffer: ArrayBuffer): Promise<DecodedImage>;
  encode(image: DecodedImage, policy: ImagePolicy): Promise<ArrayBuffer>;
  optimize?(buffer: ArrayBuffer, policy: ImagePolicy): Promise<ArrayBuffer>;
}

/**
 * Creates a standalone, exact-sized ArrayBuffer from any TypedArray or ArrayBufferView.
 * Crucial guarantee: Never transfers or exposes a Wasm memory heap.
 */
export function materializeStandaloneBuffer(view: ArrayBufferView | ArrayBuffer): ArrayBuffer {
  if (view instanceof ArrayBuffer) {
    return view.slice(0);
  }
  const copy = new Uint8Array(view.byteLength);
  copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  return copy.buffer;
}
