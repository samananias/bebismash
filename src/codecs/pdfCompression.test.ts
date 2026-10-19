import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNull,
  PDFRawStream,
  PDFRef,
  decodePDFRawStream,
} from 'pdf-lib';
import type { DocumentPolicy, Intensity, ResourceLimits } from '../core/types';
import { jpegAdapter } from './jpeg';
import { rewritePdf } from './pdf';
import { createPdfReport } from './pdfReport';
import { optimizePdfImages } from './pdfImages';
import { normalizePdfNullReferences } from './pdfGraph';
import { analyzePdfPlacements, multiplyPdfMatrices, pdfContentTokens } from './pdfPlacement';
import { pdfCompressionFixtures } from './testing/pdfCompressionFixtures';
import type { PdfFixtureName } from './testing/pdfCompressionFixtures';

const limits: ResourceLimits = {
  maxInputBytes: 64 * 1024 * 1024,
  maxOutputBytes: 64 * 1024 * 1024,
  maxPixels: 24_000_000,
  maxExpandedBytes: 64 * 1024 * 1024,
  maxEntryBytes: 64 * 1024 * 1024,
  maxEntries: 1000,
  maxExpansionRatio: 100,
  maxWallTimeMs: 60000,
  pdfImageWorkingBytes: 128 * 1024 * 1024,
};
const budget = () => ({ maxNodes: 100000, maxEdges: 400000, checkpoint: async () => {} });
const policy = (intensity: Intensity): DocumentPolicy => ({
  kind: 'document',
  pdfMode: intensity === 'gentle' ? 'rewrite' : 'image-adapter',
  targetDpi: intensity === 'gentle' ? null : intensity === 'balanced' ? 150 : 96,
  deflateLevel: intensity === 'gentle' ? 6 : 9,
  image: {
    kind: 'image',
    quality: intensity === 'gentle' ? 90 : intensity === 'balanced' ? 75 : 55,
    lossless: intensity === 'gentle',
    maxEdge: null,
    quantizeColors: null,
    oxipngLevel: 3,
    allowFormatChange: false,
  },
});
const arrayBuffer = (bytes: Uint8Array) => bytes.slice().buffer as ArrayBuffer;
const images = (doc: PDFDocument) =>
  doc.context
    .enumerateIndirectObjects()
    .filter(
      ([, object]) =>
        object instanceof PDFRawStream &&
        object.dict.lookup(PDFName.of('Subtype')) === PDFName.of('Image')
    );
const imagePayload = (stream: PDFRawStream) => {
  const filter = stream.dict.get(PDFName.of('Filter'))?.toString() ?? '';
  if (filter.includes('DCTDecode'))
    return filter.includes('FlateDecode')
      ? new Uint8Array(inflateSync(stream.getContents()))
      : stream.getContents();
  return decodePDFRawStream(stream).decode();
};
const contents = (doc: PDFDocument) =>
  doc.getPages().map((page) => {
    const root = page.node.lookup(PDFName.of('Contents'));
    const streams = root instanceof PDFArray ? root.asArray() : root ? [root] : [];
    return streams.map((object) => {
      const stream = object instanceof PDFRef ? doc.context.lookup(object) : object;
      return Array.from(decodePDFRawStream(stream as PDFRawStream).decode());
    });
  });
let fixtures: Record<PdfFixtureName, Uint8Array>;
const nativeFetch = globalThis.fetch;
beforeAll(async () => {
  globalThis.fetch = async (url, options) =>
    String(url).startsWith('file:')
      ? new Response(await readFile(new URL(String(url))), {
          headers: { 'Content-Type': 'application/wasm' },
        })
      : nativeFetch(url, options);
  fixtures = await pdfCompressionFixtures(jpegAdapter);
}, 60000);
afterAll(() => {
  globalThis.fetch = nativeFetch;
});

describe('actual PDF compression operations', () => {
  it.each([
    'image-heavy',
    'scan',
    'text-heavy',
    'large-image',
    'already-jpeg',
    'metadata',
  ] as const)(
    'applies all three profiles and retains decoded page content: %s',
    async (kind) => {
      const source = await PDFDocument.load(fixtures[kind], { updateMetadata: false });
      const outputSizes: number[] = [];
      for (const intensity of ['gentle', 'balanced', 'heavy'] as const) {
        const result = await rewritePdf(arrayBuffer(fixtures[kind]), policy(intensity), limits);
        expect(result.pdfDiagnostics?.validation).toBe('passed');
        expect(result.pdfDiagnostics?.failure).toBe('none');
        expect(result.buffer.byteLength).toBeLessThanOrEqual(fixtures[kind].length);
        const output = await PDFDocument.load(result.buffer, { updateMetadata: false });
        expect(contents(output)).toEqual(contents(source));
        expect(output.getPages().map((page) => page.getSize())).toEqual(
          source.getPages().map((page) => page.getSize())
        );
        const report = result.pdfDiagnostics!;
        expect(report.targetDpi).toBe(policy(intensity).targetDpi);
        expect(report.jpegQuality).toBe(
          intensity === 'gentle' ? null : policy(intensity).image.quality
        );
        if (intensity === 'gentle') {
          expect(report.imagesAttempted).toBe(0);
          const before = images(source),
            after = images(output);
          expect(after).toHaveLength(before.length);
          for (let i = 0; i < before.length; i++)
            expect(Array.from(imagePayload(after[i]![1] as PDFRawStream))).toEqual(
              Array.from(imagePayload(before[i]![1] as PDFRawStream))
            );
        }
        if (['image-heavy', 'scan', 'large-image'].includes(kind) && intensity !== 'gentle') {
          expect(report.imagesAttempted).toBeGreaterThan(0);
          expect(report.imagesOptimized).toBeGreaterThan(0);
          expect(report.imagesDownsampled).toBeGreaterThan(0);
        }
        if (kind === 'already-jpeg' && intensity !== 'gentle')
          expect(report.imageSkips.not_smaller).toBe(1);
        outputSizes.push(result.buffer.byteLength);
      }
      if (['image-heavy', 'scan', 'large-image'].includes(kind)) {
        expect(outputSizes[1]).toBeLessThan(outputSizes[0]!);
        expect(outputSizes[2]).toBeLessThan(outputSizes[1]!);
      }
    },
    60000
  );

  it('keeps unsupported metadata independent of image compression and preserves its decoded bytes', async () => {
    const doc = await PDFDocument.load(fixtures['image-heavy'], { updateMetadata: false });
    doc.catalog.set(
      PDFName.of('Metadata'),
      doc.context.register(doc.context.stream('Retained unknown XML', { Subtype: 'XML' }))
    );
    const bytes = await doc.save({ useObjectStreams: false });
    const result = await rewritePdf(
      arrayBuffer(bytes),
      { ...policy('heavy'), pdfMetadata: 'remove-xmp' },
      limits
    );
    expect(result.disposition).toBe('transformed');
    expect(result.pdfDiagnostics?.metadata).toBe('skipped');
    expect(result.pdfDiagnostics?.metadataPreserved).toBe(1);
    expect(result.pdfDiagnostics?.imagesOptimized).toBe(1);
    const output = await PDFDocument.load(result.buffer);
    expect(
      new TextDecoder().decode(
        decodePDFRawStream(output.catalog.lookup(PDFName.of('Metadata')) as PDFRawStream).decode()
      )
    ).toBe('Retained unknown XML');
  }, 60000);

  it('passes distinct Q75/Q55 to the real encoder and respects separate image memory admission', async () => {
    for (const intensity of ['balanced', 'heavy'] as const) {
      const doc = await PDFDocument.load(fixtures['large-image']);
      const encode = vi.fn(jpegAdapter.encode);
      const report = createPdfReport(policy(intensity));
      await optimizePdfImages(doc, policy(intensity), limits, budget(), report, async () => ({
        ...jpegAdapter,
        encode,
      }));
      expect(encode).toHaveBeenCalledOnce();
      expect(encode.mock.calls[0]![1].quality).toBe(intensity === 'balanced' ? 75 : 55);
      expect(encode.mock.calls[0]![0].width).toBe(intensity === 'balanced' ? 150 : 96);
    }
    const doc = await PDFDocument.load(fixtures['large-image']),
      load = vi.fn(async () => jpegAdapter),
      report = createPdfReport(policy('heavy'));
    await optimizePdfImages(
      doc,
      policy('heavy'),
      { ...limits, pdfImageWorkingBytes: 1024 },
      budget(),
      report,
      load
    );
    expect(report.imageSkips.memory).toBe(1);
    expect(load).not.toHaveBeenCalled();
  }, 60000);

  it('retains a masked image and permits other lossless compression', async () => {
    const doc = await PDFDocument.load(fixtures['image-heavy']);
    const stream = images(doc)[0]![1] as PDFRawStream;
    stream.dict.set(
      PDFName.of('SMask'),
      doc.context.register(
        doc.context.flateStream(new Uint8Array(1000 * 750).fill(255), {
          Type: 'XObject',
          Subtype: 'Image',
          ColorSpace: 'DeviceGray',
          Width: 1000,
          Height: 750,
          BitsPerComponent: 8,
        })
      )
    );
    const report = createPdfReport(policy('heavy')),
      load = vi.fn(async () => jpegAdapter);
    await optimizePdfImages(doc, policy('heavy'), limits, budget(), report, load);
    expect(report.imageSkips.mask).toBe(2);
    expect(load).not.toHaveBeenCalled();
    // Both the masked image and the opacity stream remain outside lossy encoding.
    expect(stream.dict.has(PDFName.of('SMask'))).toBe(true);
  }, 60000);

  it('normalizes missing references to PDF null without deleting live resources', async () => {
    const doc = await PDFDocument.load(fixtures['text-heavy']);
    const missing = PDFRef.of(999999);
    doc.catalog.set(PDFName.of('Optional'), missing);
    doc.catalog.set(PDFName.of('OptionalArray'), doc.context.obj([missing]));
    const objectCount = doc.context.enumerateIndirectObjects().length;
    expect(await normalizePdfNullReferences(doc.context, budget())).toBe(2);
    expect(doc.catalog.get(PDFName.of('Optional'), true)).toBe(PDFNull);
    expect(doc.context.enumerateIndirectObjects()).toHaveLength(objectCount);
  });

  it('does not mistake printed protection marker strings for encryption or a signature', async () => {
    const doc = await PDFDocument.load(fixtures['text-heavy']);
    doc
      .getPage(0)
      .node.addContentStream(
        doc.context.register(doc.context.stream('% /Encrypt /ByteRange /Type /Sig\n'))
      );
    const result = await rewritePdf(
      arrayBuffer(await doc.save({ useObjectStreams: false })),
      policy('gentle'),
      limits
    );
    expect(result.disposition).toBe('transformed');
    expect(result.pdfDiagnostics?.validation).toBe('passed');
  });

  it('retains the original image after codec failure while completing independent structural work', async () => {
    const doc = await PDFDocument.load(fixtures['image-heavy']);
    const stream = images(doc)[0]![1] as PDFRawStream;
    const before = stream.getContents().slice(),
      report = createPdfReport(policy('heavy'));
    await optimizePdfImages(doc, policy('heavy'), limits, budget(), report, async () => ({
      decode: jpegAdapter.decode,
      encode: async () => {
        throw new Error('simulated encoder failure');
      },
    }));
    expect(report.imagesAttempted).toBe(1);
    expect(report.imageSkips.codec).toBe(1);
    expect(stream.getContents()).toEqual(before);
  });

  it('cancels after encoding before replacing an image or delivering a candidate', async () => {
    const doc = await PDFDocument.load(fixtures['image-heavy']);
    const [ref, stream] = images(doc)[0]!;
    let cancelled = false;
    const report = createPdfReport(policy('heavy'));
    await expect(
      optimizePdfImages(
        doc,
        policy('heavy'),
        limits,
        {
          ...budget(),
          checkpoint: async () => {
            if (cancelled) throw new Error('Cancelled');
          },
        },
        report,
        async () => ({
          decode: jpegAdapter.decode,
          encode: async (image, options) => {
            const encoded = await jpegAdapter.encode(image, options);
            cancelled = true;
            return encoded;
          },
        })
      )
    ).rejects.toThrow('Cancelled');
    expect(doc.context.lookup(ref)).toBe(stream);
    expect(report.imagesOptimized).toBe(0);
  });

  it('ignores operator-looking text and computes nested shared placement from the largest use', async () => {
    expect(
      [
        ...pdfContentTokens(
          '(q 900 0 0 900 0 0 cm /False Do) [ (Q) ] % Do\nq 72 0 0 72 0 0 cm /Image#31 Do Q'
        ),
      ]
        .filter((token) => token.kind === 'op')
        .map((token) => token.value)
    ).toEqual(['q', 'cm', 'Do', 'Q']);
    expect(multiplyPdfMatrices([2, 0, 0, 3, 10, 20], [4, 0, 0, 5, 6, 7])).toEqual([
      8, 0, 0, 15, 22, 41,
    ]);
    const doc = await PDFDocument.load(fixtures['large-image']);
    const [ref] = images(doc)[0]!;
    const page = doc.getPage(0),
      resources = page.node.Resources()!;
    const objects = resources.lookup(PDFName.of('XObject'), PDFDict);
    const name = objects.entries().find(([, value]) => value === ref)![0];
    const form = doc.context.register(
      doc.context.flateStream(`q 2 0 0 2 0 0 cm ${name.toString()} Do Q`, {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 1, 1],
        Matrix: [1, 0, 0, 1, 0, 0],
        Resources: resources,
      })
    );
    const formName = page.node.newXObject('Nested', form);
    page.node.addContentStream(
      doc.context.register(doc.context.stream(`q 100 0 0 100 0 0 cm ${formName.toString()} Do Q`))
    );
    const loaded = await PDFDocument.load(await doc.save({ updateFieldAppearances: false }));
    const placements = await analyzePdfPlacements(loaded, budget());
    expect(placements.get(ref)).toEqual({ widthPoints: 200, heightPoints: 200 });
  });
});
