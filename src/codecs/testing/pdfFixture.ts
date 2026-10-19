import { PDFDocument, PDFName, PDFString } from 'pdf-lib';

/** Synthetic public-domain test data only; no user documents or extracted content. */
export async function syntheticPdf(
  options: { shared?: boolean; conformance?: boolean; compressed?: boolean } = {}
) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle('Synthetic document title');
  const page = doc.addPage([320, 480]);
  page.drawText('Searchable synthetic content', { x: 30, y: 400, size: 14 });
  const png = Uint8Array.from(
    atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4d8AAAAASUVORK5CYII='
    ),
    (char) => char.charCodeAt(0)
  );
  const image = await doc.embedPng(png);
  page.drawImage(image, { x: 30, y: 240, width: 24, height: 24 });
  const form = doc.getForm();
  const field = form.createTextField('synthetic-field');
  field.setText('Retained form value');
  field.addToPage(page, { x: 30, y: 300, width: 200, height: 30 });
  await doc.attach(new TextEncoder().encode('Retained attachment'), 'synthetic.txt');
  const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/">${options.conformance ? 'http://www.aiim.org/pdfa/ns/id/' : ''}${'Synthetic provenance and rights. '.repeat(4096)}</x:xmpmeta>`;
  const metadata = (
    options.compressed
      ? doc.context.flateStream.bind(doc.context)
      : doc.context.stream.bind(doc.context)
  )(xmp, { Type: 'Metadata', Subtype: 'XML' });
  const metadataRef = doc.context.register(metadata);
  doc.catalog.set(PDFName.of('Metadata'), metadataRef);
  page.node.set(PDFName.of('Metadata'), metadataRef);
  const unrelated = doc.context.register(
    doc.context.stream('Retained unrelated XML', { Subtype: 'XML' })
  );
  doc.catalog.set(PDFName.of('UnrelatedXml'), unrelated);
  const cycle = doc.context.obj({ Label: PDFString.of('Retained cyclic resource') });
  const cycleRef = doc.context.register(cycle);
  cycle.set(PDFName.of('Self'), cycleRef);
  cycle.set(PDFName.of('Nested'), doc.context.obj([{ Shared: unrelated }]));
  if (options.shared) cycle.set(PDFName.of('SharedMetadata'), metadataRef);
  doc.catalog.set(PDFName.of('SyntheticResource'), cycleRef);
  const bytes = await doc.save({ useObjectStreams: false });
  return { bytes, xmp, metadataRef, unrelated, cycleRef };
}
