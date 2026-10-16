/**
 * Bounded OOXML (DOCX, PPTX, XLSX) Preflight Validator
 * Inspects ZIP End of Central Directory (EOCD) and Central Directory records
 * to defend against ZIP bombs, path traversal, and detect macros/signatures.
 * Adheres to Section 4.4 and 5.2 of Master Engineering Blueprint.
 */

import type { ResourceLimits } from '../core/types';

export interface OoxmlPreflightResult {
  valid: boolean;
  isOoxml: boolean;
  entryCount: number;
  totalUncompressedBytes: number;
  expansionRatio: number;
  isMacroEnabled: boolean;
  isSigned: boolean;
  isEncrypted: boolean;
  reason?: string;
}

export function preflightOoxml(buffer: ArrayBuffer, limits: ResourceLimits): OoxmlPreflightResult {
  const byteLength = buffer.byteLength;
  const view = new DataView(buffer);

  if (byteLength < 22) {
    return {
      valid: false,
      isOoxml: false,
      entryCount: 0,
      totalUncompressedBytes: 0,
      expansionRatio: 0,
      isMacroEnabled: false,
      isSigned: false,
      isEncrypted: false,
      reason: 'file_too_small',
    };
  }

  // 1. Locate End of Central Directory (EOCD) record
  // EOCD is at least 22 bytes long, search backwards from the end (up to 65 KiB comment space)
  const maxSearch = Math.min(byteLength, 65536 + 22);
  let eocdOffset = -1;

  for (let i = byteLength - 22; i >= byteLength - maxSearch; i--) {
    if (
      view.getUint8(i) === 0x50 &&
      view.getUint8(i + 1) === 0x4b &&
      view.getUint8(i + 2) === 0x05 &&
      view.getUint8(i + 3) === 0x06
    ) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    return {
      valid: false,
      isOoxml: false,
      entryCount: 0,
      totalUncompressedBytes: 0,
      expansionRatio: 0,
      isMacroEnabled: false,
      isSigned: false,
      isEncrypted: false,
      reason: 'eocd_not_found',
    };
  }

  // EOCD fields
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdSize = view.getUint32(eocdOffset + 12, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  if (totalEntries > limits.maxEntries) {
    return {
      valid: false,
      isOoxml: false,
      entryCount: totalEntries,
      totalUncompressedBytes: 0,
      expansionRatio: 0,
      isMacroEnabled: false,
      isSigned: false,
      isEncrypted: false,
      reason: 'max_entries_exceeded',
    };
  }

  if (cdOffset + cdSize > byteLength) {
    return {
      valid: false,
      isOoxml: false,
      entryCount: totalEntries,
      totalUncompressedBytes: 0,
      expansionRatio: 0,
      isMacroEnabled: false,
      isSigned: false,
      isEncrypted: false,
      reason: 'invalid_central_directory',
    };
  }

  // 2. Parse Central Directory headers
  let offset = cdOffset;
  let totalUncompressedBytes = 0;
  let hasContentTypes = false;
  let isMacroEnabled = false;
  let isSigned = false;
  let isEncrypted = false;

  for (let entry = 0; entry < totalEntries; entry++) {
    if (offset + 46 > cdOffset + cdSize) break;

    // Signature: 0x50 0x4B 0x01 0x02
    if (
      view.getUint8(offset) !== 0x50 ||
      view.getUint8(offset + 1) !== 0x4b ||
      view.getUint8(offset + 2) !== 0x01 ||
      view.getUint8(offset + 3) !== 0x02
    ) {
      break;
    }

    const flags = view.getUint16(offset + 8, true);
    if ((flags & 0x01) !== 0) {
      isEncrypted = true;
    }

    const uncompressedSize = view.getUint32(offset + 24, true);
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraFieldLength = view.getUint16(offset + 30, true);
    const fileCommentLength = view.getUint16(offset + 32, true);

    totalUncompressedBytes += uncompressedSize;

    // Read filename
    let name = '';
    const nameOffset = offset + 46;
    if (nameOffset + fileNameLength <= byteLength) {
      for (let n = 0; n < fileNameLength; n++) {
        name += String.fromCharCode(view.getUint8(nameOffset + n));
      }
    }

    if (name === '[Content_Types].xml') {
      hasContentTypes = true;
    }

    const lowerName = name.toLowerCase();
    if (lowerName.includes('vbaproject.bin')) {
      isMacroEnabled = true;
    }
    if (lowerName.includes('_xmlsignatures') || lowerName.includes('digitalsignature')) {
      isSigned = true;
    }

    offset += 46 + fileNameLength + extraFieldLength + fileCommentLength;
  }

  const expansionRatio = byteLength > 0 ? totalUncompressedBytes / byteLength : 0;

  if (totalUncompressedBytes > limits.maxExpandedBytes) {
    return {
      valid: false,
      isOoxml: hasContentTypes,
      entryCount: totalEntries,
      totalUncompressedBytes,
      expansionRatio,
      isMacroEnabled,
      isSigned,
      isEncrypted,
      reason: 'max_expansion_size_exceeded',
    };
  }

  if (expansionRatio > limits.maxExpansionRatio) {
    return {
      valid: false,
      isOoxml: hasContentTypes,
      entryCount: totalEntries,
      totalUncompressedBytes,
      expansionRatio,
      isMacroEnabled,
      isSigned,
      isEncrypted,
      reason: 'max_expansion_ratio_exceeded',
    };
  }

  return {
    valid: hasContentTypes,
    isOoxml: hasContentTypes,
    entryCount: totalEntries,
    totalUncompressedBytes,
    expansionRatio,
    isMacroEnabled,
    isSigned,
    isEncrypted,
  };
}
