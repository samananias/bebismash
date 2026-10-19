import {
  PDFDocument,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
} from 'pdf-lib';
import type { PdfImageEngine } from '../pdfImages';
import type { ImagePolicy } from '../../core/types';
import { syntheticPdf } from './pdfFixture';

export type PdfFixtureName =
  'image-heavy' | 'scan' | 'text-heavy' | 'large-image' | 'already-jpeg' | 'metadata';

function pixels(width: number, height: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  let seed = 39;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      const offset = (y * width + x) * 4,
        noise = (seed >>> 0) % 40;
      data[offset] = (x / width) * 180 + noise;
      data[offset + 1] = (y / height) * 180 + noise;
      data[offset + 2] = ((x + y) % 80 < 40 ? 180 : 80) + noise;
      data[offset + 3] = 255;
    }
  return data;
}

/** Six deterministic synthetic PDFs. No private inputs or pre-generated derivatives. */
export async function pdfCompressionFixtures(
  engine: PdfImageEngine
): Promise<Record<PdfFixtureName, Uint8Array>> {
  const policy: ImagePolicy = {
    kind: 'image',
    quality: 95,
    lossless: false,
    maxEdge: null,
    quantizeColors: null,
    oxipngLevel: 3,
    allowFormatChange: false,
  };
  const output = {} as Record<PdfFixtureName, Uint8Array>;
  for (const kind of ['image-heavy', 'large-image', 'already-jpeg'] as const) {
    const width = kind === 'large-image' ? 1600 : kind === 'already-jpeg' ? 480 : 1000,
      height = Math.round(width * 0.75);
    const jpeg = await engine.encode(
      { width, height, data: pixels(width, height) },
      { ...policy, quality: kind === 'already-jpeg' ? 30 : 95 }
    );
    const doc = await PDFDocument.create({ updateMetadata: false }),
      page = doc.addPage([480, 640]);
    const image = await doc.embedJpg(jpeg);
    page.drawImage(image, {
      x: 30,
      y: 200,
      width: kind === 'large-image' ? 72 : kind === 'already-jpeg' ? 400 : 180,
      height: (kind === 'large-image' ? 72 : kind === 'already-jpeg' ? 400 : 180) * 0.75,
    });
    page.drawText('Searchable fixture ' + kind, { x: 30, y: 600, size: 12 });
    output[kind] = await doc.save({ useObjectStreams: false });
  }
  {
    const doc = await PDFDocument.create({ updateMetadata: false }),
      page = doc.addPage([480, 640]);
    const width = 900,
      height = 1200,
      gray = new Uint8Array(width * height);
    let grain = 123;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        grain ^= grain << 13;
        grain ^= grain >>> 17;
        grain ^= grain << 5;
        gray[y * width + x] = y % 32 < 4 && x > 70 && x < 780 ? 35 : 240 + ((grain >>> 0) % 16);
      }
    const scan = doc.context.register(
      doc.context.flateStream(gray, {
        Type: 'XObject',
        Subtype: 'Image',
        Width: width,
        Height: height,
        ColorSpace: 'DeviceGray',
        BitsPerComponent: 8,
      })
    );
    const name = page.node.newXObject('Scan', scan);
    page.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(300, 0, 0, 400, 40, 100),
      drawObject(name),
      popGraphicsState()
    );
    page.drawText('Searchable scan caption', { x: 30, y: 600, size: 12 });
    output.scan = await doc.save({ useObjectStreams: false });
  }
  {
    const doc = await PDFDocument.create({ updateMetadata: false }),
      page = doc.addPage([480, 640]);
    page.drawText('Searchable text-heavy fixture', { x: 30, y: 600, size: 12 });
    const raw = doc.context.register(
      doc.context.stream('% Repeated text/vector production padding\n'.repeat(6000))
    );
    page.node.addContentStream(raw);
    output['text-heavy'] = await doc.save({ useObjectStreams: false });
  }
  output.metadata = (await syntheticPdf()).bytes;
  return output;
}
