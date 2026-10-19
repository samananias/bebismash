import { PDFArray, PDFBool, PDFDict, PDFName, PDFNull, PDFNumber, PDFRawStream } from 'pdf-lib';
import type { PDFDocument, PDFRef } from 'pdf-lib';
import type { DocumentPolicy, ImagePolicy, PdfDiagnostics, ResourceLimits } from '../core/types';
import type { DecodedImage } from './types';
import type { GraphBudget } from './pdfGraph';
import { walkPdfGraph, trailerRoots } from './pdfGraph';
import { analyzePdfPlacements } from './pdfPlacement';
import { hasDecodeParameters, inflatePdfBytes, readPdfStream, streamFilters } from './pdfStreams';

export interface PdfImageEngine {
  decode(buffer: ArrayBuffer): Promise<DecodedImage>;
  encode(image: DecodedImage, policy: ImagePolicy): Promise<ArrayBuffer>;
}

/** JPEG dimensions/components are checked before decode. EXIF/XMP/IPTC APP packets
 * remain byte-identical; PDF placement, not EXIF orientation, determines page geometry.
 * ICC-bearing JPEGs require color management and are excluded from this RGB/Gray adapter.
 */
export function inspectPdfJpeg(bytes: Uint8Array): {
  width: number;
  height: number;
  components: number;
  packets: Uint8Array[];
} {
  if (bytes[0] !== 255 || bytes[1] !== 216) throw new Error('JPEG header');
  let offset = 2,
    width = 0,
    height = 0,
    components = 0;
  const packets: Uint8Array[] = [];
  while (offset + 4 <= bytes.length && offset < 1024 * 1024) {
    if (bytes[offset] !== 255) throw new Error('JPEG marker');
    const marker = bytes[offset + 1]!;
    if (marker === 255) {
      offset++;
      continue;
    }
    if (marker === 218) {
      if (!width || !height) throw new Error('JPEG dimensions');
      return { width, height, components, packets };
    }
    if (marker === 1 || (marker >= 208 && marker <= 217)) {
      offset += 2;
      continue;
    }
    const length = bytes[offset + 2]! * 256 + bytes[offset + 3]!;
    if (length < 2 || offset + 2 + length > bytes.length || offset + 2 + length > 1024 * 1024)
      throw new Error('JPEG segment');
    if (marker === 226) throw new Error('JPEG ICC or auxiliary profile');
    if (marker === 225 || marker === 237) packets.push(bytes.subarray(offset, offset + 2 + length));
    if (marker === 192 || marker === 193 || marker === 194) {
      if (length < 8 || bytes[offset + 4] !== 8) throw new Error('JPEG precision');
      height = bytes[offset + 5]! * 256 + bytes[offset + 6]!;
      width = bytes[offset + 7]! * 256 + bytes[offset + 8]!;
      components = bytes[offset + 9]!;
    }
    offset += 2 + length;
  }
  throw new Error('JPEG scan limit');
}

/** Area averaging preserves thin image detail better than nearest-neighbor sampling.
 * Runs only inside an admitted worker; output never exceeds original dimensions.
 */
export async function resizePdfImage(
  image: DecodedImage,
  width: number,
  height: number,
  budget: GraphBudget
): Promise<DecodedImage> {
  if (width === image.width && height === image.height) return image;
  if (width < 1 || height < 1 || width > image.width || height > image.height)
    throw new Error('Image resize bounds');
  const data = new Uint8ClampedArray(width * height * 4);
  const sx = image.width / width,
    sy = image.height / height;
  for (let y = 0; y < height; y++) {
    if (y % 16 === 0) await budget.checkpoint();
    const top = y * sy,
      bottom = (y + 1) * sy;
    for (let x = 0; x < width; x++) {
      const left = x * sx,
        right = (x + 1) * sx;
      let r = 0,
        g = 0,
        b = 0,
        weight = 0;
      for (let yy = Math.floor(top); yy < Math.ceil(bottom); yy++) {
        const wy = Math.min(bottom, yy + 1) - Math.max(top, yy);
        for (let xx = Math.floor(left); xx < Math.ceil(right); xx++) {
          const area = wy * (Math.min(right, xx + 1) - Math.max(left, xx));
          const offset =
            (Math.min(yy, image.height - 1) * image.width + Math.min(xx, image.width - 1)) * 4;
          r += image.data[offset]! * area;
          g += image.data[offset + 1]! * area;
          b += image.data[offset + 2]! * area;
          weight += area;
        }
      }
      const offset = (y * width + x) * 4;
      data[offset] = r / weight;
      data[offset + 1] = g / weight;
      data[offset + 2] = b / weight;
      data[offset + 3] = 255;
    }
  }
  return { width, height, data };
}

export async function optimizePdfImages(
  doc: PDFDocument,
  policy: DocumentPolicy,
  limits: ResourceLimits,
  budget: GraphBudget,
  report: PdfDiagnostics,
  loadEngine: () => Promise<PdfImageEngine> = async () => (await import('./jpeg')).jpegAdapter
): Promise<Set<PDFRef>> {
  const changed = new Set<PDFRef>();
  const skip = (reason: keyof PdfDiagnostics['imageSkips']) => {
    report.imageSkips[reason] = (report.imageSkips[reason] ?? 0) + 1;
  };
  const images = doc.context
    .enumerateIndirectObjects()
    .filter(
      ([, object]) =>
        object instanceof PDFRawStream &&
        object.dict.lookup(PDFName.of('Subtype')) === PDFName.of('Image')
    );
  if (policy.pdfMode !== 'image-adapter' || policy.image.lossless) {
    report.imageSkips.gentle = images.length;
    return changed;
  }
  const maskTargets = new Set<PDFRawStream>();
  await walkPdfGraph(doc.context, trailerRoots(doc.context), budget, (object) => {
    const dict = object instanceof PDFRawStream ? object.dict : object;
    if (!(dict instanceof PDFDict)) return;
    for (const key of ['Mask', 'SMask']) {
      const target = dict.lookup(PDFName.of(key));
      if (target instanceof PDFRawStream) maskTargets.add(target);
    }
  });
  const placements = await analyzePdfPlacements(doc, budget);
  let engine: PdfImageEngine | undefined;
  for (const [ref, object] of images) {
    await budget.checkpoint();
    const stream = object as PDFRawStream,
      dict = stream.dict;
    if (maskTargets.has(stream)) {
      skip('mask');
      continue;
    }
    const color = dict.lookup(PDFName.of('ColorSpace'));
    if (color !== PDFName.of('DeviceRGB') && color !== PDFName.of('DeviceGray')) {
      skip('color');
      continue;
    }
    const gray = color === PDFName.of('DeviceGray');
    const widthValue = dict.lookup(PDFName.of('Width')),
      heightValue = dict.lookup(PDFName.of('Height')),
      bpc = dict.lookup(PDFName.of('BitsPerComponent'));
    if (
      !(widthValue instanceof PDFNumber) ||
      !(heightValue instanceof PDFNumber) ||
      !(bpc instanceof PDFNumber) ||
      bpc.asNumber() !== 8
    ) {
      skip('features');
      continue;
    }
    const width = widthValue.asNumber(),
      height = heightValue.asNumber();
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1 ||
      width * height > limits.maxPixels ||
      width * height * 20 > (limits.pdfImageWorkingBytes ?? 0) ||
      width > 32768 ||
      height > 32768
    ) {
      skip('memory');
      continue;
    }
    const mask = dict.lookup(PDFName.of('Mask')),
      soft = dict.lookup(PDFName.of('SMask')),
      imageMask = dict.lookup(PDFName.of('ImageMask'));
    if (
      (mask && mask !== PDFNull) ||
      (soft && soft !== PDFNull && soft !== PDFName.of('None')) ||
      (imageMask && imageMask !== PDFNull && imageMask !== PDFBool.False)
    ) {
      skip('mask');
      continue;
    }
    if (
      ['F', 'FFilter', 'FDecodeParms', 'SMaskInData', 'Alternates', 'OPI'].some((key) =>
        dict.has(PDFName.of(key))
      )
    ) {
      skip('features');
      continue;
    }
    const decode = dict.lookup(PDFName.of('Decode'));
    if (
      decode &&
      decode !== PDFNull &&
      (!(decode instanceof PDFArray) ||
        decode.size() !== (gray ? 2 : 6) ||
        decode
          .asArray()
          .some((value, index) => !(value instanceof PDFNumber) || value.asNumber() !== index % 2))
    ) {
      skip('features');
      continue;
    }
    if (hasDecodeParameters(stream)) {
      skip('filter');
      continue;
    }
    let filters: string[];
    try {
      filters = streamFilters(stream);
    } catch {
      skip('filter');
      continue;
    }
    const jpeg =
      filters.join(',') === '/DCTDecode' || filters.join(',') === '/FlateDecode,/DCTDecode';
    if (!jpeg && filters.length && filters.join(',') !== '/FlateDecode') {
      skip('filter');
      continue;
    }
    const placement = placements.get(ref);
    if (!placement) report.placementUnknown++;
    let targetWidth = width,
      targetHeight = height;
    if (placement && policy.targetDpi && placement.widthPoints > 0 && placement.heightPoints > 0) {
      // Preserve aspect ratio, using the most demanding axis from every placement.
      const scale = Math.min(
        1,
        Math.max(
          (placement.widthPoints * policy.targetDpi) / 72 / width,
          (placement.heightPoints * policy.targetDpi) / 72 / height
        )
      );
      targetWidth = Math.max(1, Math.ceil(width * scale));
      targetHeight = Math.max(1, Math.ceil(height * scale));
    }
    let encodedSource = stream.getContents();
    let packets: Uint8Array[] = [];
    if (jpeg) {
      try {
        if (filters.length === 2)
          encodedSource = await inflatePdfBytes(
            encodedSource,
            Math.min(limits.maxEntryBytes, 32 * 1024 * 1024),
            budget
          );
        const info = inspectPdfJpeg(encodedSource);
        if (info.width !== width || info.height !== height || info.components !== (gray ? 1 : 3)) {
          skip('features');
          continue;
        }
        packets = info.packets;
      } catch {
        await budget.checkpoint();
        skip('jpeg_profile');
        continue;
      }
    }
    report.imagesAttempted++;
    try {
      engine ??= await loadEngine();
      await budget.checkpoint();
      let decoded: DecodedImage;
      if (jpeg) decoded = await engine.decode(encodedSource.slice().buffer as ArrayBuffer);
      else {
        const bytes = await readPdfStream(stream, width * height * (gray ? 1 : 3), budget);
        if (bytes.length !== width * height * (gray ? 1 : 3)) throw new Error('Raw image length');
        const data = new Uint8ClampedArray(width * height * 4);
        for (let pixel = 0; pixel < width * height; pixel++) {
          if (pixel % 65536 === 0) await budget.checkpoint();
          const input = pixel * (gray ? 1 : 3),
            output = pixel * 4;
          data[output] = bytes[input]!;
          data[output + 1] = bytes[input + (gray ? 0 : 1)]!;
          data[output + 2] = bytes[input + (gray ? 0 : 2)]!;
          data[output + 3] = 255;
        }
        decoded = { width, height, data };
      }
      if (
        decoded.width !== width ||
        decoded.height !== height ||
        decoded.data.byteLength !== width * height * 4
      )
        throw new Error('Decoded image dimensions');
      await budget.checkpoint();
      const resized = await resizePdfImage(decoded, targetWidth, targetHeight, budget);
      const encoded = await engine.encode(resized, { ...policy.image, maxEdge: null });
      await budget.checkpoint();
      if (
        encoded.byteLength + packets.reduce((size, packet) => size + packet.length, 0) >=
        stream.getContents().length
      ) {
        skip('not_smaller');
        continue;
      }
      const check = inspectPdfJpeg(new Uint8Array(encoded));
      if (check.width !== targetWidth || check.height !== targetHeight || check.components !== 3)
        throw new Error('Encoded image dimensions');
      const reopened = await engine.decode(encoded);
      if (
        reopened.width !== targetWidth ||
        reopened.height !== targetHeight ||
        reopened.data.byteLength !== targetWidth * targetHeight * 4
      )
        throw new Error('Encoded image validation');
      await budget.checkpoint();
      const output = new Uint8Array(
        encoded.byteLength + packets.reduce((size, packet) => size + packet.length, 0)
      );
      output.set(new Uint8Array(encoded, 0, 2));
      let offset = 2;
      for (const packet of packets) {
        output.set(packet, offset);
        offset += packet.length;
      }
      output.set(new Uint8Array(encoded, 2), offset);
      const candidate = dict.clone(doc.context);
      candidate.set(PDFName.of('Width'), PDFNumber.of(targetWidth));
      candidate.set(PDFName.of('Height'), PDFNumber.of(targetHeight));
      candidate.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
      candidate.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
      candidate.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
      candidate.delete(PDFName.of('Length'));
      candidate.delete(PDFName.of('DecodeParms'));
      candidate.delete(PDFName.of('Decode'));
      doc.context.assign(ref, PDFRawStream.of(candidate, output));
      changed.add(ref);
      report.imagesOptimized++;
      report.imageBytesSaved += stream.getContents().length - output.length;
      if (targetWidth < width || targetHeight < height) report.imagesDownsampled++;
    } catch {
      await budget.checkpoint();
      skip('codec');
    }
  }
  return changed;
}
