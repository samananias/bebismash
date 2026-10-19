import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { unzipSync } from 'fflate';
import { syntheticPdf } from '../../src/codecs/testing/pdfFixture';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/stats', (route) =>
    route.fulfill({ json: { total_files_smashed: 0, total_bytes_saved: 0 } })
  );
});

test('PDF choice is keyboard accessible, explicit, locked and local; forms survive real worker cleanup', async ({
  page,
}) => {
  const source = await syntheticPdf();
  const uploads: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET') uploads.push(request.url());
  });
  await page.goto('/');
  await page.getByLabel('Choose files', { exact: true }).setInputFiles({
    name: 'synthetic.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(source.bytes),
  });
  const choice = page.getByRole('checkbox', { name: 'Remove embedded PDF metadata' });
  await expect(choice).not.toBeChecked();
  await page.getByRole('button', { name: 'Heavy', exact: true }).click();
  await expect(choice).not.toBeChecked();
  await choice.focus();
  await page.keyboard.press('Space');
  await expect(choice).toBeChecked();
  await expect(choice).toHaveAccessibleDescription(/all supported PDFs in this batch/);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(page.locator('.pdf-cleanup')).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath(`pdf-settings-${width}.png`),
      fullPage: true,
    });
  }
  await page.getByRole('button', { name: 'Compress file' }).click();
  await expect(choice).toBeDisabled();
  const link = page.getByRole('link', { name: 'Download file' });
  await expect(link).toBeVisible({ timeout: 60000 });
  await expect(page.locator('.job-detail')).toContainText(
    'Smaller PDF ready; embedded metadata removed.'
  );
  const downloading = page.waitForEvent('download');
  await link.click();
  const saved = await downloading;
  expect(saved.suggestedFilename()).toBe('synthetic.pdf');
  const bytes = await readFile((await saved.path())!);
  const doc = await PDFDocument.load(bytes);
  expect(doc.catalog.has(PDFName.of('Metadata'))).toBe(false);
  expect(doc.getForm().getTextField('synthetic-field').getText()).toBe('Retained form value');
  // Kept in Playwright's ignored artifact directory for optional independent reader checks.
  await saved.saveAs(test.info().outputPath('synthetic-cleanup.pdf'));
  expect(uploads).toEqual([]);
  await page.getByRole('button', { name: 'New batch' }).click();
  await page.getByLabel('Choose files', { exact: true }).setInputFiles({
    name: 'synthetic.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(source.bytes),
  });
  await expect(choice).not.toBeChecked();
});

test('default PDF rewrite preserves XMP in a mixed ZIP batch', async ({ page }) => {
  const source = await syntheticPdf();
  await page.goto('/');
  await page.getByLabel('Choose files', { exact: true }).setInputFiles([
    { name: 'synthetic.pdf', mimeType: 'application/pdf', buffer: Buffer.from(source.bytes) },
    { name: 'original.txt', mimeType: 'text/plain', buffer: Buffer.from('original') },
  ]);
  await page.getByRole('button', { name: 'Smash into ZIP' }).click();
  const link = page.getByRole('link', { name: 'Download ZIP' });
  await expect(link).toBeVisible({ timeout: 60000 });
  const downloading = page.waitForEvent('download');
  await link.click();
  const archive = unzipSync(new Uint8Array(await readFile((await (await downloading).path())!)));
  const doc = await PDFDocument.load(archive['synthetic.pdf']!);
  const metadata = doc.catalog.lookup(PDFName.of('Metadata')) as PDFRawStream;
  expect(new TextDecoder().decode(decodePDFRawStream(metadata).decode())).toBe(source.xmp);
  expect(new TextDecoder().decode(archive['original.txt'])).toBe('original');
});

test('conformance cleanup refusal saves no duplicate single file and retains original ZIP entry', async ({
  page,
}) => {
  const source = await syntheticPdf({ conformance: true });
  await page.goto('/');
  const input = {
    name: 'archival.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(source.bytes),
  };
  await page.getByLabel('Choose files', { exact: true }).setInputFiles(input);
  await page.getByRole('checkbox', { name: 'Remove embedded PDF metadata' }).check();
  await page.getByRole('button', { name: 'Compress file' }).click();
  await expect(
    page.getByText('Original retained. No duplicate saved.', { exact: true })
  ).toBeVisible({ timeout: 60000 });
  await expect(page.getByRole('link', { name: 'Download file' })).toHaveCount(0);
  await expect(page.getByText(/Archival or print-conformance constraints/)).toBeVisible();
  await page.getByRole('button', { name: 'New batch' }).click();
  await page
    .getByLabel('Choose files', { exact: true })
    .setInputFiles([
      input,
      { name: 'original.txt', mimeType: 'text/plain', buffer: Buffer.from('original') },
    ]);
  await page.getByRole('checkbox', { name: 'Remove embedded PDF metadata' }).check();
  await page.getByRole('button', { name: 'Smash into ZIP' }).click();
  const link = page.getByRole('link', { name: 'Download ZIP' });
  await expect(link).toBeVisible({ timeout: 60000 });
  const downloading = page.waitForEvent('download');
  await link.click();
  const archive = unzipSync(new Uint8Array(await readFile((await (await downloading).path())!)));
  expect(archive['archival.pdf']).toEqual(source.bytes);
});
