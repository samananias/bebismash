import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BatchScheduler } from './scheduler';
import type { WorkerCommand, WorkerEvent, ZipCommand, ZipEvent } from '../core/types';
import type { IArchiveSink } from './sink';
class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage?: (event: { data: WorkerEvent | ZipEvent }) => void;
  onerror?: (event: { preventDefault: () => void; message: string }) => void;
  onmessageerror?: () => void;
  terminate = vi.fn();
  commands: (WorkerCommand | ZipCommand)[] = [];
  constructor(public url: URL) {
    FakeWorker.all.push(this);
  }
  postMessage(cmd: WorkerCommand | ZipCommand) {
    this.commands.push(cmd);
    if (cmd.type === 'open')
      queueMicrotask(() => this.receive({ version: 1, batchId: cmd.batchId, type: 'zip-ready' }));
  }
  receive(data: WorkerEvent | ZipEvent) {
    this.onmessage?.({ data });
  }
}
const sink = (): IArchiveSink => ({
  open: vi.fn().mockResolvedValue(undefined),
  write: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue({ kind: 'disk', name: 'test.zip', bytes: 120 }),
  abort: vi.fn().mockResolvedValue(undefined),
});
async function started() {
  await vi.waitFor(() => expect(FakeWorker.all).toHaveLength(2));
  const zip = FakeWorker.all[0]!;
  const worker = FakeWorker.all[1]!;
  const cmd = worker.commands[0] as Extract<WorkerCommand, { type: 'start' }>;
  const ids = {
    version: 1 as const,
    batchId: cmd.batchId,
    jobId: cmd.jobId,
    attemptId: cmd.attemptId,
  };
  return { zip, worker, cmd, ids };
}
async function packSecond(zip: FakeWorker) {
  await vi.waitFor(() => expect(FakeWorker.all).toHaveLength(3));
  const worker = FakeWorker.all[2]!;
  const cmd = worker.commands[0] as Extract<WorkerCommand, { type: 'start' }>;
  worker.receive({
    version: 1,
    batchId: cmd.batchId,
    jobId: cmd.jobId,
    attemptId: cmd.attemptId,
    type: 'result',
    disposition: 'original',
    outputBytes: 6,
    mime: 'text/plain',
    extension: 'txt',
    durationMs: 1,
  });
  zip.receive({
    version: 1,
    batchId: cmd.batchId,
    type: 'entry-packed',
    entryId: cmd.jobId,
    inputBytes: 6,
  });
  cmd.outputPort.close();
}

describe('scheduler result, packing, failure and cancellation lifecycle', () => {
  beforeEach(() => {
    FakeWorker.all = [];
    vi.stubGlobal('Worker', FakeWorker);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  it('keeps producer alive after result and waits for entry-packed and sink close', async () => {
    const scheduler = new BatchScheduler();
    const output = sink();
    const pending = scheduler.processBatch(
      [new File(['hello'], 'test.txt'), new File(['second'], 'second.txt')],
      'balanced',
      output,
      ['stable-id']
    );
    const { worker, zip, cmd, ids } = await started();
    expect(ids.jobId).toBe('stable-id');
    worker.receive({
      ...ids,
      type: 'result',
      disposition: 'original',
      outputBytes: 5,
      mime: 'text/plain',
      extension: 'txt',
      durationMs: 10,
    });
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(output.close).not.toHaveBeenCalled();
    expect(zip.commands.at(-1)?.type).toBe('add');
    zip.receive({
      version: 1,
      batchId: ids.batchId,
      type: 'entry-packed',
      entryId: ids.jobId,
      inputBytes: 5,
    });
    await vi.waitFor(() => expect(worker.terminate).toHaveBeenCalledOnce());
    await packSecond(zip);
    zip.receive({
      version: 1,
      batchId: ids.batchId,
      type: 'zip-complete',
      archiveBytes: 120,
      entries: 1,
    });
    expect((await pending).results[0]?.compressedBytes).toBe(5);
    expect(output.close).toHaveBeenCalledOnce();
    cmd.outputPort.close();
  });
  it('settles rejection and resets the scheduler when sink close fails', async () => {
    const scheduler = new BatchScheduler();
    const output = sink();
    vi.mocked(output.close).mockRejectedValue(new Error('disk full'));
    const pending = scheduler.processBatch(
      [new File(['a'], 'a'), new File(['second'], 'second.txt')],
      'balanced',
      output
    );
    const assertion = expect(pending).rejects.toThrow('disk full');
    const { worker, zip, cmd, ids } = await started();
    worker.receive({
      ...ids,
      type: 'result',
      disposition: 'original',
      outputBytes: 1,
      mime: 'text/plain',
      extension: 'txt',
      durationMs: 1,
    });
    zip.receive({
      version: 1,
      batchId: ids.batchId,
      type: 'entry-packed',
      entryId: ids.jobId,
      inputBytes: 1,
    });
    await packSecond(zip);
    zip.receive({
      version: 1,
      batchId: ids.batchId,
      type: 'zip-complete',
      archiveBytes: 1,
      entries: 1,
    });
    await assertion;
    expect(output.abort).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalled();
    cmd.outputPort.close();
  });
  it.each(['crash', 'messageerror', 'cancel'] as const)(
    'settles %s and terminates workers',
    async (failure) => {
      const scheduler = new BatchScheduler();
      const output = sink();
      const pending = scheduler.processBatch(
        [new File(['a'], 'a'), new File(['second'], 'second.txt')],
        'balanced',
        output
      );
      const assertion = expect(pending).rejects.toThrow(
        failure === 'cancel' ? 'cancelled' : failure === 'crash' ? 'crashed' : 'decoded'
      );
      const { worker, zip, cmd } = await started();
      if (failure === 'crash') worker.onerror?.({ preventDefault() {}, message: 'crashed' });
      else if (failure === 'messageerror') worker.onmessageerror?.();
      else await scheduler.cancel();
      await assertion;
      expect(worker.terminate).toHaveBeenCalled();
      expect(zip.terminate).toHaveBeenCalled();
      expect(output.abort).toHaveBeenCalledOnce();
      cmd.outputPort.close();
    }
  );
  it('recovers from sink open failure without keeping a batch locked', async () => {
    const scheduler = new BatchScheduler();
    const output = sink();
    vi.mocked(output.open).mockRejectedValue(new Error('cannot open'));
    await expect(
      scheduler.processBatch(
        [new File(['a'], 'a'), new File(['second'], 'second.txt')],
        'balanced',
        output
      )
    ).rejects.toThrow('cannot open');
    await expect(
      scheduler.processBatch(
        [new File(['a'], 'a'), new File(['second'], 'second.txt')],
        'balanced',
        output
      )
    ).rejects.toThrow('cannot open');
  });
  it('refuses a 300 MB video before whole-file allocation on Blob output', async () => {
    const scheduler = new BatchScheduler();
    // Synthetic File handle: size alone exercises admission without allocating 300 MB.
    const file = new File(
      [new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0])],
      'large.mp4'
    );
    Object.defineProperty(file, 'size', { value: 300 * 1024 * 1024 });
    await expect(scheduler.processBatch([file], 'balanced')).rejects.toThrow('archive limit');
    expect(FakeWorker.all).toHaveLength(0);
  });
  it.each([50, 300])(
    'routes a %i MB video beyond the working budget to bounded original disk packaging',
    async (size) => {
      const scheduler = new BatchScheduler();
      const output = sink();
      const file = new File(
        [new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0])],
        'video.mp4'
      );
      Object.defineProperty(file, 'size', { value: size * 1024 * 1024 });
      const pending = scheduler.processBatch([file], 'balanced', output);
      const assertion = expect(pending).rejects.toThrow('cancelled');
      await vi.waitFor(() => expect(FakeWorker.all).toHaveLength(1));
      const worker = FakeWorker.all[0]!;
      const cmd = worker.commands[0] as Extract<WorkerCommand, { type: 'start' }>;
      expect(worker.url.pathname).toContain('generic.worker');
      expect(cmd.source).toBe(file);
      expect(cmd.config.engine).toBe('generic');
      await scheduler.cancel();
      await assertion;
      cmd.outputPort.close();
    }
  );
  it.each([false, true])(
    'saves one file directly and handles close failure (failure=%s)',
    async (closeFails) => {
      const scheduler = new BatchScheduler();
      const output = sink();
      if (closeFails) vi.mocked(output.close).mockRejectedValueOnce(new Error('disk full'));
      const filename = closeFails ? 'direct.txt' : `${'long-name-'.repeat(35)}.txt`;
      const pending = scheduler.processBatch([new File(['hello'], filename)], 'balanced', output);
      const assertion = closeFails
        ? expect(pending).rejects.toThrow('disk full')
        : expect(pending).resolves.toMatchObject({ packaging: 'file' });
      await vi.waitFor(() => expect(FakeWorker.all).toHaveLength(1));
      const worker = FakeWorker.all[0]!;
      expect(worker.url.pathname).not.toContain('zip.worker');
      const cmd = worker.commands[0] as Extract<WorkerCommand, { type: 'start' }>;
      cmd.outputPort.onmessage = ({ data: credit }) => {
        const buffer = new TextEncoder().encode('hello').buffer;
        cmd.outputPort.postMessage(
          {
            version: 1,
            batchId: cmd.batchId,
            jobId: cmd.jobId,
            attemptId: cmd.attemptId,
            entryId: credit.entryId,
            type: 'entry-chunk',
            seq: 0,
            chunk: { buffer, byteLength: 5 },
            final: true,
          },
          [buffer]
        );
      };
      worker.receive({
        version: 1,
        batchId: cmd.batchId,
        jobId: cmd.jobId,
        attemptId: cmd.attemptId,
        type: 'result',
        disposition: 'original',
        outputBytes: 5,
        mime: 'text/plain',
        extension: 'txt',
        durationMs: 1,
      });
      expect(worker.terminate).not.toHaveBeenCalled();
      await assertion;
      expect(output.open).toHaveBeenCalledWith(expect.stringMatching(/\.txt$/), 'text/plain');
      expect(vi.mocked(output.open).mock.calls[0]![0].length).toBeLessThanOrEqual(220);
      expect(output.write).toHaveBeenCalledOnce();
      expect(worker.terminate).toHaveBeenCalled();
      cmd.outputPort.close();
    }
  );
});
