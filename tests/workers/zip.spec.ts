import { test, expect } from '@playwright/test';
import { readdir } from 'node:fs/promises';
import { unzipSync } from 'fflate';
test('actual ZIP worker withholds producer credit and completion until sink acknowledges', async ({
  page,
}) => {
  const zipName = (await readdir('dist/assets')).find((name) => /^zip\.worker-.*\.js$/.test(name))!;
  await page.route('**/api/stats', (route) =>
    route.fulfill({ json: { total_files_smashed: 0, total_bytes_saved: 0 } })
  );
  await page.goto('/');
  const result = await page.evaluate(async (zipName) => {
    const worker = new Worker(`/assets/${zipName}`, { type: 'module' });
    const channel = new MessageChannel();
    const chunks: Uint8Array[] = [];
    let credits = 0;
    let complete = false;
    let withholding = true;
    let waitingSeq: number | null = null;
    let release!: () => void;
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finish!: () => void;
    let fail!: (error: Error) => void;
    const done = new Promise<void>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    const deadline = setTimeout(() => fail(new Error('ZIP worker did not finish')), 10000);
    worker.onerror = (event) => fail(new Error(event.message));
    worker.onmessage = ({ data: event }) => {
      if (event.type === 'zip-ready')
        worker.postMessage(
          {
            version: 1,
            batchId: 'batch',
            type: 'add',
            entry: {
              entryId: 'entry',
              jobId: 'job',
              path: 'binary.bin',
              method: 'store',
              level: 0,
              maxBytes: 512 * 1024,
            },
            entryPort: channel.port1,
          },
          [channel.port1]
        );
      else if (event.type === 'zip-chunk') {
        chunks.push(new Uint8Array(event.chunk.buffer));
        if (withholding) {
          waitingSeq = event.seq;
          release();
        } else
          worker.postMessage({ version: 1, batchId: 'batch', type: 'sink-ack', seq: event.seq });
      } else if (event.type === 'entry-packed')
        worker.postMessage({ version: 1, batchId: 'batch', type: 'finish' });
      else if (event.type === 'zip-complete') {
        complete = true;
        finish();
      } else if (event.type === 'zip-error') fail(new Error(event.error.messageKey));
    };
    channel.port2.onmessage = ({ data: credit }) => {
      credits++;
      const buffer = new Uint8Array(256 * 1024).fill(credits).buffer;
      channel.port2.postMessage(
        {
          version: 1,
          batchId: 'batch',
          jobId: 'job',
          attemptId: 'attempt',
          type: 'entry-chunk',
          entryId: 'entry',
          seq: credit.seq,
          chunk: { buffer, byteLength: buffer.byteLength },
          final: credits === 2,
        },
        [buffer]
      );
    };
    worker.postMessage({
      version: 1,
      batchId: 'batch',
      type: 'open',
      maxArchiveBytes: 1024 * 1024,
      expectedEntries: 1,
    });
    try {
      await first;
      // Deliberately hold ACK across tasks to exercise a slow sink.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const beforeAck = { credits, complete };
      withholding = false;
      worker.postMessage({ version: 1, batchId: 'batch', type: 'sink-ack', seq: waitingSeq });
      await done;
      const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return { beforeAck, credits, base64: btoa(binary) };
    } finally {
      clearTimeout(deadline);
      worker.terminate();
      channel.port2.close();
    }
  }, zipName);
  expect(result.beforeAck).toEqual({ credits: 1, complete: false });
  expect(result.credits).toBe(2);
  const file = unzipSync(Buffer.from(result.base64, 'base64'))['binary.bin']!;
  expect(file.byteLength).toBe(512 * 1024);
  expect(file[0]).toBe(1);
  expect(file[256 * 1024]).toBe(2);
});
