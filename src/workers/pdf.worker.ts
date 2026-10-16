/// <reference lib="webworker" />
import type {
  WorkerCommand,
  WorkerEvent,
  EntryData,
  EntryControl,
  DocumentPolicy,
} from '../core/types';
import { rewritePdf } from '../codecs/pdf';

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
    const { batchId, jobId, attemptId, source, config, outputPort } = cmd;
    const startTime = performance.now();
    const sourceSize = source.size;

    emitWorkerEvent({
      version: 1,
      batchId,
      jobId,
      attemptId,
      type: 'ready',
    });

    try {
      emitWorkerEvent({
        version: 1,
        batchId,
        jobId,
        attemptId,
        type: 'progress',
        seq: 1,
        stage: 'inspect',
        completed: 0,
        total: sourceSize,
        unit: 'bytes',
      });

      const fullSourceBuffer = await source.arrayBuffer();
      if (isCancelled) throw new Error('Cancelled');

      emitWorkerEvent({
        version: 1,
        batchId,
        jobId,
        attemptId,
        type: 'progress',
        seq: 2,
        stage: 'decode',
        completed: Math.round(sourceSize * 0.3),
        total: sourceSize,
        unit: 'bytes',
      });

      const docPolicy = (config.policy as DocumentPolicy) || {
        kind: 'document',
        image: {
          kind: 'image',
          quality: 75,
          lossless: false,
          maxEdge: null,
          quantizeColors: null,
          oxipngLevel: 3,
          allowFormatChange: false,
        },
        deflateLevel: 6,
        pdfMode: 'rewrite',
        targetDpi: null,
      };

      const rewriteResult = await rewritePdf(fullSourceBuffer, docPolicy, config.limits);
      if (isCancelled) throw new Error('Cancelled');

      emitWorkerEvent({
        version: 1,
        batchId,
        jobId,
        attemptId,
        type: 'progress',
        seq: 3,
        stage: 'encode',
        completed: Math.round(sourceSize * 0.8),
        total: sourceSize,
        unit: 'bytes',
      });

      const finalBuffer = rewriteResult.buffer;
      const outputBytes = finalBuffer.byteLength;
      const durationMs = Math.max(0, Math.round(performance.now() - startTime));

      emitWorkerEvent({
        version: 1,
        batchId,
        jobId,
        attemptId,
        type: 'result',
        disposition: rewriteResult.disposition,
        outputBytes,
        mime: 'application/pdf',
        extension: 'pdf',
        durationMs,
      });

      let offset = 0;
      let seq = 0;

      outputPort.onmessage = (portEvent: MessageEvent<EntryControl>) => {
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
          const sliceLength = Math.min(outputBytes - offset, maxBytes);
          const isFinal = offset + sliceLength >= outputBytes;

          const sliceBuffer = finalBuffer.slice(offset, offset + sliceLength);

          const entryChunk: EntryData = {
            version: 1,
            batchId,
            jobId,
            attemptId,
            type: 'entry-chunk',
            entryId: ctrl.entryId,
            seq,
            chunk: {
              buffer: sliceBuffer,
              byteLength: sliceBuffer.byteLength,
            },
            final: isFinal,
          };

          outputPort.postMessage(entryChunk, [sliceBuffer]);

          offset += sliceLength;
          seq++;

          emitWorkerEvent({
            version: 1,
            batchId,
            jobId,
            attemptId,
            type: 'progress',
            seq,
            stage: 'pack',
            completed: offset,
            total: outputBytes,
            unit: 'bytes',
          });

          if (isFinal) {
            outputPort.close();
          }
        }
      };

      outputPort.start();
    } catch {
      emitWorkerEvent({
        version: 1,
        batchId,
        jobId,
        attemptId,
        type: 'error',
        error: {
          code: isCancelled ? 'CANCELLED' : 'INTERNAL',
          retryable: false,
          messageKey: isCancelled ? 'job_cancelled' : 'pdf_processing_failed',
        },
      });
      outputPort.close();
    }
  }
};
