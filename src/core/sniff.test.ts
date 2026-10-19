import { describe, it, expect } from 'vitest';
import { sniffBuffer, decideRoute, createEnginePolicy } from './sniff';

it.each(['gentle', 'balanced', 'heavy'] as const)(
  'does not authorize PDF cleanup through %s preset',
  (intensity) => {
    const policy = createEnginePolicy('officePdf', 'pdf', intensity);
    expect(policy.kind).toBe('document');
    expect('pdfMetadata' in policy && policy.pdfMetadata === 'remove-xmp').toBe(false);
  }
);

describe('Binary Header Sniffing', () => {
  it('identifies JPEG headers', () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const result = sniffBuffer(bytes.buffer);
    expect(result.format).toBe('jpeg');
    expect(result.category).toBe('image');
    expect(result.mime).toBe('image/jpeg');
  });

  it('identifies PNG signatures', () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    const result = sniffBuffer(bytes.buffer);
    expect(result.format).toBe('png');
    expect(result.category).toBe('image');
    expect(result.mime).toBe('image/png');
  });

  it('identifies WebP headers', () => {
    // 'RIFF' + 4 bytes size + 'WEBP'
    const header = new TextEncoder().encode('RIFF1234WEBPVP8 ');
    const result = sniffBuffer(header.buffer);
    expect(result.format).toBe('webp');
    expect(result.category).toBe('image');
    expect(result.mime).toBe('image/webp');
  });

  it('identifies PDF headers at offset 0', () => {
    const header = new TextEncoder().encode('%PDF-1.7\n%some binary comment');
    const result = sniffBuffer(header.buffer);
    expect(result.format).toBe('pdf');
    expect(result.category).toBe('document');
    expect(result.mime).toBe('application/pdf');
  });

  it('identifies AVIF box brand in ftyp box', () => {
    const header = new TextEncoder().encode('....ftypavif....');
    const result = sniffBuffer(header.buffer);
    expect(result.format).toBe('avif');
    expect(result.category).toBe('image');
  });

  it('identifies MP4 box brand in ftyp box', () => {
    const header = new TextEncoder().encode('....ftypisom....');
    const result = sniffBuffer(header.buffer);
    expect(result.format).toBe('mp4');
    expect(result.category).toBe('video');
  });

  it('identifies ZIP / PK archives', () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
    const result = sniffBuffer(bytes.buffer);
    expect(result.format).toBe('zip');
    expect(result.category).toBe('archive');
  });

  it('safely handles truncated buffers without throwing', () => {
    const empty = new Uint8Array([]);
    expect(sniffBuffer(empty.buffer).format).toBe('unknown');

    const oneByte = new Uint8Array([0xff]);
    expect(sniffBuffer(oneByte.buffer).format).toBe('unknown');

    const partialPng = new Uint8Array([0x89, 0x50]);
    expect(sniffBuffer(partialPng.buffer).format).toBe('unknown');
  });

  it('falls back to generic unknown for arbitrary binary data or text', () => {
    const text = new TextEncoder().encode('Hello, world! This is a plain text file.');
    const result = sniffBuffer(text.buffer);
    expect(result.format).toBe('unknown');
    expect(result.category).toBe('other');
    expect(result.engine).toBe('generic');
  });
});

describe('Format Routing in M2', () => {
  it('routes images to image engine with transform disposition', () => {
    const jpegSniff = {
      format: 'jpeg' as const,
      category: 'image' as const,
      engine: 'image' as const,
      mime: 'image/jpeg',
    };
    const decision = decideRoute(jpegSniff, 1024 * 1024, 'balanced');
    expect(decision.engine).toBe('image');
    expect(decision.disposition).toBe('transform');
    expect(decision.reservationBytes).toBeGreaterThan(0);
  });

  it('routes OOXML formats to officePdf engine with transform disposition', () => {
    const docxSniff = {
      format: 'docx' as const,
      category: 'document' as const,
      engine: 'officePdf' as const,
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
    const decision = decideRoute(docxSniff, 500_000, 'gentle');
    expect(decision.engine).toBe('officePdf');
    expect(decision.disposition).toBe('transform');
  });

  it('routes PDF format to officePdf engine with transform disposition', () => {
    const pdfSniff = {
      format: 'pdf' as const,
      category: 'document' as const,
      engine: 'officePdf' as const,
      mime: 'application/pdf',
    };
    const decision = decideRoute(pdfSniff, 1_000_000, 'balanced');
    expect(decision.engine).toBe('officePdf');
    expect(decision.disposition).toBe('transform');
    expect(decision.reservationBytes).toBeGreaterThan(0);
  });

  it('routes video formats (mp4, mov, webm) to video engine with transform disposition', () => {
    const mp4Sniff = {
      format: 'mp4' as const,
      category: 'video' as const,
      engine: 'video' as const,
      mime: 'video/mp4',
    };
    const decision = decideRoute(mp4Sniff, 5_000_000, 'heavy');
    expect(decision.engine).toBe('video');
    expect(decision.disposition).toBe('transform');
    expect(decision.reservationBytes).toBeGreaterThan(0);
  });

  it('routes unknown formats to generic engine in baseline', () => {
    const sniffResult = {
      format: 'unknown' as const,
      category: 'other' as const,
      engine: 'generic' as const,
      mime: 'application/octet-stream',
    };
    const decision = decideRoute(sniffResult, 1024, 'balanced');
    expect(decision.engine).toBe('generic');
    expect(decision.disposition).toBe('original');
    expect(decision.reservationBytes).toBeGreaterThan(0);
  });
});
