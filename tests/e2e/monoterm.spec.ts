import { test, expect } from '@playwright/test';

test('unchanged single file avoids duplicate downloads, stays private and resets', async ({
  page,
}, testInfo) => {
  const requests: string[] = [];
  const engines: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() !== 'GET' || new URL(request.url()).origin !== 'http://127.0.0.1:4173')
      requests.push(request.url());
    if (/worker|wasm|fflate/.test(request.url())) engines.push(request.url());
  });
  await page.route('**/api/stats', (route) =>
    route.fulfill({ json: { total_files_smashed: 0, total_bytes_saved: 0 } })
  );
  await page.addInitScript(() => {
    document.addEventListener(
      'change',
      (event) => {
        const input = event.target;
        if (input instanceof HTMLInputElement && input.files?.length)
          Object.assign(window, { originalFixture: input.files[0] });
      },
      true
    );
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('A little lighter.');
  expect(engines).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('desktop-empty.png'), fullPage: true });
  const source = 'BebiSmash local fixture.\n'.repeat(400);
  const filename = `${'a'.repeat(120)}.txt`;
  await page
    .getByLabel('Choose files', { exact: true })
    .setInputFiles({ name: filename, mimeType: 'text/plain', buffer: Buffer.from(source) });
  await page.getByRole('button', { name: 'Heavy', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Heavy', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await page.screenshot({ path: testInfo.outputPath('desktop-queued.png'), fullPage: true });
  await page.getByRole('button', { name: 'Compress file' }).click();
  await expect(page.getByRole('main').getByRole('status')).toContainText(
    'Original retained. No duplicate saved.'
  );
  await expect(page.getByRole('link', { name: 'Download file' })).toHaveCount(0);
  await expect(page.locator('.file-row')).toContainText(
    'Compression is not supported for this content.'
  );
  expect(
    await page.evaluate(async () =>
      (window as unknown as { originalFixture: File }).originalFixture.text()
    )
  ).toBe(source);
  expect(engines.some((url) => /zip\.worker/.test(url))).toBe(false);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('mobile-direct-download.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'New batch' }).click();
  await expect(page.getByText('A clean slate. Add a few files to get started.')).toBeVisible();
  expect(requests).toEqual([]);
  expect(errors).toEqual([]);
});

test('mobile queue, keyboard privacy dialog and reduced motion', async ({ page }, testInfo) => {
  await page.route('**/api/stats', (route) =>
    route.fulfill({ json: { total_files_smashed: 0, total_bytes_saved: 0 } })
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const longName = `${'a-long-local-filename-'.repeat(8)}.txt`;
  await page.getByLabel('Choose files', { exact: true }).setInputFiles({
    name: longName,
    mimeType: 'text/plain',
    buffer: Buffer.from('local fixture'),
  });
  await expect(page.getByRole('heading', { name: longName, exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('mobile-queued.png'), fullPage: true });
  await page.getByRole('button', { name: 'Privacy & telemetry', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('checkbox')).not.toBeChecked();
  await page.keyboard.press('Shift+Tab');
  expect(
    await page.evaluate(() => document.querySelector('dialog')?.contains(document.activeElement))
  ).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Privacy & telemetry', exact: true })
  ).toBeFocused();
  await page.getByRole('button', { name: `Remove ${longName}`, exact: true }).click();
  await expect(page.getByText('A clean slate. Add a few files to get started.')).toBeVisible();
});

test('cancellation and worker failure retain files for retry', async ({ page }) => {
  await page.route('**/api/stats', (route) =>
    route.fulfill({ json: { total_files_smashed: 0, total_bytes_saved: 0 } })
  );
  const workerPattern = '**/assets/generic.worker-*.js';
  await page.route(workerPattern, (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      headers: {
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'same-origin',
      },
      body: 'self.onmessage = () => {};',
    })
  );
  await page.goto('/');
  await page.getByLabel('Choose files', { exact: true }).setInputFiles({
    name: 'retry.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('retry fixture'),
  });
  await page.getByRole('button', { name: 'Compress file' }).click();
  await expect(page.getByRole('button', { name: 'Choose files' })).toBeDisabled();
  await expect(page.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
  await page.getByRole('button', { name: 'Cancel batch' }).click();
  await expect(page.getByRole('button', { name: 'Retry batch' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'retry.txt', exact: true })).toBeVisible();
  await page.unroute(workerPattern);
  await page.route(workerPattern, (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      headers: {
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'same-origin',
      },
      body: "self.onmessage = ({data:c}) => { if(c.type==='start') postMessage({version:1,batchId:c.batchId,jobId:c.jobId,attemptId:c.attemptId,type:'error',error:{code:'DECODE_FAILED',retryable:true,messageKey:'decode_failed'}}); };",
    })
  );
  await page.getByRole('button', { name: 'Retry batch' }).click();
  await expect(page.getByRole('alert')).toContainText('DECODE_FAILED');
  await page.unroute(workerPattern);
  await page.getByRole('button', { name: 'Retry batch' }).click();
  await expect(page.getByRole('main').getByRole('status')).toContainText(
    'Original retained. No duplicate saved.'
  );
  await expect(page.getByRole('alert')).toHaveCount(0);
});
