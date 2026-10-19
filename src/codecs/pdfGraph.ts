/** Worker-only graph operations. No deletion occurs until both traversals finish. */
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFString,
  PDFObjectParser,
} from 'pdf-lib';
import type { PDFContext, PDFObject } from 'pdf-lib';

export class PdfGraphRefusal extends Error {}

export interface GraphBudget {
  /** Inspection only: PDF null semantics are normalized before transformation/GC. */
  allowMissingReferences?: boolean;
  checkpoint: () => Promise<void>;
  maxNodes: number;
  maxEdges: number;
}

const metadataKey = PDFName.of('Metadata');
const primitive = (object: PDFObject) =>
  object instanceof PDFName ||
  object instanceof PDFNumber ||
  object instanceof PDFBool ||
  object instanceof PDFString ||
  object instanceof PDFHexString ||
  object === PDFNull;

/** Iterative DFS bounds pending edges as well as visited nodes. References must resolve. */
export async function walkPdfGraph(
  context: PDFContext,
  roots: PDFObject[],
  budget: GraphBudget,
  visit: (object: PDFObject) => void = () => {},
  skipMetadata: boolean | ReadonlySet<PDFDict> = false
): Promise<Set<PDFRef>> {
  const seen = new Set<PDFObject>();
  const references = new Set<PDFRef>();
  const stack = [...roots];
  let edges = stack.length;
  while (stack.length) {
    if (edges > budget.maxEdges || seen.size > budget.maxNodes)
      throw new PdfGraphRefusal('Graph budget exceeded');
    if (seen.size % 128 === 0) await budget.checkpoint();
    const object = stack.pop()!;
    if (seen.has(object)) continue;
    seen.add(object);
    visit(object);
    let children: PDFObject[] = [];
    if (object instanceof PDFRef) {
      references.add(object);
      const target = context.lookup(object);
      if (!target) {
        if (budget.allowMissingReferences) continue;
        throw new PdfGraphRefusal('Unresolved reference');
      }
      children = [target];
    } else if (object instanceof PDFRawStream) children = [object.dict];
    else if (object instanceof PDFDict) {
      children = object
        .entries()
        .filter(
          ([key]) =>
            key !== metadataKey ||
            !(
              skipMetadata === true ||
              (typeof skipMetadata !== 'boolean' && skipMetadata.has(object))
            )
        )
        .map(([, value]) => value);
    } else if (object instanceof PDFArray) children = object.asArray();
    else if (!primitive(object)) throw new PdfGraphRefusal('Unsupported graph object');
    edges += children.length;
    if (edges > budget.maxEdges) throw new PdfGraphRefusal('Reference budget exceeded');
    for (const child of children) stack.push(child);
  }
  await budget.checkpoint();
  return references;
}

/** ISO 32000-2 7.3.9: a nonexistent indirect object is null. Materialize that value
 * before allocating new object numbers, preserving semantics and avoiding accidental reuse.
 * Required catalog/page structure is still checked by parsing and page enumeration.
 */
export async function normalizePdfNullReferences(
  context: PDFContext,
  budget: GraphBudget
): Promise<number> {
  let count = 0;
  await walkPdfGraph(
    context,
    context.enumerateIndirectObjects().map(([, object]) => object),
    budget,
    (object) => {
      if (object instanceof PDFDict) {
        for (const [key, value] of object.entries()) {
          if (value instanceof PDFRef && !context.lookup(value)) {
            object.set(key, PDFNull);
            count++;
          }
        }
      } else if (object instanceof PDFArray) {
        for (let i = 0; i < object.size(); i++) {
          const value = object.get(i);
          if (value instanceof PDFRef && !context.lookup(value)) {
            object.set(i, PDFNull);
            count++;
          }
        }
      }
    }
  );
  return count;
}

export const trailerRoots = (context: PDFContext): PDFObject[] =>
  Object.values(context.trailerInfo).filter((value): value is PDFObject => value !== undefined);

/** pdf-lib retains only these trailer roots. Refuse custom trailer semantics before GC.
 * Raw token matches may conservatively refuse stream contents that resemble a trailer.
 */
export async function validatePdfTrailers(
  bytes: Uint8Array,
  context: PDFContext,
  budget: GraphBudget
): Promise<void> {
  const allowed = new Set(['Root', 'Info', 'Encrypt', 'ID', 'Size', 'Prev', 'XRefStm']);
  const xrefAllowed = new Set([
    ...allowed,
    'Type',
    'W',
    'Index',
    'Length',
    'Filter',
    'DecodeParms',
  ]);
  const check = (dict: PDFDict, keys: Set<string>) => {
    if (dict.keys().some((key) => !keys.has(key.decodeText())))
      throw new PdfGraphRefusal('Unsupported trailer root');
  };
  // Bound text allocation to 64 KiB per window, with overlap for a trailer dictionary.
  const decoder = new TextDecoder('latin1');
  let count = 0;
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    await budget.checkpoint();
    const text = decoder.decode(bytes.subarray(offset, offset + 65536));
    for (const match of text.matchAll(/\btrailer\s*(?=<<)/g)) {
      if (++count > 4096) throw new PdfGraphRefusal('Too many trailers');
      const start = offset + match.index! + match[0].length;
      const dict = PDFObjectParser.forBytes(
        bytes.subarray(start, start + 32768),
        context
      ).parseObject();
      if (!(dict instanceof PDFDict)) throw new PdfGraphRefusal('Invalid trailer');
      check(dict, allowed);
    }
  }
  for (const [, object] of context.enumerateIndirectObjects()) {
    if (
      object instanceof PDFRawStream &&
      object.dict.get(PDFName.of('Type')) === PDFName.of('XRef')
    )
      check(object.dict, xrefAllowed);
  }
}

/** Compare every retained object by stable reference, including raw stream bytes.
 * The writer may normalize stream Length. All other dictionaries/arrays must match.
 */
export async function validateRetainedObjects(
  before: PDFContext,
  after: PDFContext,
  references: Set<PDFRef>,
  budget: GraphBudget
): Promise<void> {
  const pairs: [PDFObject, PDFObject | undefined][] = [...references].map((ref) => [
    before.lookup(ref)!,
    after.lookup(ref),
  ]);
  for (const key of ['Root', 'Info', 'Encrypt', 'ID'] as const) {
    const root = before.trailerInfo[key];
    if (root) pairs.push([root, after.trailerInfo[key]]);
    else if (after.trailerInfo[key]) throw new PdfGraphRefusal('Trailer changed');
  }
  const seen = new Map<PDFObject, PDFObject>();
  let edges = pairs.length;
  while (pairs.length) {
    if (edges > budget.maxEdges || seen.size > budget.maxNodes)
      throw new PdfGraphRefusal('Validation budget exceeded');
    if (seen.size % 128 === 0) await budget.checkpoint();
    const [a, b] = pairs.pop()!;
    if (!b || a.constructor !== b.constructor) throw new PdfGraphRefusal('Object changed');
    if (seen.get(a) === b) continue;
    seen.set(a, b);
    if (a instanceof PDFRawStream && b instanceof PDFRawStream) {
      const left = a.getContents(),
        right = b.getContents();
      if (left.length !== right.length) throw new PdfGraphRefusal('Stream changed');
      for (let i = 0; i < left.length; i++) {
        if (i % 65536 === 0) await budget.checkpoint();
        if (left[i] !== right[i]) throw new PdfGraphRefusal('Stream changed');
      }
      pairs.push([a.dict, b.dict]);
      edges++;
    } else if (a instanceof PDFDict && b instanceof PDFDict) {
      const keys = a.keys();
      if (keys.length !== b.keys().length) throw new PdfGraphRefusal('Dictionary changed');
      for (const key of keys) {
        pairs.push([a.get(key, true)!, b.get(key, true)]);
        edges++;
      }
    } else if (a instanceof PDFArray && b instanceof PDFArray) {
      if (a.size() !== b.size()) throw new PdfGraphRefusal('Array changed');
      for (let i = 0; i < a.size(); i++) {
        pairs.push([a.get(i), b.get(i)]);
        edges++;
      }
    } else if (!(a instanceof PDFRef) && !primitive(a))
      throw new PdfGraphRefusal('Unsupported validation');
    else if (a.toString() !== b.toString()) throw new PdfGraphRefusal('Value changed');
  }
}
