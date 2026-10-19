import { Unzlib, zlibSync } from 'fflate';
import { PDFArray, PDFName, PDFNull, PDFRawStream } from 'pdf-lib';
import type { PDFDocument } from 'pdf-lib';
import type { DocumentPolicy, PdfDiagnostics, ResourceLimits } from '../core/types';
import type { GraphBudget } from './pdfGraph';

export function streamFilters(stream: PDFRawStream): string[] {
  const filter = stream.dict.lookup(PDFName.of('Filter'));
  if (!filter || filter === PDFNull) return [];
  const values = filter instanceof PDFArray ? filter.asArray() : [filter];
  if (values.length > 4) throw new Error('Unsupported filter chain');
  const names = values.map((item) => stream.dict.context.lookup(item));
  if (names.some((item) => !(item instanceof PDFName))) throw new Error('Unsupported filters');
  return names.map((item) => item!.toString());
}

export function hasDecodeParameters(stream: PDFRawStream): boolean {
  const params = stream.dict.lookup(PDFName.of('DecodeParms'));
  if (params instanceof PDFArray && params.size() <= 4)
    return params.asArray().some((item) => stream.dict.context.lookup(item) !== PDFNull);
  return !!params && params !== PDFNull;
}

/** Streaming inflation bounds output before consolidation and yields between input slices. */
export async function inflatePdfBytes(
  bytes: Uint8Array,
  cap: number,
  budget: GraphBudget
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const inflate = new Unzlib((chunk) => {
    length += chunk.length;
    if (length > cap) throw new Error('Decoded stream limit');
    chunks.push(chunk);
  });
  for (let offset = 0; offset < bytes.length; offset += 1024) {
    await budget.checkpoint();
    inflate.push(bytes.subarray(offset, offset + 1024), offset + 1024 >= bytes.length);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export async function readPdfStream(
  stream: PDFRawStream,
  cap: number,
  budget: GraphBudget
): Promise<Uint8Array> {
  if (hasDecodeParameters(stream)) throw new Error('Unsupported predictor');
  const filters = streamFilters(stream);
  const bytes = stream.getContents();
  if (!filters.length) {
    if (bytes.length > cap) throw new Error('Decoded stream limit');
    return bytes;
  }
  if (filters.length !== 1 || filters[0] !== '/FlateDecode')
    throw new Error('Unsupported stream filter');
  return inflatePdfBytes(bytes, cap, budget);
}

/** Lossless payload compression is separate from object-stream packing. Never decode images here. */
export async function recompressPdfStreams(
  doc: PDFDocument,
  policy: DocumentPolicy,
  limits: ResourceLimits,
  budget: GraphBudget,
  report: PdfDiagnostics
): Promise<void> {
  let decodedTotal = 0;
  for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
    await budget.checkpoint();
    if (!(object instanceof PDFRawStream)) continue;
    const subtype = object.dict.lookup(PDFName.of('Subtype'));
    const type = object.dict.lookup(PDFName.of('Type'));
    if (type === PDFName.of('ObjStm') || type === PDFName.of('XRef')) continue;
    if (subtype === PDFName.of('Image')) {
      // A Flate envelope can compress JPEG application packets/entropy bytes without
      // changing one JPEG sample. This also supports CMYK, masks and monochrome JPEGs.
      let filters: string[];
      try {
        filters = streamFilters(object);
      } catch {
        continue;
      }
      if (
        hasDecodeParameters(object) ||
        filters.join(',') !== '/DCTDecode' ||
        object.getContents().length > Math.min(limits.maxEntryBytes, 8 * 1024 * 1024)
      )
        continue;
      const encoded = zlibSync(object.getContents(), { level: policy.deflateLevel });
      await budget.checkpoint();
      if (encoded.length + 48 < object.getContents().length) {
        const dict = object.dict.clone(doc.context);
        dict.set(PDFName.of('Filter'), doc.context.obj(['FlateDecode', 'DCTDecode']));
        dict.delete(PDFName.of('Length'));
        doc.context.assign(ref, PDFRawStream.of(dict, encoded));
        report.streamsRecompressed++;
        report.streamBytesSaved += object.getContents().length - encoded.length;
      }
      continue;
    }
    const cap = Math.min(
      8 * 1024 * 1024,
      limits.maxEntryBytes,
      limits.maxExpandedBytes - decodedTotal
    );
    if (cap <= 0) {
      report.streamSkips++;
      continue;
    }
    let decoded: Uint8Array;
    try {
      decoded = await readPdfStream(object, cap, budget);
    } catch {
      await budget.checkpoint();
      report.streamSkips++;
      continue;
    }
    decodedTotal += decoded.length;
    const encoded = zlibSync(decoded, { level: policy.deflateLevel });
    await budget.checkpoint();
    // Include Filter syntax overhead for streams previously stored without compression.
    if (encoded.length + 32 >= object.getContents().length) continue;
    const dict = object.dict.clone(doc.context);
    dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
    dict.delete(PDFName.of('DecodeParms'));
    dict.delete(PDFName.of('Length'));
    doc.context.assign(ref, PDFRawStream.of(dict, encoded));
    report.streamsRecompressed++;
    report.streamBytesSaved += object.getContents().length - encoded.length;
  }
}
