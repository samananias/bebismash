import { offlineServer } from './offlineServer';
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { deflateSync } from 'node:zlib';
const stats = {
  version: 2,
  total_files_processed: 1,
  total_files_compressed: 1,
  input_bytes: 4096,
  output_bytes: 2048,
  saved_bytes: 2048,
  weighted_savings_percent: 50,
  tracking_since: '2026-10-16T00:00:00Z',
  updated_at: '2026-10-16T01:00:00Z',
  retrieved_at: '2026-10-16T02:00:00Z',
  legacy: { files_processed: 0, input_bytes: 0, saved_bytes: 0 },
  formats: [
    { format: 'png', outcome: 'compressed', file_count: 1, input_bytes: 4096, output_bytes: 2048 },
  ],
};
function png() {
  const w = 64,
    h = 64,
    raw = Buffer.alloc((w * 4 + 1) * h, 128);
  for (let y = 0; y < h; y++) raw[y * (w * 4 + 1)] = 0;
  function chunk(name: string, data: Buffer) {
    const body = Buffer.concat([Buffer.from(name), data]);
    let crc = -1;
    for (const b of body) {
      crc ^= b;
      for (let n = 0; n < 8; n++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    const a = Buffer.alloc(4),
      z = Buffer.alloc(4);
    a.writeUInt32BE(data.length);
    z.writeUInt32BE((crc ^ -1) >>> 0);
    return Buffer.concat([a, body, z]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w);
  header.writeUInt32BE(h, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
test('stats load once across processing, idle and focus; reload refreshes and failure retains cache', async ({
  page,
}) => {
  let reads = 0;
  await page.route('**/api/stats', (route) => {
    reads++;
    return reads === 1
      ? route.fulfill({ json: stats })
      : route.fulfill({ status: 503, body: 'unavailable' });
  });
  await page.goto('/');
  await expect(page.getByText('1 file compressed', { exact: false })).toBeVisible();
  await page.clock.install();
  await page.clock.fastForward(4 * 60 * 60 * 1000);
  await page.clock.resume();
  await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
  });
  await page.getByLabel('Choose files', { exact: true }).setInputFiles({
    name: 'private.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('private local contents'),
  });
  await page.getByRole('button', { name: 'Compress file', exact: true }).click();
  await expect(page.getByRole('main').getByRole('status')).toContainText(
    'Original retained. No duplicate saved.'
  );
  await page.getByRole('button', { name: 'New batch', exact: true }).click();
  expect(reads).toBe(1);
  await page.reload();
  await page.getByText('Statistics & freshness', { exact: true }).click();
  await expect(page.getByText('Counters last changed:', { exact: false })).toBeVisible();
  await expect(
    page.getByText('saved snapshot; refresh online for latest', { exact: false })
  ).toBeVisible();
  expect(reads).toBe(2);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  expect(reads).toBe(2);
});
test('one aggregate write, no files uploaded, rejected telemetry cannot fail output', async ({
  page,
}) => {
  let reads = 0;
  const bodies: unknown[] = [];
  await page.route('**/api/stats', (r) => {
    reads++;
    return r.fulfill({ json: stats });
  });
  await page.route('**/api/telemetry', (r) => {
    bodies.push(r.request().postDataJSON());
    return r.fulfill({ status: 503, body: 'quota' });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Privacy & telemetry', exact: true }).click();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByLabel('Choose files', { exact: true }).setInputFiles(
    Array.from({ length: 65 }, (_, i) => ({
      name: `private-${i}.txt`,
      mimeType: 'text/plain',
      buffer: Buffer.from('private content'.repeat(100)),
    }))
  );
  await page.getByRole('button', { name: 'Smash into ZIP', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Download ZIP', exact: true })).toBeVisible({
    timeout: 30000,
  });
  await expect.poll(() => bodies.length).toBe(1);
  expect(reads).toBe(1);
  expect(bodies[0]).toMatchObject({
    version: 2,
    buckets: [{ format: 'other', outcome: 'preserved', file_count: 65 }],
  });
  expect(JSON.stringify(bodies)).not.toMatch(/private-|private content|filename|device_tier/);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
test('explicit preparation supports cold offline shell, PNG processing, ZIP and download', async ({
  page,
}, testInfo) => {
  test.setTimeout(120000);
  const server = await offlineServer(stats);
  try {
    let statsRequests = 0;
    const writes: string[] = [];
    const engines: string[] = [];
    const errors: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/stats')) statsRequests++;
      if (r.method() !== 'GET') writes.push(r.url());
      if (/\.wasm|\.worker/.test(r.url())) engines.push(r.url());
    });
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(server.origin);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(engines).toEqual([]);
    await page.getByRole('button', { name: 'Prepare offline use', exact: true }).click();
    await expect(page.getByText('Offline assets saved.', { exact: false })).toBeVisible({
      timeout: 90000,
    });
    const urls = await page.evaluate(async () => {
      const keys = (await caches.keys()).filter((k) => k.startsWith('bebismash-assets-'));
      return (
        await Promise.all(
          keys.map(async (k) =>
            (await (await caches.open(k)).keys()).map((r) => new URL(r.url).pathname)
          )
        )
      ).flat();
    });
    expect(urls.some((u) => u.endsWith('.wasm'))).toBe(true);
    expect(urls.some((u) => u.includes('/api/'))).toBe(false);
    expect(urls.some((u) => u.includes('private'))).toBe(false);
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state))
      .toBe('activated');
    await page.addInitScript(() =>
      Object.defineProperty(navigator, 'onLine', { get: () => false })
    );
    await server.close(); // All origin requests fail, including service-worker fetches.
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(statsRequests).toBe(1);
    // Direct output on a fresh offline page (worker/module/engine not previously executed).
    await page
      .getByLabel('Choose files', { exact: true })
      .setInputFiles({ name: 'offline.png', mimeType: 'image/png', buffer: png() });
    await page.getByRole('button', { name: 'Compress file', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Download file', exact: true })).toBeVisible({
      timeout: 30000,
    });
    let promise = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download file', exact: true }).click();
    let d = await promise;
    const image = await readFile((await d.path())!);
    expect(d.suggestedFilename()).toBe('offline.png');
    const dimensions = await page.evaluate(async (b64) => {
      const b = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([b], { type: 'image/png' }));
      const value = [bitmap.width, bitmap.height];
      bitmap.close();
      return value;
    }, image.toString('base64'));
    expect(dimensions).toEqual([64, 64]);
    await page.getByRole('button', { name: 'New batch', exact: true }).click();
    await page.getByLabel('Choose files', { exact: true }).setInputFiles([
      { name: 'offline.png', mimeType: 'image/png', buffer: png() },
      { name: 'local.txt', mimeType: 'text/plain', buffer: Buffer.from('local only') },
    ]);
    await page.getByRole('button', { name: 'Smash into ZIP', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Download ZIP', exact: true })).toBeVisible({
      timeout: 30000,
    });
    promise = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download ZIP', exact: true }).click();
    d = await promise;
    const zip = unzipSync(new Uint8Array(await readFile((await d.path())!)));
    expect(Object.keys(zip)).toEqual(['offline.png', 'local.txt']);
    expect(Buffer.from(zip['local.txt']!).toString()).toBe('local only');
    await page.getByText('Statistics & freshness', { exact: true }).click();
    await expect(page.getByText('Counters last changed:', { exact: false })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('offline-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    await page.screenshot({ path: testInfo.outputPath('offline-mobile.png'), fullPage: true });
    expect(writes).toEqual([]);
    expect(errors).toEqual([]);
    expect(statsRequests).toBe(1);
  } finally {
    await server.close();
  }
});

test('failed offline preparation never claims readiness and retains local processing', async ({
  page,
}) => {
  const server = await offlineServer(stats, true);
  try {
    await page.goto(server.origin);
    await page.getByRole('button', { name: 'Prepare offline use', exact: true }).click();
    await expect(page.getByText('Could not prepare offline assets.', { exact: false })).toBeVisible(
      {
        timeout: 30000,
      }
    );
    const ready = await page.evaluate(async () => {
      for (const key of await caches.keys()) {
        if (
          key.startsWith('bebismash-assets-') &&
          (await (await caches.open(key)).match('/__offline_ready__'))
        )
          return true;
      }
      return false;
    });
    expect(ready).toBe(false);
    server.setFailEngine(false);
    await page.getByLabel('Choose files', { exact: true }).setInputFiles({
      name: 'still-local.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('local'),
    });
    await page.getByRole('button', { name: 'Compress file', exact: true }).click();
    await expect(page.getByRole('main').getByRole('status')).toContainText(
      'Original retained. No duplicate saved.'
    );
  } finally {
    await server.close();
  }
});
