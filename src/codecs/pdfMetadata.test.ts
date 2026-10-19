import { describe, expect, it, vi } from 'vitest';
import {
  PDFDocument,
  PDFName,
  PDFRef,
  PDFRawStream,
  PDFDict,
  PDFArray,
  PDFString,
  decodePDFRawStream,
} from 'pdf-lib';
import type { DocumentPolicy, ResourceLimits } from '../core/types';
import { syntheticPdf } from './testing/pdfFixture';
import { rewritePdf } from './pdf';
import { inspectPdfConformance, removePdfMetadata } from './pdfMetadata';
import { walkPdfGraph, trailerRoots, validateRetainedObjects } from './pdfGraph';

const limits: ResourceLimits = {
  maxInputBytes: 64 * 1024 * 1024,
  maxOutputBytes: 64 * 1024 * 1024,
  maxPixels: 24_000_000,
  maxExpandedBytes: 64 * 1024 * 1024,
  maxEntryBytes: 16 * 1024 * 1024,
  maxEntries: 1000,
  maxExpansionRatio: 100,
  maxWallTimeMs: 60_000,
};
const policy = (remove = false): DocumentPolicy => ({
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
  deflateLevel: 9,
  pdfMode: 'rewrite',
  targetDpi: null,
  ...(remove ? { pdfMetadata: 'remove-xmp' as const } : {}),
});
const budget = () => ({ checkpoint: async () => {}, maxNodes: 100_000, maxEdges: 400_000 });
const buffer = (bytes: Uint8Array) => bytes.slice().buffer as ArrayBuffer;

describe('explicit bounded PDF metadata cleanup', () => {
  it('keeps unreadable component metadata opaque but refuses unknown document conformance, including shared packets', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage();
    const packet = doc.context.register(
      doc.context.stream('opaque packet', { Type: 'Metadata', Subtype: 'XML', Filter: 'LZWDecode' })
    );
    page.node.set(PDFName.of('Metadata'), packet);
    expect(await inspectPdfConformance(doc, budget())).toBe(true);
    doc.catalog.set(PDFName.of('Metadata'), packet);
    expect(await inspectPdfConformance(doc, budget())).toBe(false);
  });

  it('accepts indirect Flate filters with explicitly null decode parameters', async () => {
    const source = await syntheticPdf();
    const doc = await PDFDocument.load(source.bytes);
    const packet = doc.context.flateStream('<x:xmpmeta>ordinary metadata</x:xmpmeta>', {
      Type: 'Metadata',
      Subtype: 'XML',
    });
    packet.dict.set(
      PDFName.of('Filter'),
      doc.context.obj([doc.context.register(PDFName.of('FlateDecode'))])
    );
    packet.dict.set(PDFName.of('DecodeParms'), doc.context.obj([null]));
    doc.catalog.set(PDFName.of('Metadata'), doc.context.register(packet));
    const result = await rewritePdf(
      buffer(await doc.save({ useObjectStreams: false })),
      policy(true),
      limits
    );
    expect(result.disposition).toBe('transformed');
    expect(result.pdfDiagnostics?.metadataRemoved).toBeGreaterThan(0);
    expect(result.pdfDiagnostics?.validation).toBe('passed');
  });

  it('retains XFA packet arrays and their stored payloads', async () => {
    const source = await syntheticPdf();
    const doc = await PDFDocument.load(source.bytes);
    const packet = doc.context.register(
      doc.context.stream('<template>Retained XFA data</template>')
    );
    const form = doc.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
    form.set(PDFName.of('XFA'), doc.context.obj([PDFString.of('template'), packet]));
    const bytes = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });
    const result = await rewritePdf(buffer(bytes), policy(true), limits);
    expect(result.disposition).toBe('transformed');
    const output = await PDFDocument.load(result.buffer);
    expect(
      output.catalog
        .lookup(PDFName.of('AcroForm'), PDFDict)
        .lookup(PDFName.of('XFA'), PDFArray)
        .get(1)
    ).toBe(packet);
    expect(
      new TextDecoder().decode((output.context.lookup(packet) as PDFRawStream).getContents())
    ).toBe('<template>Retained XFA data</template>');
  });

  it('cancels graph analysis before any association or object is deleted', async () => {
    const source = await syntheticPdf();
    const doc = await PDFDocument.load(source.bytes);
    const size = doc.context.enumerateIndirectObjects().length;
    let checks = 0;
    await expect(
      removePdfMetadata(doc, {
        ...budget(),
        checkpoint: async () => {
          if (++checks > 1) throw new Error('Cancelled');
        },
      })
    ).rejects.toThrow('Cancelled');
    expect(doc.catalog.has(PDFName.of('Metadata'))).toBe(true);
    expect(doc.context.enumerateIndirectObjects()).toHaveLength(size);
  });

  it.each(['http://www.aiim.org/pdf&#x61;/ns/id/', '<!DOCTYPE x [<!ENTITY archive "pdfa">]>'])(
    'refuses conformance obfuscation or entity declarations: %s',
    async (text) => {
      const source = await syntheticPdf();
      const doc = await PDFDocument.load(source.bytes);
      const stream = doc.context.register(
        doc.context.stream(text, { Type: 'Metadata', Subtype: 'XML' })
      );
      doc.catalog.set(PDFName.of('Metadata'), stream);
      await expect(removePdfMetadata(doc, budget())).rejects.toThrow();
      expect(doc.catalog.get(PDFName.of('Metadata'))).toBe(stream);
    }
  );

  it('refuses custom trailer roots that the parser cannot preserve', async () => {
    const source = await syntheticPdf();
    const marker = new TextEncoder().encode('/UnknownRoot 1 0 R\n');
    const text = new TextDecoder('latin1').decode(source.bytes);
    const at = text.lastIndexOf('trailer\n<<') + 'trailer\n<<'.length;
    expect(at).toBeGreaterThan(10);
    const bytes = new Uint8Array(source.bytes.length + marker.length);
    bytes.set(source.bytes.subarray(0, at));
    bytes.set(marker, at);
    bytes.set(source.bytes.subarray(at), at + marker.length);
    const result = await rewritePdf(buffer(bytes), policy(true), limits);
    expect(result.reason).toBe('unsupported_content');
    expect(new Uint8Array(result.buffer)).toEqual(bytes);
  });

  it('preserves an already compact candidate when cleanup produces no smaller output', async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.addPage([100, 100]);
    const bytes = await doc.save({ useObjectStreams: true });
    const result = await rewritePdf(buffer(bytes), policy(true), limits);
    expect(result.reason).toBe('no_smaller_candidate');
    expect(new Uint8Array(result.buffer)).toEqual(bytes);
  });

  it.each(['gentle', 'balanced', 'heavy'] as const)(
    'preserves XMP by default at %s intensity',
    async (intensity) => {
      const source = await syntheticPdf();
      const result = await rewritePdf(
        buffer(source.bytes),
        { ...policy(), deflateLevel: intensity === 'gentle' ? 6 : 9 },
        limits
      );
      const output = await PDFDocument.load(result.buffer);
      const stream = output.catalog.lookup(PDFName.of('Metadata')) as PDFRawStream;
      expect(new TextDecoder().decode(decodePDFRawStream(stream).decode()) === source.xmp).toBe(
        true
      );
      expect(result.pdfMetadataRemoved).toBeUndefined();
    }
  );

  it.each([false, true])(
    'removes only recognized associations, reclaims streams and retains document structure (compressed=%s)',
    async (compressed) => {
      const source = await syntheticPdf({ compressed });
      const result = await rewritePdf(buffer(source.bytes), policy(true), limits);
      expect(result.disposition).toBe('transformed');
      expect(result.pdfMetadataRemoved).toBe(2);
      const output = await PDFDocument.load(result.buffer);
      expect(output.catalog.has(PDFName.of('Metadata'))).toBe(false);
      expect(output.getPage(0).node.has(PDFName.of('Metadata'))).toBe(false);
      expect(output.context.lookup(source.metadataRef)).toBeUndefined();
      const xml = output.context.lookup(source.unrelated) as PDFRawStream;
      expect(new TextDecoder().decode(xml.getContents())).toBe('Retained unrelated XML');
      expect(output.getTitle()).toBe('Synthetic document title');
      expect(output.getForm().getTextField('synthetic-field').getText()).toBe(
        'Retained form value'
      );
      expect(output.getPage(0).getSize()).toEqual({ width: 320, height: 480 });
      expect(output.catalog.has(PDFName.of('Names'))).toBe(true);
      expect(output.getPage(0).node.has(PDFName.of('Annots'))).toBe(true);
    }
  );

  it('retains a shared metadata stream referenced by an unknown entry and handles cycles', async () => {
    const source = await syntheticPdf({ shared: true });
    const output = await PDFDocument.load(
      (await rewritePdf(buffer(source.bytes), policy(true), limits)).buffer
    );
    expect(output.context.lookup(source.metadataRef)).toBeInstanceOf(PDFRawStream);
    await expect(
      walkPdfGraph(output.context, trailerRoots(output.context), budget())
    ).resolves.toContain(source.cycleRef);
  });

  it.each([false, true])(
    'preserves conformance-sensitive XMP (compressed=%s)',
    async (compressed) => {
      const source = await syntheticPdf({ conformance: true, compressed });
      const result = await rewritePdf(buffer(source.bytes), policy(true), limits);
      expect(result.reason).toBe('conformance_document');
      expect(new Uint8Array(result.buffer)).toEqual(source.bytes);
    }
  );

  it('retains ambiguous metadata while cleaning independent recognized associations', async () => {
    const source = await syntheticPdf();
    const doc = await PDFDocument.load(source.bytes);
    const unknown = doc.context.register(
      doc.context.stream('Retained legacy XML', { Subtype: 'XML' })
    );
    doc.catalog.set(PDFName.of('Metadata'), unknown);
    expect(await removePdfMetadata(doc, budget())).toBe(1);
    expect(doc.catalog.get(PDFName.of('Metadata'))).toBe(unknown);
    expect(doc.getPage(0).node.has(PDFName.of('Metadata'))).toBe(false);
    expect(
      new TextDecoder().decode((doc.context.lookup(unknown) as PDFRawStream).getContents())
    ).toBe('Retained legacy XML');
    const result = await rewritePdf(
      buffer(await doc.save({ updateFieldAppearances: false })),
      policy(true),
      limits
    );
    expect(result.pdfDiagnostics?.metadata).toBe('skipped');
    expect(result.pdfDiagnostics?.metadataPreserved).toBe(1);
    expect(result.pdfDiagnostics?.failure).toBe('none');
  });

  it('does not confuse Adobe custom pdfx properties with a PDF/X identification claim', async () => {
    const source = await syntheticPdf();
    const doc = await PDFDocument.load(source.bytes);
    doc.catalog.set(
      PDFName.of('Metadata'),
      doc.context.register(
        doc.context.stream(
          '<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:pdfx="http://ns.adobe.com/pdfx/1.3/"><pdfx:Custom>Retain</pdfx:Custom></x:xmpmeta>',
          { Type: 'Metadata', Subtype: 'XML' }
        )
      )
    );
    const result = await rewritePdf(
      buffer(await doc.save({ useObjectStreams: false })),
      policy(),
      limits
    );
    expect(result.disposition).toBe('transformed');
    expect(result.pdfDiagnostics?.validation).toBe('passed');
    expect(result.pdfDiagnostics?.failure).toBe('none');
  });

  it.each(['missing-ref', 'pdfx'])('refuses %s before mutation', async (kind) => {
    const source = await syntheticPdf();
    const doc = await PDFDocument.load(source.bytes);
    if (kind === 'wrong-type')
      doc.catalog.set(PDFName.of('Metadata'), doc.context.obj({ Subtype: 'XML' }));
    if (kind === 'missing-ref') doc.catalog.set(PDFName.of('Missing'), PDFRef.of(999999));
    if (kind === 'pdfx') doc.catalog.set(PDFName.of('GTS_PDFXVersion'), doc.context.obj('PDF/X-4'));
    await expect(removePdfMetadata(doc, budget())).rejects.toThrow();
    expect(doc.catalog.has(PDFName.of('Metadata'))).toBe(true);
    expect(doc.context.lookup(source.metadataRef)).toBeDefined();
  });

  it('bounds deep/wide graphs, deadlines and cancellation without deleting objects', async () => {
    const source = await syntheticPdf();
    const doc = await PDFDocument.load(source.bytes);
    let nested = doc.context.obj({});
    doc.catalog.set(PDFName.of('Deep'), nested);
    for (let i = 0; i < 12000; i++) {
      const next = doc.context.obj({});
      nested.set(PDFName.of('Next'), next);
      nested = next;
    }
    await expect(
      walkPdfGraph(doc.context, trailerRoots(doc.context), budget())
    ).resolves.toBeDefined();
    await expect(removePdfMetadata(doc, { ...budget(), maxNodes: 10 })).rejects.toThrow('budget');
    await expect(removePdfMetadata(doc, { ...budget(), maxEdges: 10 })).rejects.toThrow('budget');
    expect(doc.catalog.has(PDFName.of('Metadata'))).toBe(true);
    const expired = await rewritePdf(buffer(source.bytes), policy(true), {
      ...limits,
      maxWallTimeMs: 0,
    });
    expect(expired.disposition).toBe('original');
    let calls = 0;
    await expect(
      rewritePdf(buffer(source.bytes), policy(true), limits, () => ++calls > 5)
    ).rejects.toThrow('Cancelled');
  });

  it('retains original for output caps and candidates that fail reopening validation', async () => {
    const source = await syntheticPdf();
    const capped = await rewritePdf(buffer(source.bytes), policy(true), {
      ...limits,
      maxOutputBytes: 10,
    });
    expect(capped.reason).toBe('validation_failed');
    expect(new Uint8Array(capped.buffer)).toEqual(source.bytes);
    const load = PDFDocument.load.bind(PDFDocument);
    const spy = vi
      .spyOn(PDFDocument, 'load')
      .mockImplementationOnce(load)
      .mockRejectedValueOnce(new Error('candidate failure'));
    try {
      const result = await rewritePdf(buffer(source.bytes), policy(true), limits);
      expect(result.reason).toBe('validation_failed');
      expect(new Uint8Array(result.buffer)).toEqual(source.bytes);
    } finally {
      spy.mockRestore();
    }
  });

  it('detects changed stream payloads and dictionary values on reopening', async () => {
    const source = await syntheticPdf();
    const before = await PDFDocument.load(source.bytes);
    const after = await PDFDocument.load(source.bytes);
    const references = await walkPdfGraph(before.context, trailerRoots(before.context), budget());
    (after.context.lookup(source.unrelated) as PDFRawStream).getContents()[0] = 0;
    await expect(
      validateRetainedObjects(before.context, after.context, references, budget())
    ).rejects.toThrow('Stream changed');
  });

  it('validates each use of a shared reference even when its original object remains', async () => {
    const source = await syntheticPdf();
    const before = await PDFDocument.load(source.bytes);
    const after = await PDFDocument.load(source.bytes);
    const references = await walkPdfGraph(before.context, trailerRoots(before.context), budget());
    after.catalog.set(
      PDFName.of('UnrelatedXml'),
      after.context.register(after.context.stream('replacement'))
    );
    await expect(
      validateRetainedObjects(before.context, after.context, references, budget())
    ).rejects.toThrow('Value changed');
  });
});
