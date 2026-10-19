import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef } from 'pdf-lib';
import type { PDFDocument, PDFObject } from 'pdf-lib';
import type { GraphBudget } from './pdfGraph';
import { walkPdfGraph, trailerRoots } from './pdfGraph';
import { readPdfStream } from './pdfStreams';

type Matrix = [number, number, number, number, number, number];
export interface ImagePlacement {
  widthPoints: number;
  heightPoints: number;
}
const identity: Matrix = [1, 0, 0, 1, 0, 0];
export function multiplyPdfMatrices(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

/** Lexical scanner skips PDF strings, comments, arrays and dictionaries. It never
 * interprets text as drawing operators. Inline image data makes placement uncertain.
 */
export function* pdfContentTokens(
  text: string
): Generator<{ kind: 'name' | 'number' | 'op' | 'other'; value: string }> {
  let index = 0;
  const delimiter = (char: string | undefined) =>
    char === undefined || /[\s\0()[\]<>/%{}]/.test(char);
  const literal = () => {
    let depth = 1;
    index++;
    while (index < text.length && depth) {
      const char = text[index++]!;
      if (char === '\\') index++;
      else if (char === '(') depth++;
      else if (char === ')') depth--;
      if (depth > 128) throw new Error('String nesting');
    }
    if (depth) throw new Error('Unterminated string');
  };
  while (index < text.length) {
    const char = text[index]!;
    if (/[\s\0]/.test(char)) {
      index++;
      continue;
    }
    if (char === '%') {
      while (index < text.length && !/[\r\n]/.test(text[index]!)) index++;
      continue;
    }
    if (char === '(') {
      literal();
      yield { kind: 'other', value: '' };
      continue;
    }
    if (char === '[' || text.slice(index, index + 2) === '<<') {
      const closers: string[] = [];
      do {
        if (text[index] === '(') {
          literal();
          continue;
        }
        if (text[index] === '%') {
          while (index < text.length && !/[\r\n]/.test(text[index]!)) index++;
          continue;
        }
        if (text[index] === '[') {
          closers.push(']');
          index++;
        } else if (text.slice(index, index + 2) === '<<') {
          closers.push('>>');
          index += 2;
        } else if (text[index] === '<') {
          const end = text.indexOf('>', index + 1);
          if (end < 0) throw new Error('Hex string');
          index = end + 1;
        } else if (text.slice(index, index + closers.at(-1)!.length) === closers.at(-1)) {
          index += closers.pop()!.length;
        } else index++;
        if (closers.length > 128 || (index >= text.length && closers.length))
          throw new Error('Composite nesting');
      } while (closers.length);
      yield { kind: 'other', value: '' };
      continue;
    }
    if (char === '<') {
      const end = text.indexOf('>', index + 1);
      if (end < 0) throw new Error('Hex string');
      index = end + 1;
      yield { kind: 'other', value: '' };
      continue;
    }
    if (char === '/') {
      const start = ++index;
      while (!delimiter(text[index])) index++;
      const value = text
        .slice(start, index)
        .replace(/#([a-f0-9]{2})/gi, (_match, hex: string) =>
          String.fromCharCode(parseInt(hex, 16))
        );
      yield { kind: 'name', value };
      continue;
    }
    const start = index;
    while (!delimiter(text[index])) index++;
    if (start === index) throw new Error('Unexpected content delimiter');
    const value = text.slice(start, index);
    yield { kind: /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value) ? 'number' : 'op', value };
  }
}

/** All page uses, nested Form matrices, shared images and page UserUnit contribute
 * the maximum physical placement. Unknown uses disable resizing, never quality-only encoding.
 */
export async function analyzePdfPlacements(
  doc: PDFDocument,
  budget: GraphBudget
): Promise<Map<PDFRef, ImagePlacement>> {
  const placements = new Map<PDFRef, ImagePlacement>();
  const knownOwners = new Set<PDFDict>(),
    knownXObjects = new Set<PDFDict>();
  let tokens = 0,
    decodedTotal = 0,
    forms = 0;
  const resolve = (object: PDFObject | undefined) =>
    object instanceof PDFRef ? doc.context.lookup(object) : object;
  const read = async (stream: PDFRawStream) => {
    const bytes = await readPdfStream(
      stream,
      Math.min(8 * 1024 * 1024, 64 * 1024 * 1024 - decodedTotal),
      budget
    );
    decodedTotal += bytes.length;
    return new TextDecoder('latin1').decode(bytes);
  };
  const resourcesFor = (dict: PDFDict, inherited?: PDFDict) => {
    const resources = resolve(dict.get(PDFName.of('Resources'))) ?? inherited;
    if (!(resources instanceof PDFDict)) throw new Error('Unknown resources');
    knownOwners.add(dict);
    const xobjects = resources.lookup(PDFName.of('XObject'));
    if (xobjects instanceof PDFDict) knownXObjects.add(xobjects);
    return resources;
  };
  try {
    for (const page of doc.getPages()) {
      const unitValue = page.node.lookup(PDFName.of('UserUnit'));
      const unit = unitValue instanceof PDFNumber ? unitValue.asNumber() : 1;
      if (!Number.isFinite(unit) || unit <= 0 || unit > 75000) throw new Error('Page unit');
      const resources = page.node.Resources();
      if (!resources) continue;
      knownOwners.add(page.node);
      const xobjects = resources.lookup(PDFName.of('XObject'));
      if (xobjects instanceof PDFDict) knownXObjects.add(xobjects);
      const contents = resolve(page.node.get(PDFName.of('Contents')));
      const parts = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
      let text = '';
      for (const part of parts) {
        const stream = resolve(part);
        if (!(stream instanceof PDFRawStream)) throw new Error('Content stream');
        text += (await read(stream)) + '\n';
        if (text.length > 8 * 1024 * 1024) throw new Error('Page content limit');
      }
      const tasks: {
        text: string;
        resources: PDFDict;
        matrix: Matrix;
        ancestors: Set<PDFRawStream>;
      }[] = [{ text, resources, matrix: [unit, 0, 0, unit, 0, 0], ancestors: new Set() }];
      while (tasks.length) {
        const task = tasks.pop()!;
        const matrices: Matrix[] = [];
        let matrix = task.matrix;
        let operands: { kind: string; value: string }[] = [];
        for (const token of pdfContentTokens(task.text)) {
          if (++tokens > 4_000_000) throw new Error('Content token limit');
          if (tokens % 512 === 0) await budget.checkpoint();
          if (token.kind !== 'op') {
            operands.push(token);
            if (operands.length > 128) throw new Error('Operand limit');
            continue;
          }
          if (token.value === 'BI') throw new Error('Inline image placement');
          if (token.value === 'q') {
            matrices.push(matrix);
            if (matrices.length > 256) throw new Error('Graphics stack limit');
          }
          if (token.value === 'Q') {
            const previous = matrices.pop();
            if (!previous) throw new Error('Graphics stack');
            matrix = previous;
          }
          if (token.value === 'cm') {
            if (operands.length !== 6 || operands.some((item) => item.kind !== 'number'))
              throw new Error('Matrix operands');
            matrix = multiplyPdfMatrices(
              matrix,
              operands.map((item) => Number(item.value)) as Matrix
            );
            if (matrix.some((value) => !Number.isFinite(value) || Math.abs(value) > 1e10))
              throw new Error('Matrix limit');
          }
          if (token.value === 'Do') {
            if (operands.length !== 1 || operands[0]!.kind !== 'name')
              throw new Error('XObject operand');
            const objects = task.resources.lookup(PDFName.of('XObject'));
            if (!(objects instanceof PDFDict)) throw new Error('XObject resources');
            const ref = objects.get(PDFName.of(operands[0]!.value));
            const object = resolve(ref);
            if (!(object instanceof PDFRawStream)) throw new Error('XObject target');
            if (object.dict.lookup(PDFName.of('Subtype')) === PDFName.of('Image')) {
              if (!(ref instanceof PDFRef)) throw new Error('Direct image');
              const previous = placements.get(ref);
              const widthPoints = Math.hypot(matrix[0], matrix[1]),
                heightPoints = Math.hypot(matrix[2], matrix[3]);
              placements.set(ref, {
                widthPoints: Math.max(previous?.widthPoints ?? 0, widthPoints),
                heightPoints: Math.max(previous?.heightPoints ?? 0, heightPoints),
              });
            } else if (object.dict.lookup(PDFName.of('Subtype')) === PDFName.of('Form')) {
              if (++forms > 4096 || task.ancestors.has(object) || task.ancestors.size > 64)
                throw new Error('Form traversal limit');
              const formMatrix = object.dict.lookup(PDFName.of('Matrix'));
              let transform = identity;
              if (formMatrix) {
                if (!(formMatrix instanceof PDFArray) || formMatrix.size() !== 6)
                  throw new Error('Form matrix');
                transform = formMatrix.asArray().map((value) => {
                  const number = resolve(value);
                  if (!(number instanceof PDFNumber)) throw new Error('Form matrix value');
                  return number.asNumber();
                }) as Matrix;
              }
              const ancestors = new Set(task.ancestors);
              ancestors.add(object);
              tasks.push({
                text: await read(object),
                resources: resourcesFor(object.dict, task.resources),
                matrix: multiplyPdfMatrices(matrix, transform),
                ancestors,
              });
            } else throw new Error('Unsupported XObject');
          }
          operands = [];
        }
        if (matrices.length) throw new Error('Unbalanced graphics stack');
      }
    }
    // Images reachable from appearances, patterns, Type3 fonts or unknown resource owners
    // may have additional physical uses. Quality-only changes remain safe at original size.
    const unsafe = new Set<PDFRef>();
    const unsafeResourcesSeen = new Set<PDFDict>();
    let resourceEdges = 0;
    const markResources = (resource: PDFDict) => {
      const stack = [resource],
        seen = unsafeResourcesSeen;
      while (stack.length) {
        const dict = stack.pop()!;
        if (seen.has(dict)) continue;
        seen.add(dict);
        if (seen.size > 100_000) throw new Error('Resource graph limit');
        const objects = dict.lookup(PDFName.of('XObject'));
        if (!(objects instanceof PDFDict)) continue;
        for (const [, ref] of objects.entries()) {
          if (++resourceEdges > budget.maxEdges) throw new Error('Resource graph limit');
          const object = resolve(ref);
          if (
            object instanceof PDFRawStream &&
            object.dict.lookup(PDFName.of('Subtype')) === PDFName.of('Image') &&
            ref instanceof PDFRef
          )
            unsafe.add(ref);
          else if (object instanceof PDFRawStream) {
            const nested = object.dict.lookup(PDFName.of('Resources'));
            if (nested instanceof PDFDict) stack.push(nested);
          }
        }
      }
    };
    await walkPdfGraph(doc.context, trailerRoots(doc.context), budget, (object) => {
      const dict = object instanceof PDFRawStream ? object.dict : object;
      if (dict instanceof PDFDict) {
        const resources = dict.lookup(PDFName.of('Resources'));
        if (
          resources instanceof PDFDict &&
          !knownOwners.has(dict) &&
          dict.lookup(PDFName.of('Type')) !== PDFName.of('Pages')
        )
          markResources(resources);
        for (const [, value] of dict.entries()) {
          const target = resolve(value);
          if (
            value instanceof PDFRef &&
            target instanceof PDFRawStream &&
            target.dict.lookup(PDFName.of('Subtype')) === PDFName.of('Image') &&
            !knownXObjects.has(dict)
          )
            unsafe.add(value);
        }
      } else if (object instanceof PDFArray) {
        for (const value of object.asArray()) {
          const target = resolve(value);
          if (
            value instanceof PDFRef &&
            target instanceof PDFRawStream &&
            target.dict.lookup(PDFName.of('Subtype')) === PDFName.of('Image')
          )
            unsafe.add(value);
        }
      }
    });
    for (const ref of unsafe) placements.delete(ref);
    return placements;
  } catch {
    await budget.checkpoint();
    return new Map();
  }
}
