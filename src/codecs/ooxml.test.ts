import { describe, it, expect } from 'vitest';
import { preflightOoxml } from './ooxml';
import { zipSync, strToU8 } from 'fflate';
import type { ResourceLimits } from '../core/types';

const defaultLimits: ResourceLimits = {
  maxInputBytes: 2 * 1024 * 1024 * 1024,
  maxOutputBytes: 128 * 1024 * 1024,
  maxPixels: 24_000_000,
  maxExpandedBytes: 200 * 1024 * 1024,
  maxEntryBytes: 100 * 1024 * 1024,
  maxEntries: 1000,
  maxExpansionRatio: 100,
  maxWallTimeMs: 60_000,
};

describe('Bounded OOXML Preflight Validator', () => {
  it('confirms valid OOXML packages containing [Content_Types].xml', () => {
    const pkg = {
      '[Content_Types].xml': strToU8('<Types></Types>'),
      '_rels/.rels': strToU8('<Relationships></Relationships>'),
      'word/document.xml': strToU8('<w:document></w:document>'),
    };
    const zipBytes = zipSync(pkg);

    const result = preflightOoxml(zipBytes.buffer, defaultLimits);
    expect(result.valid).toBe(true);
    expect(result.isOoxml).toBe(true);
    expect(result.entryCount).toBe(3);
    expect(result.isMacroEnabled).toBe(false);
    expect(result.isSigned).toBe(false);
  });

  it('detects macro-enabled packages (vbaProject.bin)', () => {
    const pkg = {
      '[Content_Types].xml': strToU8('<Types></Types>'),
      'word/vbaProject.bin': new Uint8Array([0x01, 0x02, 0x03]),
    };
    const zipBytes = zipSync(pkg);

    const result = preflightOoxml(zipBytes.buffer, defaultLimits);
    expect(result.valid).toBe(true);
    expect(result.isMacroEnabled).toBe(true);
  });

  it('detects digitally signed packages (_xmlsignatures)', () => {
    const pkg = {
      '[Content_Types].xml': strToU8('<Types></Types>'),
      '_xmlsignatures/sig1.xml': strToU8('<Signature></Signature>'),
    };
    const zipBytes = zipSync(pkg);

    const result = preflightOoxml(zipBytes.buffer, defaultLimits);
    expect(result.valid).toBe(true);
    expect(result.isSigned).toBe(true);
  });

  it('rejects archives missing [Content_Types].xml as non-OOXML', () => {
    const pkg = {
      'file.txt': strToU8('hello plain zip'),
    };
    const zipBytes = zipSync(pkg);

    const result = preflightOoxml(zipBytes.buffer, defaultLimits);
    expect(result.valid).toBe(false);
    expect(result.isOoxml).toBe(false);
  });

  it('rejects archives exceeding maxEntries limit', () => {
    const strictLimits: ResourceLimits = {
      ...defaultLimits,
      maxEntries: 2,
    };
    const pkg = {
      '[Content_Types].xml': strToU8('<Types></Types>'),
      'a.xml': strToU8('a'),
      'b.xml': strToU8('b'),
    };
    const zipBytes = zipSync(pkg);

    const result = preflightOoxml(zipBytes.buffer, strictLimits);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('max_entries_exceeded');
  });

  it('rejects archives exceeding maxExpansionRatio limit (ZIP bomb protection)', () => {
    const strictLimits: ResourceLimits = {
      ...defaultLimits,
      maxExpansionRatio: 5,
    };
    // 50 KB of zeros compresses to ~100 bytes (expansion ratio > 500)
    const highlyCompressible = new Uint8Array(50_000);
    const pkg = {
      '[Content_Types].xml': strToU8('<Types></Types>'),
      'data.bin': highlyCompressible,
    };
    const zipBytes = zipSync(pkg);

    const result = preflightOoxml(zipBytes.buffer, strictLimits);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('max_expansion_ratio_exceeded');
  });
});
