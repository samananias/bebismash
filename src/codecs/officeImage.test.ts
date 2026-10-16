import { describe, expect, it } from 'vitest';
import { canReencodeOfficeJpeg } from './officeImage';
describe('Office JPEG fidelity guard', () => {
  it('permits ordinary JPEGs and preserves orientation/color/rights-bearing images', () => {
    expect(canReencodeOfficeJpeg(new Uint8Array([255, 216, 255, 218, 0, 2]))).toBe(true);
    for (const marker of [225, 226, 237])
      expect(
        canReencodeOfficeJpeg(new Uint8Array([255, 216, 255, marker, 0, 2, 255, 218, 0, 2]))
      ).toBe(false);
    expect(canReencodeOfficeJpeg(new Uint8Array([255, 216, 255, 224, 255, 255]))).toBe(false);
  });
});
