import type { WorkerCommand, WorkerEvent, Stage, EntryControl, EntryData } from '../core/types';
type Start = Extract<WorkerCommand, { type: 'start' }>;

/** Metadata-only liveness and stage reporting. A heartbeat never advances progress. */
export function observeJob(cmd: Start) {
  const ids = {
    version: 1 as const,
    batchId: cmd.batchId,
    jobId: cmd.jobId,
    attemptId: cmd.attemptId,
  };
  const send = (event: WorkerEvent) => postMessage(event);
  const timer = setInterval(() => send({ ...ids, type: 'heartbeat' }), 2000);
  return {
    ids,
    status: (stage: Stage, detail: string) => send({ ...ids, type: 'status', stage, detail }),
    stop: () => clearInterval(timer),
  };
}

/** Result is preparation metadata; output ownership remains here until ZIP consumes final. */
export function streamPrepared(
  cmd: Start,
  source: File | ArrayBuffer,
  result: Pick<
    Extract<WorkerEvent, { type: 'result' }>,
    'disposition' | 'outputBytes' | 'mime' | 'extension' | 'durationMs' | 'reason'
  >
) {
  const { ids, status, stop } = observeJob(cmd);
  const port = cmd.outputPort;
  let offset = 0;
  let seq = 0;
  port.onmessageerror = () => {
    stop();
    port.close();
  };
  port.onmessage = async ({ data: control }: MessageEvent<EntryControl>) => {
    if (
      control.type !== 'credit' ||
      control.batchId !== cmd.batchId ||
      control.seq !== seq ||
      control.maxBytes <= 0 ||
      control.maxBytes > 256 * 1024
    )
      return;
    try {
      const length = Math.min(control.maxBytes, result.outputBytes - offset);
      const buffer =
        source instanceof ArrayBuffer
          ? source.slice(offset, offset + length)
          : await source.slice(offset, offset + length).arrayBuffer();
      const final = offset + length === result.outputBytes;
      port.postMessage(
        {
          ...ids,
          type: 'entry-chunk',
          entryId: control.entryId,
          seq,
          chunk: { buffer, byteLength: buffer.byteLength },
          final,
        } satisfies EntryData,
        [buffer]
      );
      offset += length;
      postMessage({
        ...ids,
        type: 'progress',
        seq: ++seq,
        stage: 'pack',
        completed: offset,
        total: result.outputBytes,
        unit: 'bytes',
      } satisfies WorkerEvent);
      if (final) {
        port.close();
        stop();
      }
    } catch (error) {
      postMessage({
        ...ids,
        type: 'error',
        error: {
          code: 'INTERNAL',
          retryable: true,
          messageKey: 'output_read_failed',
          details: error instanceof Error ? error.message.slice(0, 1800) : 'File read failed',
        },
      } satisfies WorkerEvent);
      stop();
      port.close();
    }
  };
  port.start();
  status(
    'output',
    result.disposition === 'original'
      ? 'Keeping original bytes; preparing ZIP entry'
      : 'Output prepared; waiting for ZIP credit'
  );
  postMessage({ ...ids, type: 'result', ...result } satisfies WorkerEvent);
}
