import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { zipSync } from 'fflate';
import { inflateRawSync } from 'node:zlib';
import {
  Input,
  BufferSource,
  ALL_FORMATS,
  Output,
  BufferTarget,
  WebMOutputFormat,
  EncodedVideoPacketSource,
  EncodedPacketSink,
} from 'mediabunny';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/stats', (route) =>
    route.fulfill({ json: { total_files_smashed: 0, total_bytes_saved: 0 } })
  );
});

test('range-read video transcode produces a smaller independently playable file', async ({
  page,
}) => {
  test.setTimeout(60000);
  const uploads: string[] = [];
  const diagnostics: string[] = [];
  page.on('console', (message) => {
    if (message.text().startsWith('Video validation')) diagnostics.push(message.text());
  });
  page.on('request', (request) => {
    if (request.method() !== 'GET') uploads.push(request.url());
  });
  await page.route('**/assets/video.worker-*.js', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: `const report = self.postMessage.bind(self); self.postMessage = (m, ...args) => { if(m.type === 'status' && m.detail.startsWith('Video validation')) console.log(m.detail); return report(m, ...args); }; File.prototype.arrayBuffer = () => { throw new Error('Whole input read forbidden'); }; self.addEventListener('message', e => { if(e.data.type === 'start' && e.data.source.name === 'capped.webm') e.data.config.limits.maxOutputBytes = 1024; });\n${await response.text()}`,
    });
  });
  await page.goto('/');
  const source = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext('2d')!;
    const stream = canvas.captureStream(15);
    const recorder = new MediaRecorder(stream, {
      mimeType: 'video/webm;codecs=vp8',
      videoBitsPerSecond: 4_000_000,
    });
    const parts: Blob[] = [];
    recorder.ondataavailable = ({ data }) => parts.push(data);
    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    let seed = 99;
    const draw = () => {
      const image = context.createImageData(320, 180);
      for (let i = 0; i < image.data.length; i += 4) {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        image.data[i] = seed & 255;
        image.data[i + 1] = (seed >>> 8) & 255;
        image.data[i + 2] = (seed >>> 16) & 255;
        image.data[i + 3] = 255;
      }
      context.putImageData(image, 0, 0);
    };
    draw();
    recorder.start();
    const timer = setInterval(draw, 65);
    await new Promise((resolve) => setTimeout(resolve, 2200));
    recorder.stop();
    clearInterval(timer);
    await stopped;
    stream.getTracks().forEach((track) => track.stop());
    const bytes = new Uint8Array(await new Blob(parts).arrayBuffer());
    let text = '';
    for (const byte of bytes) text += String.fromCharCode(byte);
    return btoa(text);
  });
  // MediaRecorder omits a final frame duration on some browsers. Declare the synthetic
  // fixture's capture cadence when muxing so this test exercises a complete transcode.
  // Raw recording preservation is covered separately by the native video/ZIP cases.
  const recorded = new Input({
    source: new BufferSource(Uint8Array.from(Buffer.from(source, 'base64'))),
    formats: ALL_FORMATS,
  });
  const track = (await recorded.getPrimaryVideoTrack())!;
  const target = new BufferTarget();
  const mux = new Output({ target, format: new WebMOutputFormat() });
  const packets = new EncodedVideoPacketSource('vp8');
  mux.addVideoTrack(packets, { frameRate: 15 });
  try {
    await mux.start();
    const decoderConfig = (await track.getDecoderConfig())!;
    for await (const packet of new EncodedPacketSink(track).packets())
      await packets.add(packet, { decoderConfig });
    packets.close();
    await mux.finalize();
  } finally {
    recorded.dispose();
  }
  const input = Buffer.from(target.buffer!);
  await page
    .getByLabel('Choose files', { exact: true })
    .setInputFiles({ name: 'noise.webm', mimeType: 'video/webm', buffer: input });
  await page.getByRole('button', { name: 'Compress file' }).click();
  await expect(page.getByRole('link', { name: 'Download file' }))
    .toBeVisible({ timeout: 30000 })
    .catch((error) => {
      throw new Error(`${error}\n${diagnostics.join('\n')}`);
    });
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download file' }).click();
  const output = await readFile((await (await download).path())!);
  expect(output.length).toBeLessThan(input.length);
  const dimensions = await page.evaluate(async (base64) => {
    const url = URL.createObjectURL(
      new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: 'video/webm' })
    );
    const video = document.createElement('video');
    try {
      await new Promise<void>((resolve, reject) => {
        video.onloadeddata = () => resolve();
        video.onerror = () => reject(new Error('Independent browser decode failed'));
        video.src = url;
        video.load();
      });
      return [video.videoWidth, video.videoHeight];
    } finally {
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
    }
  }, output.toString('base64'));
  expect(dimensions).toEqual([320, 180]);
  await page.getByRole('button', { name: 'New batch' }).click();
  await page
    .getByLabel('Choose files', { exact: true })
    .setInputFiles({ name: 'capped.webm', mimeType: 'video/webm', buffer: input });
  await page.getByRole('button', { name: 'Gentle', exact: true }).click();
  await page.getByRole('button', { name: 'Compress file' }).click();
  await expect(page.getByRole('main').getByRole('status')).toContainText(
    'Original retained. No duplicate saved.'
  );
  await expect(page.locator('.file-row')).toContainText('safe memory budget');
  await expect(page.getByRole('link', { name: 'Download file' })).toHaveCount(0);
  expect(uploads).toEqual([]);
});

test('disk picker keeps a typed name and unchanged results never open a writable', async ({
  page,
}) => {
  const uploads: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET') uploads.push(request.url());
  });
  await page.addInitScript(() => {
    Object.assign(window, {
      pickerOptions: null,
      writesOpened: 0,
      showSaveFilePicker: async (options: unknown) => {
        Object.assign(window, { pickerOptions: options });
        return {
          createWritable: async () => {
            Object.assign(window, { writesOpened: 1 });
            throw new Error('Unchanged output must never open a writable');
          },
        };
      },
    });
  });
  await page.goto('/');
  await page.getByLabel('Choose files', { exact: true }).setInputFiles({
    name: 'source.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('private source'),
  });
  await page.getByRole('button', { name: 'Save file to disk', exact: true }).click();
  await expect(page.getByRole('main').getByRole('status')).toContainText(
    'Original retained. No duplicate saved.'
  );
  await expect(page.getByRole('link', { name: 'Download file' })).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as { writesOpened: number }).writesOpened)
  ).toBe(0);
  expect(
    await page.evaluate(() => (window as unknown as { pickerOptions: unknown }).pickerOptions)
  ).toEqual({
    suggestedName: 'source.txt',
    types: [{ description: 'TXT file', accept: { 'text/plain': ['.txt'] } }],
  });
  await page.getByRole('button', { name: 'New batch' }).focus();
  await expect(page.getByRole('button', { name: 'New batch' })).toBeFocused();
  expect(uploads).toEqual([]);
});

for (const gentle of [false, true])
  test(`Office preserves XML and validates embedded JPEG dimensions (gentle=${gentle})`, async ({
    page,
  }) => {
    const uploads: string[] = [];
    page.on('request', (request) => {
      if (request.method() !== 'GET') uploads.push(request.url());
    });
    await page.goto('/');
    const jpeg = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 1600;
      canvas.height = 900;
      const context = canvas.getContext('2d')!;
      const image = context.createImageData(canvas.width, canvas.height);
      let seed = 77;
      for (let i = 0; i < image.data.length; i += 4) {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        image.data[i] = seed & 255;
        image.data[i + 1] = (seed >>> 8) & 255;
        image.data[i + 2] = (seed >>> 16) & 255;
        image.data[i + 3] = 255;
      }
      context.putImageData(image, 0, 0);
      return canvas.toDataURL('image/jpeg', 0.99).split(',')[1]!;
    });
    const browserJpeg = Buffer.from(jpeg, 'base64');
    // Eligible synthetic raster: remove browser-injected ICC/EXIF/IPTC segments.
    // Production keeps such images opaque; this fixture exercises the resize path itself.
    const segments = [browserJpeg.subarray(0, 2)];
    for (let offset = 2; offset < browserJpeg.length;) {
      const marker = browserJpeg[offset + 1];
      if (marker === 0xda) {
        segments.push(browserJpeg.subarray(offset));
        break;
      }
      const end = offset + 2 + browserJpeg.readUInt16BE(offset + 2);
      if (![0xe1, 0xe2, 0xed].includes(marker!)) segments.push(browserJpeg.subarray(offset, end));
      offset = end;
    }
    const media = Buffer.concat(segments);
    const xml = new TextEncoder().encode(
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${'Preserve this text '.repeat(2000)}</w:t></w:r></w:p></w:body></w:document>`
    );
    const types = new TextEncoder().encode(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="jpg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
    );
    const input = zipSync(
      { '[Content_Types].xml': types, 'word/document.xml': xml, 'word/media/photo.jpg': media },
      { level: 0 }
    );
    await page.getByLabel('Choose files', { exact: true }).setInputFiles({
      name: 'photos.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: Buffer.from(input),
    });
    await page.getByRole('button', { name: gentle ? 'Gentle' : 'Heavy', exact: true }).click();
    await page.getByRole('button', { name: 'Compress file' }).click();
    await expect(page.getByRole('link', { name: 'Download file' })).toBeVisible({ timeout: 30000 });
    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download file' }).click();
    const output = await readFile((await (await download).path())!);
    expect(output.length).toBeLessThan(input.byteLength);
    // Independent ZIP extraction: Node's zlib, rather than the production fflate inflater.
    const entries: Record<string, Buffer> = {};
    for (let offset = 0; output.readUInt32LE(offset) === 0x04034b50;) {
      const method = output.readUInt16LE(offset + 8),
        size = output.readUInt32LE(offset + 18);
      const nameLength = output.readUInt16LE(offset + 26),
        extra = output.readUInt16LE(offset + 28);
      const name = output.subarray(offset + 30, offset + 30 + nameLength).toString();
      const start = offset + 30 + nameLength + extra;
      const bytes = output.subarray(start, start + size);
      entries[name] = method === 8 ? inflateRawSync(bytes) : bytes;
      offset = start + size;
    }
    expect(entries['word/document.xml']).toEqual(Buffer.from(xml));
    expect(entries['[Content_Types].xml']).toEqual(Buffer.from(types));
    const result = entries['word/media/photo.jpg']!;
    if (gentle) expect(result).toEqual(media);
    const dimensions = await page.evaluate(async (base64) => {
      const image = await createImageBitmap(
        new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: 'image/jpeg' })
      );
      const dimensions = [image.width, image.height];
      image.close();
      return dimensions;
    }, result.toString('base64'));
    expect(dimensions).toEqual(gentle ? [1600, 900] : [1280, 720]);
    expect(uploads).toEqual([]);
  });
