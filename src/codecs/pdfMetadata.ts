import { PDFDict, PDFName, PDFRawStream } from 'pdf-lib';
import type { PDFDocument } from 'pdf-lib';
import { Unzlib } from 'fflate';
import { PdfGraphRefusal, trailerRoots, walkPdfGraph } from './pdfGraph';
import type { GraphBudget } from './pdfGraph';
import type { PdfDiagnostics } from '../core/types';
import { streamFilters, hasDecodeParameters } from './pdfStreams';

export class PdfConformanceRefusal extends Error {}

const metadataKey = PDFName.of('Metadata');
const conformanceDictionary = (dict: PDFDict) =>
  dict.has(PDFName.of('GTS_PDFXVersion')) ||
  dict.has(PDFName.of('GTS_PDFXConformance')) ||
  (dict.lookup(PDFName.of('S')) instanceof PDFName &&
    /^\/GTS_(?:PDFA\d*|PDFX)$/.test(dict.lookup(PDFName.of('S'))!.toString()));

/** Inspect XMP only for refusal, never to decide whether arbitrary XML is disposable.
 * Unsupported filters, decode parameters, encodings and oversized packets are refused.
 */
function checkConformance(stream: PDFRawStream): void {
  let bytes = stream.getContents();
  const cap = 2 * 1024 * 1024;
  const filters = streamFilters(stream);
  if (hasDecodeParameters(stream)) throw new PdfGraphRefusal('XMP decode parameters');
  if (filters.length) {
    if (filters.length !== 1 || filters[0] !== '/FlateDecode')
      throw new PdfGraphRefusal('XMP filter');
    const chunks: Uint8Array[] = [];
    let length = 0;
    const inflate = new Unzlib((chunk) => {
      length += chunk.length;
      if (length > cap) throw new PdfGraphRefusal('XMP expansion limit');
      chunks.push(chunk);
    });
    // Feed small chunks so an inflation bomb cannot allocate an entire decoded stream.
    for (let offset = 0; offset < bytes.length; offset += 1024)
      inflate.push(bytes.subarray(offset, offset + 1024), offset + 1024 >= bytes.length);
    bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
  }
  if (bytes.length > cap) throw new PdfGraphRefusal('XMP size limit');
  let text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new PdfConformanceRefusal('XMP entity declarations');
  text = text.replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_match, code: string) => {
    const value = code[0]?.toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
    if (!Number.isSafeInteger(value) || value > 0x10ffff)
      throw new PdfGraphRefusal('XMP character reference');
    return String.fromCodePoint(value);
  });
  if (/&(?!(?:amp|lt|gt|quot|apos);)/.test(text)) throw new PdfGraphRefusal('XMP entity reference');
  // PDF/A identification and PDF/X identification are distinct from Adobe's generic
  // pdfx/1.3 custom-property namespace. That namespace alone declares no conformance.
  if (
    text.includes('\0') ||
    /pdfa\/ns\/id|pdfaid\s*:|pdfx\/ns\/id|pdfxid\s*:|GTS_PDFX(?:Version|Conformance)|GTS_PDFA/i.test(
      text
    )
  )
    throw new PdfConformanceRefusal('Conformance-sensitive metadata');
}

/** Conformance checks are independent of opt-in metadata removal. An unreadable
 * document-level packet prevents excluding archival constraints; component packets stay opaque. */
export async function inspectPdfConformance(
  doc: PDFDocument,
  budget: GraphBudget
): Promise<boolean> {
  let known = true;
  const checked = new Map<PDFRawStream, boolean>();
  await walkPdfGraph(doc.context, trailerRoots(doc.context), budget, (object) => {
    if (!(object instanceof PDFDict)) return;
    if (conformanceDictionary(object))
      throw new PdfConformanceRefusal('Conformance-sensitive dictionary');
    if (!object.has(metadataKey)) return;
    const target = object.lookup(metadataKey);
    if (!(target instanceof PDFRawStream)) return;
    if (checked.has(target)) {
      if (object === doc.catalog && !checked.get(target)) known = false;
      return;
    }
    try {
      checkConformance(target);
      checked.set(target, true);
    } catch (error) {
      if (error instanceof PdfConformanceRefusal) throw error;
      checked.set(target, false);
      if (object === doc.catalog) known = false;
    }
  });
  return known;
}

/** Plan detachment, prove complete reachability, then reclaim unreachable objects.
 * Only a Metadata association to a Type Metadata / Subtype XML stream is supported.
 * Shared streams referenced elsewhere remain alive. Info and all unknown entries stay.
 */
export async function removePdfMetadata(
  doc: PDFDocument,
  budget: GraphBudget,
  report?: PdfDiagnostics
): Promise<number> {
  const context = doc.context;
  const associations: PDFDict[] = [];
  const checked = new Set<PDFRawStream>();
  await walkPdfGraph(context, trailerRoots(context), budget, (object) => {
    if (!(object instanceof PDFDict)) return;
    if (conformanceDictionary(object))
      throw new PdfConformanceRefusal('Conformance-sensitive dictionary');
    if (!object.has(metadataKey)) return;
    const target = object.lookup(metadataKey);
    if (
      !(target instanceof PDFRawStream) ||
      target.dict.lookup(PDFName.of('Type')) !== PDFName.of('Metadata') ||
      target.dict.lookup(PDFName.of('Subtype')) !== PDFName.of('XML')
    ) {
      if (report) report.metadataPreserved++;
      return;
    }
    if (!checked.has(target)) {
      try {
        checkConformance(target);
      } catch (error) {
        if (error instanceof PdfConformanceRefusal) throw error;
        if (report) report.metadataPreserved++;
        return;
      }
      checked.add(target);
    }
    associations.push(object);
  });
  if (!associations.length) return 0;
  const reachable = await walkPdfGraph(
    context,
    trailerRoots(context),
    budget,
    undefined,
    new Set(associations)
  );
  await budget.checkpoint();
  for (const dict of associations) dict.delete(metadataKey);
  for (const [ref] of context.enumerateIndirectObjects()) {
    if (!reachable.has(ref)) context.delete(ref);
  }
  return associations.length;
}
