/** Re-encoding cannot currently normalize EXIF orientation or preserve ICC/IPTC metadata. */
export function canReencodeOfficeJpeg(bytes: Uint8Array): boolean {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return false;
    const marker = bytes[offset + 1];
    if (marker === 0xda) return true;
    if (marker === 0xe1 || marker === 0xe2 || marker === 0xed) return false;
    const length = bytes[offset + 2]! * 256 + bytes[offset + 3]!;
    if (length < 2 || offset + 2 + length > bytes.length) return false;
    offset += 2 + length;
  }
  return false;
}
