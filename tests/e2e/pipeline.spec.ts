import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { unzipSync } from 'fflate';
// Synthetic noise PNGs exercise real WASM with real pixel workloads, no private fixtures.
function png(targetBytes: number) {
  const side = Math.floor(Math.sqrt(targetBytes / 4));
  const raw = Buffer.alloc((side * 4 + 1) * side);
  let seed = 31;
  for (let y = 0; y < side; y++)
    for (let x = 1; x <= side * 4; x++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      raw[y * (side * 4 + 1) + x] = seed & 255;
    }
  function chunk(name: string, data: Buffer) {
    const type = Buffer.from(name);
    const body = Buffer.concat([type, data]);
    let crc = -1;
    for (const b of body) {
      crc ^= b;
      for (let n = 0; n < 8; n++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(data.length);
    const suffix = Buffer.alloc(4);
    suffix.writeUInt32BE((crc ^ -1) >>> 0);
    return Buffer.concat([prefix, body, suffix]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header[8] = 8;
  header[9] = 6;
  return {
    side,
    buffer: Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  };
}
test.beforeEach(async ({ page }) => {
  await page.route('**/api/stats', (route) =>
    route.fulfill({ json: { total_files_smashed: 0, total_bytes_saved: 0 } })
  );
});
for (const size of [100 * 1024, 500 * 1024, 1024 * 1024, 10 * 1024 * 1024]) {
  test(`real PNG pipeline, independent decode, and no upload: ${size} bytes`, async ({ page }) => {
    test.setTimeout(90000);
    const source = png(size);
    const writes: string[] = [];
    const errors: string[] = [];
    page.on('request', (request) => {
      if (request.method() !== 'GET') writes.push(request.url());
    });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/');
    await page
      .getByLabel('Choose files', { exact: true })
      .setInputFiles({ name: 'noise.png', mimeType: 'image/png', buffer: source.buffer });
    await page.getByRole('button', { name: 'Compress file' }).click();
    await expect(page.getByRole('link', { name: 'Download file' })).toBeVisible({ timeout: 60000 });
    await page.getByText('What’s happening?', { exact: false }).click();
    await expect(page.getByLabel('Compression engine assets')).toContainText('Ready');
    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download file' }).click();
    const saved = await download;
    expect(saved.suggestedFilename()).toBe('noise.png');
    const data = new Uint8Array(await readFile((await saved.path())!));
    expect(data).toBeDefined();
    const dimensions = await page.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const result = [bitmap.width, bitmap.height];
      bitmap.close();
      return result;
    }, Buffer.from(data).toString('base64'));
    expect(dimensions).toEqual([source.side, source.side]);
    expect(writes).toEqual([]);
    expect(errors).toEqual([]);
  });
}
test('WASM download failure surfaces details and retry succeeds', async ({ page }) => {
  await page.route('**/*.wasm', (route) =>
    route.fulfill({ status: 503, contentType: 'text/plain', body: 'unavailable' })
  );
  await page.goto('/');
  await page
    .getByLabel('Choose files', { exact: true })
    .setInputFiles({ name: 'retry.png', mimeType: 'image/png', buffer: png(100000).buffer });
  await page.getByRole('button', { name: 'Compress file' }).click();
  await expect(page.getByRole('alert')).toContainText(/503|worker.*failed|execution deadline/i, {
    timeout: 35000,
  });
  await expect(page.getByRole('link', { name: 'Download file' })).toHaveCount(0);
  await page.unroute('**/*.wasm');
  await page.getByRole('button', { name: 'Retry batch' }).click();
  await expect(page.getByRole('link', { name: 'Download file' })).toBeVisible({ timeout: 20000 });
});
test('multiple media files retain independent results and ZIP entries', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Choose files', { exact: true }).setInputFiles([
    { name: 'one.png', mimeType: 'image/png', buffer: png(100000).buffer },
    { name: 'two.png', mimeType: 'image/png', buffer: png(500000).buffer },
  ]);
  await page.getByRole('button', { name: 'Smash into ZIP' }).click();
  await expect(page.getByRole('link', { name: 'Download ZIP' })).toBeVisible({ timeout: 30000 });
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download ZIP' }).click();
  const archive = unzipSync(new Uint8Array(await readFile((await (await download).path())!)));
  expect(Object.keys(archive)).toEqual(['one.png', 'two.png']);
  await expect(page.getByRole('progressbar')).toHaveCount(2);
  for (const progress of await page.getByRole('progressbar').all())
    await expect(progress).toHaveAttribute('aria-valuenow', '100');
});
test('unsupported recognized image fails with an actionable error', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Choose files', { exact: true }).setInputFiles({
    name: 'broken.png',
    mimeType: 'image/png',
    buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  });
  await page.getByRole('button', { name: 'Compress file' }).click();
  await expect(page.getByRole('alert')).toContainText('INVALID_INPUT');
  await expect(page.getByRole('button', { name: 'Retry batch' })).toBeVisible();
});

test('stalled processing exposes real frame count, Wait, and cancellation', async ({
  page,
}, testInfo) => {
  await page.clock.install();
  await page.route('**/assets/generic.worker-*.js', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      headers: {
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'same-origin',
      },
      body: `self.onmessage = ({data: c}) => { if (c.type !== 'start') return; const ids = {version:1,batchId:c.batchId,jobId:c.jobId,attemptId:c.attemptId}; postMessage({...ids,type:'ready'}); postMessage({...ids,type:'progress',seq:1,stage:'transform',completed:18420,total:null,unit:'frames'}); setInterval(() => postMessage({...ids,type:'heartbeat'}),1000); };`,
    })
  );
  await page.goto('/');
  await page
    .getByLabel('Choose files', { exact: true })
    .setInputFiles({ name: 'slow.txt', mimeType: 'text/plain', buffer: Buffer.from('test') });
  await page.getByRole('button', { name: 'Compress file' }).click();
  await expect(page.locator('.job-detail')).toContainText('18,420 frames processed');
  await expect(page.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
  await page.clock.fastForward(31000);
  await expect(page.getByText('Processing may be stalled', { exact: true })).toBeVisible();
  await page.getByText('What’s happening?', { exact: false }).click();
  await page.screenshot({ path: testInfo.outputPath('desktop-processing.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('mobile-processing.png'), fullPage: true });
  await page.getByRole('button', { name: 'Wait 30 seconds' }).click();
  await expect(page.getByText('Processing may be stalled', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel batch' }).click();
  await expect(page.getByRole('button', { name: 'Retry batch' })).toBeVisible();
});

for (const moving of [false, true])
  test(`native video engine inspects real tracks and creates a playable archive entry (moving=${moving})`, async ({
    page,
  }) => {
    await page.goto('/');
    const sample = await page.evaluate(async (moving) => {
      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = 120;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#214dcc';
      context.fillRect(0, 0, 160, 120);
      const stream = canvas.captureStream(10);
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
      const parts: Blob[] = [];
      recorder.ondataavailable = ({ data }) => parts.push(data);
      const done = new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
      });
      recorder.start();
      let frame = 0;
      const draw = moving
        ? setInterval(() => {
            context.fillStyle = frame++ % 2 ? '#214dcc' : '#e8ecd7';
            context.fillRect(0, 0, 160, 120);
          }, 90)
        : undefined;
      await new Promise((resolve) => setTimeout(resolve, 1100));
      recorder.stop();
      clearInterval(draw);
      await done;
      stream.getTracks().forEach((track) => track.stop());
      const bytes = new Uint8Array(await new Blob(parts).arrayBuffer());
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    }, moving);
    await page.getByLabel('Choose files', { exact: true }).setInputFiles({
      name: 'sample.webm',
      mimeType: 'video/webm',
      buffer: Buffer.from(sample, 'base64'),
    });
    await page.getByRole('button', { name: 'Compress file' }).click();
    await expect(page.getByRole('link', { name: 'Download file' })).toBeVisible({ timeout: 30000 });
    await page.getByText('What’s happening?', { exact: false }).click();
    await expect(page.locator('.job-details')).toContainText('Mediabunny / WebCodecs');
    await expect(page.locator('.job-details')).toContainText('160 × 120');
    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download file' }).click();
    const saved = await download;
    expect(saved.suggestedFilename()).toBe('sample.webm');
    const output = new Uint8Array(await readFile((await saved.path())!));
    const dimensions = await page.evaluate(async (base64) => {
      const blob = new Blob(
        [Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))],
        {
          type: 'video/webm',
        }
      );
      const video = document.createElement('video');
      const url = URL.createObjectURL(blob);
      try {
        const loaded = new Promise<void>((resolve, reject) => {
          video.onloadedmetadata = () => resolve();
          video.onerror = () => reject(new Error('Output video cannot be decoded'));
        });
        video.src = url;
        await loaded;
        return [video.videoWidth, video.videoHeight];
      } finally {
        video.removeAttribute('src');
        video.load();
        URL.revokeObjectURL(url);
      }
    }, Buffer.from(output).toString('base64'));
    expect(dimensions).toEqual([160, 120]);
  });
