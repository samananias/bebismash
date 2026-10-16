import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeDirectOutput } from './directOutput';
import { BlobArchiveSink } from './sink';
import type { IArchiveSink } from './sink';
import type { EntryControl, EntryData } from '../core/types';
const ids = { version: 1 as const, batchId: 'batch', jobId: 'job', attemptId: 'attempt' };
const ports: MessagePort[] = [];
afterEach(() => {
  ports.forEach((port) => port.close());
  ports.length = 0;
  vi.restoreAllMocks();
});
function output() {
  const channel = new MessageChannel();
  ports.push(channel.port1, channel.port2);
  return channel;
}
function sink(): IArchiveSink {
  return {
    open: vi.fn().mockResolvedValue(undefined),
    write: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    abort: vi.fn(),
  };
}
function send(port: MessagePort, seq: number, final: boolean) {
  const buffer = new Uint8Array([seq + 1]).buffer;
  port.postMessage(
    {
      ...ids,
      type: 'entry-chunk',
      entryId: ids.jobId,
      seq,
      chunk: { buffer, byteLength: 1 },
      final,
    } satisfies EntryData,
    [buffer]
  );
  expect(buffer.byteLength).toBe(0);
}
describe('direct output transfer and sink ownership', () => {
  it('grants the next credit only after the sink accepts the previous chunk', async () => {
    const channel = output();
    const target = sink();
    const controller = new AbortController();
    let release!: () => void;
    vi.mocked(target.write).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const credits: EntryControl[] = [];
    channel.port2.onmessage = ({ data }: MessageEvent<EntryControl>) => {
      credits.push(data);
      send(channel.port2, data.type === 'credit' ? data.seq : -1, credits.length === 2);
    };
    const progress = vi.fn();
    const pending = writeDirectOutput(channel.port1, ids, 2, target, controller.signal, progress);
    await vi.waitFor(() => expect(target.write).toHaveBeenCalledOnce());
    expect(credits).toHaveLength(1);
    expect(progress).not.toHaveBeenCalled();
    release();
    await pending;
    expect(credits).toHaveLength(2);
    expect(progress.mock.calls).toEqual([[1], [2]]);
  });
  it.each(['write failure', 'cancel'] as const)(
    'rejects %s without granting another credit',
    async (failure) => {
      const channel = output();
      const target = sink();
      const controller = new AbortController();
      const credits: EntryControl[] = [];
      vi.mocked(target.write).mockImplementation(() =>
        failure === 'cancel' ? new Promise<void>(() => {}) : Promise.reject(new Error('disk full'))
      );
      channel.port2.onmessage = ({ data }: MessageEvent<EntryControl>) => {
        credits.push(data);
        send(channel.port2, 0, false);
      };
      const pending = writeDirectOutput(channel.port1, ids, 2, target, controller.signal, vi.fn());
      const assertion = expect(pending).rejects.toThrow(
        failure === 'cancel' ? 'cancelled' : 'disk full'
      );
      await vi.waitFor(() => expect(target.write).toHaveBeenCalledOnce());
      if (failure === 'cancel') controller.abort();
      await assertion;
      expect(credits).toHaveLength(1);
    }
  );
  it('keeps the output filename and MIME when building a direct download', async () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:output');
    const target = new BlobArchiveSink(1024);
    await target.open('photo.png', 'image/png');
    const buffer = new Uint8Array([137, 80, 78, 71]).buffer;
    await target.write({ buffer, byteLength: 4 });
    const result = await target.close();
    expect(result.name).toBe('photo.png');
    expect(create.mock.calls[0]?.[0]).toMatchObject({ type: 'image/png', size: 4 });
    await target.abort();
  });
});
