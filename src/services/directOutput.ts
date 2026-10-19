import type { EntryData, EntryControl, JobEnvelope } from '../core/types';
import type { IArchiveSink } from './sink';

/** Receive one transferable chunk at a time; return credit only after the sink accepts it. */
export function writeDirectOutput(
  port: MessagePort,
  ids: JobEnvelope,
  bytes: number,
  sink: IArchiveSink,
  signal: AbortSignal,
  onWritten: (completed: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    let seq = 0;
    let completed = 0;
    let writing = false;
    let stopped = false;
    const stop = () => {
      stopped = true;
      port.close();
      signal.removeEventListener('abort', abort);
    };
    const fail = (error: unknown) => {
      stop();
      reject(error);
    };
    const abort = () => fail(new Error('File save was cancelled'));
    const credit = () =>
      port.postMessage({
        version: 1,
        batchId: ids.batchId,
        type: 'credit',
        entryId: ids.jobId,
        seq,
        maxBytes: 256 * 1024,
      } satisfies EntryControl);
    signal.addEventListener('abort', abort, { once: true });
    port.onmessageerror = () => fail(new Error('Output worker message could not be decoded'));
    port.onmessage = async ({ data: event }: MessageEvent<EntryData>) => {
      if (stopped) return;
      try {
        if (
          !event ||
          event.version !== 1 ||
          event.batchId !== ids.batchId ||
          event.jobId !== ids.jobId ||
          event.attemptId !== ids.attemptId ||
          event.entryId !== ids.jobId
        )
          throw new Error('Invalid direct output envelope');
        if (event.type === 'entry-abort') throw new Error(event.error.messageKey);
        if (
          event.type !== 'entry-chunk' ||
          writing ||
          event.seq !== seq ||
          !(event.chunk.buffer instanceof ArrayBuffer) ||
          event.chunk.byteLength !== event.chunk.buffer.byteLength ||
          event.chunk.byteLength > 256 * 1024 ||
          completed + event.chunk.byteLength > bytes ||
          (event.chunk.byteLength === 0 && !event.final)
        )
          throw new Error('Invalid direct output chunk');
        if (event.final && completed + event.chunk.byteLength !== bytes)
          throw new Error('Output size mismatch');
        writing = true;
        await sink.write(event.chunk);
        if (stopped || signal.aborted) return;
        completed += event.chunk.byteLength;
        seq++;
        writing = false;
        onWritten(completed);
        if (event.final) {
          stop();
          resolve();
        } else credit();
      } catch (error) {
        fail(error);
      }
    };
    if (signal.aborted) {
      abort();
      return;
    }
    port.start();
    credit();
  });
}
