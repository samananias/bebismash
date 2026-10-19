import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { PDFDocument, PDFName } from 'pdf-lib';
import type {
  DocumentPolicy,
  PdfDiagnostics,
  WorkerCommand,
  WorkerEvent,
} from '../../src/core/types';
import { jpegAdapter } from '../../src/codecs/jpeg';
import { pdfCompressionFixtures } from '../../src/codecs/testing/pdfCompressionFixtures';
import type { PdfFixtureName } from '../../src/codecs/testing/pdfCompressionFixtures';

const nativeFetch = globalThis.fetch;
let fixtures: Record<PdfFixtureName, Uint8Array>;
test.beforeAll(async () => {
  globalThis.fetch = async (url, options) =>
    String(url).startsWith('file:')
      ? new Response(await readFile(new URL(String(url))), {
          headers: { 'Content-Type': 'application/wasm' },
        })
      : nativeFetch(url, options);
  fixtures = await pdfCompressionFixtures(jpegAdapter);
});
test.afterAll(() => {
  globalThis.fetch = nativeFetch;
});
test.beforeEach(async ({ page }) => {
  await page.route('**/api/stats', (route) =>
    route.fulfill({ json: { total_files_smashed: 0, total_bytes_saved: 0 } })
  );
  await page.addInitScript(() => {
    const state = window as unknown as {
      pdfEvidence: {
        result: Extract<WorkerEvent, { type: 'result' }> | null;
        policy: DocumentPolicy | null;
      };
    };
    state.pdfEvidence = { result: null, policy: null };
    const Native = window.Worker;
    window.Worker = class extends Native {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener('message', ({ data }: { data: WorkerEvent }) => {
          if (data.type === 'result') state.pdfEvidence.result = data;
        });
      }
      override postMessage(message: WorkerCommand, transfer: Transferable[] = []) {
        if (message.type === 'start' && message.config.format === 'pdf') {
          state.pdfEvidence = { result: null, policy: message.config.policy as DocumentPolicy };
        }
        super.postMessage(message, transfer);
      }
    };
  });
});

for (const kind of [
  'image-heavy',
  'scan',
  'text-heavy',
  'large-image',
  'already-jpeg',
  'metadata',
] as const) {
  test(`real PDF profiles: ${kind}`, async ({ page }) => {
    test.setTimeout(120000);
    const writes: string[] = [];
    page.on('request', (request) => {
      if (request.method() !== 'GET') writes.push(request.url());
    });
    await page.goto('/');
    const rows: { intensity: string; input: number; output: number; report: PdfDiagnostics }[] = [];
    await writeFile(test.info().outputPath(`${kind}-original.pdf`), fixtures[kind]);
    for (const intensity of ['gentle', 'balanced', 'heavy'] as const) {
      await page.getByLabel('Choose files', { exact: true }).setInputFiles({
        name: `${kind}.pdf`,
        mimeType: 'application/pdf',
        buffer: Buffer.from(fixtures[kind]),
      });
      await page
        .getByRole('button', {
          name: intensity[0]!.toUpperCase() + intensity.slice(1),
          exact: true,
        })
        .click();
      await page.getByRole('button', { name: 'Compress file', exact: true }).click();
      await expect(page.getByRole('button', { name: 'New batch', exact: true })).toBeVisible({
        timeout: 90000,
      });
      const evidence = await page.evaluate(
        () =>
          (
            window as unknown as {
              pdfEvidence: {
                result: Extract<WorkerEvent, { type: 'result' }>;
                policy: DocumentPolicy;
              };
            }
          ).pdfEvidence
      );
      expect(evidence.policy.targetDpi).toBe(
        intensity === 'gentle' ? null : intensity === 'balanced' ? 150 : 96
      );
      expect(evidence.policy.image.quality).toBe(
        intensity === 'gentle' ? 90 : intensity === 'balanced' ? 75 : 55
      );
      expect(evidence.result.pdfDiagnostics?.validation).toBe('passed');
      expect(evidence.result.pdfDiagnostics?.failure).toBe('none');
      let output = fixtures[kind];
      if (evidence.result.disposition === 'transformed') {
        const downloaded = page.waitForEvent('download');
        await page.getByRole('link', { name: 'Download file', exact: true }).click();
        output = new Uint8Array(await readFile((await (await downloaded).path())!));
      } else
        await expect(page.getByRole('link', { name: 'Download file', exact: true })).toHaveCount(0);
      expect(output.length).toBe(evidence.result.outputBytes);
      expect(output.length).toBeLessThanOrEqual(fixtures[kind].length);
      const doc = await PDFDocument.load(output, { updateMetadata: false });
      expect(doc.getPageCount()).toBe(1);
      await writeFile(test.info().outputPath(`${kind}-${intensity}.pdf`), output);
      const report = evidence.result.pdfDiagnostics!;
      if (['image-heavy', 'scan', 'large-image'].includes(kind) && intensity !== 'gentle') {
        expect(report.imagesOptimized).toBeGreaterThan(0);
        expect(report.imagesDownsampled).toBeGreaterThan(0);
      }
      rows.push({ intensity, input: fixtures[kind].length, output: output.length, report });
      if (kind === 'image-heavy' && intensity === 'heavy') {
        await page.getByText('What’s happening?', { exact: false }).click();
        await expect(page.locator('.job-details')).toContainText('96 DPI / JPEG Q55');
        await page.setViewportSize({ width: 390, height: 1000 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true
        );
        await page.screenshot({
          path: test.info().outputPath('pdf-compression-mobile.png'),
          fullPage: true,
        });
      }
      await page.getByRole('button', { name: 'New batch', exact: true }).click();
    }
    if (['image-heavy', 'scan', 'large-image'].includes(kind)) {
      expect(rows[1]!.output).toBeLessThan(rows[0]!.output);
      expect(rows[2]!.output).toBeLessThan(rows[1]!.output);
    }
    await writeFile(
      test.info().outputPath(`${kind}-benchmark.json`),
      JSON.stringify(rows, null, 2)
    );
    expect(writes).toEqual([]);
  });
}

test('unsupported metadata cleanup cannot cancel an eligible Heavy image transform', async ({
  page,
}) => {
  const doc = await PDFDocument.load(fixtures['image-heavy'], { updateMetadata: false });
  doc.catalog.set(
    PDFName.of('Metadata'),
    doc.context.register(doc.context.stream('Retained unsupported XML', { Subtype: 'XML' }))
  );
  const source = await doc.save({ useObjectStreams: false });
  await page.goto('/');
  await page.getByLabel('Choose files', { exact: true }).setInputFiles({
    name: 'partial.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(source),
  });
  await page.getByRole('button', { name: 'Heavy', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Remove embedded PDF metadata' }).check();
  await page.getByRole('button', { name: 'Compress file', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Download file', exact: true })).toBeVisible({
    timeout: 60000,
  });
  const report = await page.evaluate(
    () =>
      (window as unknown as { pdfEvidence: { result: { pdfDiagnostics: PdfDiagnostics } } })
        .pdfEvidence.result.pdfDiagnostics
  );
  expect(report.imagesOptimized).toBe(1);
  expect(report.metadata).toBe('skipped');
  await expect(page.locator('.job-detail')).toContainText('Smaller PDF ready; metadata retained.');
});
