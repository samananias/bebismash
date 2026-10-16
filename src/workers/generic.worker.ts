/// <reference lib="webworker" />
import type { WorkerCommand, WorkerEvent, EntryData, EntryControl } from '../core/types';

let isCancelled = false;

function emitWorkerEvent(event: WorkerEvent): void {
  postMessage(event);
}

self.onmessage = async (e: MessageEvent<WorkerCommand>) => {
  const cmd = e.data;
  if (!cmd || cmd.version !== 1) return;

  if (cmd.type === 'cancel') {
    isCancelled = true;
    return;
  }

  if (cmd.type === 'start') {
    isCancelled = false;
    const { batchId, jobId, attemptId, source, outputPort } = cmd;
    const startTime = performance.now();
    const totalBytes = source.size;

    emitWorkerEvent({
      version: 1,
      batchId,
      jobId,
      attemptId,
      type: 'ready',
    });

    const extMatch = source.name.match(/\.([a-zA-Z0-9]+)$/);
    const extension = extMatch ? extMatch[1]!.toLowerCase() : 'bin';

    let offset = 0;
    let seq = 0;

    outputPort.onmessage = async (portEvent: MessageEvent<EntryControl>) => {
      const ctrl = portEvent.data;
      if (!ctrl || ctrl.version !== 1) return;

      if (ctrl.type === 'credit') {
        if (isCancelled) {
          outputPort.postMessage({
            version: 1,
            batchId,
            jobId,
            attemptId,
            type: 'entry-abort',
            entryId: ctrl.entryId,
            error: {
              code: 'CANCELLED',
              retryable: false,
              messageKey: 'job_cancelled',
            },
          });
          outputPort.close();
          return;
        }

        const maxBytes = ctrl.maxBytes || 256 * 1024;
        const sliceLength = Math.min(totalBytes - offset, maxBytes);
        const isFinal = offset + sliceLength >= totalBytes;

        const slice = source.slice(offset, offset + sliceLength);
        const buffer = await slice.arrayBuffer();

        const entryChunk: EntryData = {
          version: 1,
          batchId,
          jobId,
          attemptId,
          type: 'entry-chunk',
          entryId: ctrl.entryId,
          seq,
          chunk: {
            buffer,
            byteLength: buffer.byteLength,
          },
          final: isFinal,
        };

        // Transfer buffer to prevent cloning
        outputPort.postMessage(entryChunk, [buffer]);

        offset += sliceLength;
        seq++;

        // Emit progress
        emitWorkerEvent({
          version: 1,
          batchId,
          jobId,
          attemptId,
          type: 'progress',
          seq,
          stage: 'pack',
          completed: offset,
          total: totalBytes,
          unit: 'bytes',
        });

        if (isFinal) {
          const durationMs = Math.max(0, Math.round(performance.now() - startTime));
          emitWorkerEvent({
            version: 1,
            batchId,
            jobId,
            attemptId,
            type: 'result',
            disposition: 'original',
            outputBytes: totalBytes,
            mime: source.type || 'application/octet-stream',
            extension,
            durationMs,
          });
        }
      }
    };

    outputPort.start();
  }
};
