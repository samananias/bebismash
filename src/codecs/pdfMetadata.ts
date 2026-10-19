import { PDFDict, PDFName, PDFRawStream } from 'pdf-lib';
import type { PDFDocument } from 'pdf-lib';
import { Unzlib } from 'fflate';
import { PdfGraphRefusal, trailerRoots, walkPdfGraph } from './pdfGraph';
import type { GraphBudget } from './pdfGraph';

const metadataKey = PDFName.of('Metadata');

/** Inspect XMP only for refusal, never to decide whether arbitrary XML is disposable.
 * Unsupported filters, decode parameters, encodings and oversized packets are refused.
 */
function checkConformance(stream: PDFRawStream): void {
  let bytes = stream.getContents();
  const cap = 2 * 1024 * 1024;
  const filter = stream.dict.lookup(PDFName.of('Filter'));
  if (stream.dict.has(PDFName.of('DecodeParms')))
    throw new PdfGraphRefusal('XMP decode parameters');
  if (filter) {
    if (filter !== PDFName.of('FlateDecode')) throw new PdfGraphRefusal('XMP filter');
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
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new PdfGraphRefusal('XMP entity declarations');
  text = text.replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_match, code: string) => {
    const value = code[0]?.toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
    if (!Number.isSafeInteger(value) || value > 0x10ffff)
      throw new PdfGraphRefusal('XMP character reference');
    return String.fromCodePoint(value);
  });
  if (/&(?!(?:amp|lt|gt|quot|apos);)/.test(text)) throw new PdfGraphRefusal('XMP entity reference');
  // UTF-16 and unusual encodings are outside this increment. Namespace URIs catch
  // arbitrary prefix aliases; broad matches deliberately prefer original fallback.
  if (text.includes('\0') || /pdfa|pdfx|pdf\/ns\/id|GTS_PDF|pdf\/x/i.test(text))
    throw new PdfGraphRefusal('Conformance-sensitive metadata');
}

/** Plan detachment, prove complete reachability, then reclaim unreachable objects.
 * Only a Metadata association to a Type Metadata / Subtype XML stream is supported.
 * Shared streams referenced elsewhere remain alive. Info and all unknown entries stay.
 */
export async function removePdfMetadata(doc: PDFDocument, budget: GraphBudget): Promise<number> {
  const context = doc.context;
  const associations: PDFDict[] = [];
  const checked = new Set<PDFRawStream>();
  await walkPdfGraph(context, trailerRoots(context), budget, (object) => {
    if (!(object instanceof PDFDict)) return;
    if (object.keys().some((key) => /GTS_PDF|PDFX|PDFA/i.test(key.decodeText())))
      throw new PdfGraphRefusal('Conformance-sensitive dictionary');
    if (!object.has(metadataKey)) return;
    const target = object.lookup(metadataKey);
    if (
      !(target instanceof PDFRawStream) ||
      target.dict.lookup(PDFName.of('Type')) !== PDFName.of('Metadata') ||
      target.dict.lookup(PDFName.of('Subtype')) !== PDFName.of('XML')
    )
      throw new PdfGraphRefusal('Ambiguous Metadata association');
    if (!checked.has(target)) {
      checkConformance(target);
      checked.add(target);
    }
    associations.push(object);
  });
  if (!associations.length) return 0;
  const reachable = await walkPdfGraph(context, trailerRoots(context), budget, undefined, true);
  await budget.checkpoint();
  for (const dict of associations) dict.delete(metadataKey);
  for (const [ref] of context.enumerateIndirectObjects()) {
    if (!reachable.has(ref)) context.delete(ref);
  }
  return associations.length;
}
