import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { preflightPdf, rewritePdf } from './pdf';
import type { ResourceLimits } from '../core/types';

const defaultLimits: ResourceLimits = {
  maxInputBytes: 64 * 1024 * 1024,
  maxOutputBytes: 128 * 1024 * 1024,
  maxPixels: 24_000_000,
  maxExpandedBytes: 200 * 1024 * 1024,
  maxEntryBytes: 100 * 1024 * 1024,
  maxEntries: 1000,
  maxExpansionRatio: 100,
  maxWallTimeMs: 60_000,
};

describe('Conservative PDF Baseline Adapter', () => {
  it('preflights valid PDF headers and extracts version', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 300]);
    const pdfBytes = await doc.save();

    const preflight = preflightPdf(pdfBytes.buffer as ArrayBuffer, defaultLimits);
    expect(preflight.valid).toBe(true);
    expect(preflight.isEncrypted).toBe(false);
    expect(preflight.isSigned).toBe(false);
  });

  it('rejects corrupt headers not starting with %PDF- at offset 0', () => {
    const junk = new TextEncoder().encode('garbage %PDF-1.4');
    const preflight = preflightPdf(junk.buffer, defaultLimits);
    expect(preflight.valid).toBe(false);
    expect(preflight.reason).toBe('invalid_pdf_header');
  });

  it('detects digital signatures and preserves original', () => {
    const signedPayload = new TextEncoder().encode(
      '%PDF-1.7\n1 0 obj\n<< /Type /Sig /ByteRange [0 100 200 300] >>\nendobj\ntrailer\n<<>>\n%%EOF'
    );
    const preflight = preflightPdf(signedPayload.buffer, defaultLimits);
    expect(preflight.valid).toBe(true);
    expect(preflight.isSigned).toBe(true);
  });

  it('rewrites valid PDF with object streams and validates reopened output', async () => {
    const doc = await PDFDocument.create();
    const page1 = doc.addPage([400, 600]);
    page1.drawText('Page 1 content');
    const page2 = doc.addPage([400, 600]);
    page2.drawText('Page 2 content');
    const pdfBytes = await doc.save();

    const result = await rewritePdf(
      pdfBytes.buffer as ArrayBuffer,
      {
        kind: 'document',
        image: {
          kind: 'image',
          quality: 75,
          lossless: false,
          maxEdge: null,
          quantizeColors: null,
          oxipngLevel: 3,
          allowFormatChange: false,
        },
        deflateLevel: 6,
        pdfMode: 'rewrite',
        targetDpi: null,
      },
      defaultLimits
    );

    expect(result.pageCount).toBe(2);
    expect(result.buffer).toBeInstanceOf(ArrayBuffer);
    expect(result.buffer.byteLength).toBeGreaterThan(0);

    // Verify output is valid and can be reopened independently
    const reloaded = await PDFDocument.load(result.buffer);
    expect(reloaded.getPageCount()).toBe(2);
  });
});
