import { PDFDict, PDFName, PDFRawStream, PDFRef, PDFNumber, PDFArray } from 'pdf-lib';
import type { PDFDocument } from 'pdf-lib';
import type { PdfDiagnostics } from '../core/types';

export { createPdfReport } from '../core/pdfDiagnostics';

/** Inventory stored stream bytes only; no extracted text or metadata enters diagnostics. */
export function inventoryPdf(doc: PDFDocument, report: PdfDiagnostics): void {
  const objects = doc.context.enumerateIndirectObjects();
  const metadata = new Set<unknown>(),
    fonts = new Set<unknown>();
  for (const [, object] of objects) {
    const dict = object instanceof PDFRawStream ? object.dict : object;
    if (!(dict instanceof PDFDict)) continue;
    const target = dict.get(PDFName.of('Metadata'));
    if (target) metadata.add(target instanceof PDFRef ? doc.context.lookup(target) : target);
    for (const name of ['FontFile', 'FontFile2', 'FontFile3']) {
      const ref = dict.get(PDFName.of(name));
      if (ref) fonts.add(ref instanceof PDFRef ? doc.context.lookup(ref) : ref);
    }
  }
  report.objects = objects.length;
  for (const [, object] of objects) {
    if (!(object instanceof PDFRawStream)) continue;
    report.streams++;
    if (object.dict.has(PDFName.of('Filter'))) report.compressedStreams++;
    const bytes = object.getContents().length;
    if (object.dict.lookup(PDFName.of('Subtype')) === PDFName.of('Image')) {
      report.images++;
      report.imageBytes += bytes;
      const filterObject = object.dict.lookup(PDFName.of('Filter'));
      const filters =
        filterObject instanceof PDFArray && filterObject.size() <= 4
          ? filterObject.asArray().map((item) => doc.context.lookup(item))
          : [filterObject];
      const bpc = object.dict.lookup(PDFName.of('BitsPerComponent'));
      if (bpc instanceof PDFNumber && bpc.asNumber() === 1) report.monochromeImages++;
      else if (filters.includes(PDFName.of('DCTDecode'))) report.jpegImages++;
      else if (filters.includes(PDFName.of('FlateDecode'))) report.flateImages++;
      else report.otherImages++;
      const color = object.dict.lookup(PDFName.of('ColorSpace'));
      if (color === PDFName.of('DeviceRGB')) report.rgbImages++;
      else if (color === PDFName.of('DeviceGray')) report.grayImages++;
      else if (color === PDFName.of('DeviceCMYK')) report.cmykImages++;
      else report.otherColorImages++;
      const width = object.dict.lookup(PDFName.of('Width')),
        height = object.dict.lookup(PDFName.of('Height'));
      if (
        width instanceof PDFNumber &&
        height instanceof PDFNumber &&
        Number.isSafeInteger(width.asNumber()) &&
        Number.isSafeInteger(height.asNumber()) &&
        width.asNumber() > 0 &&
        height.asNumber() > 0 &&
        width.asNumber() * height.asNumber() > report.largestImageWidth * report.largestImageHeight
      ) {
        report.largestImageWidth = width.asNumber();
        report.largestImageHeight = height.asNumber();
      }
    } else if (
      metadata.has(object) ||
      object.dict.get(PDFName.of('Type')) === PDFName.of('Metadata')
    )
      report.metadataBytes += bytes;
    else if (fonts.has(object)) report.fontBytes += bytes;
    else report.otherStreamBytes += bytes;
  }
}
