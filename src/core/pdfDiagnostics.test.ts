import { describe, expect, it } from 'vitest';
import { validPdfDiagnostics, createPdfReport } from './pdfDiagnostics';
import { createEnginePolicy } from './sniff';
import type { DocumentPolicy } from './types';

describe('local PDF diagnostics boundary', () => {
  const report = () =>
    createPdfReport(createEnginePolicy('officePdf', 'pdf', 'heavy') as DocumentPolicy);
  it('accepts the fixed numeric report and excludes free-form metadata, source names and bytes', () => {
    const value = report();
    value.pages = 706;
    value.imageSkips.color = 49;
    value.validation = 'passed';
    expect(validPdfDiagnostics(value)).toBe(true);
    expect(validPdfDiagnostics({ ...value, filename: 'private.pdf' })).toBe(false);
    expect(validPdfDiagnostics({ ...value, metadataContent: 'extracted source text' })).toBe(false);
    expect(validPdfDiagnostics({ ...value, imageBytes: -1 })).toBe(false);
    expect(validPdfDiagnostics({ ...value, imageSkips: { color: 100001 } })).toBe(false);
    expect(validPdfDiagnostics({ ...value, imageSkips: { unboundedReason: 'content' } })).toBe(
      false
    );
  });
  it('rejects oversized and cyclic reports without throwing in a worker message handler', () => {
    const value = report();
    expect(validPdfDiagnostics({ ...value, extra: 'x'.repeat(5000) })).toBe(false);
    const cyclic = { ...value, extra: {} };
    cyclic.extra = cyclic;
    expect(() => validPdfDiagnostics(cyclic)).not.toThrow();
    expect(validPdfDiagnostics(cyclic)).toBe(false);
  });
});
