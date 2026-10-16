/// <reference lib="webworker" />
import type {
  WorkerCommand,
  WorkerEvent,
  EntryData,
  EntryControl,
  VideoPolicy,
} from '../core/types';
import { processVideo } from '../codecs/video';

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
        completed: Math.round(sourceSize * 0.2),
        total: sourceSize,
        unit: 'bytes',
      });

      const videoPolicy = (config.policy as VideoPolicy) || {
        kind: 'video',
        mode: 'remux',
        maxHeight: null,
        maxFps: null,
        webVideoBitrate: 4_000_000,
        audioBitrate: 128_000,
        ffmpegCrf: 26,
        ffmpegPreset: 'medium',
      };

      const processResult = await processVideo(
        fullSourceBuffer,
        videoPolicy,
        config.limits,
        (ratio) => {
          emitWorkerEvent({
            version: 1,
            batchId,
            jobId,
            attemptId,
            type: 'progress',
            seq: 3,
            stage: 'transform',
            completed: Math.round(sourceSize * (0.2 + ratio * 0.6)),
            total: sourceSize,
            unit: 'bytes',
          });
        }
      );

      if (isCancelled) throw new Error('Cancelled');

      emitWorkerEvent({
        version: 1,
        batchId,
        jobId,
        attemptId,
        type: 'progress',
        seq: 4,
        stage: 'encode',
        completed: Math.round(sourceSize * 0.9),
        total: sourceSize,
        unit: 'bytes',
      });

      const finalBuffer = processResult.buffer;
      const outputBytes = finalBuffer.byteLength;
      const durationMs = Math.max(0, Math.round(performance.now() - startTime));

      emitWorkerEvent({
        version: 1,
        batchId,
        jobId,
        attemptId,
        type: 'result',
        disposition: processResult.disposition,
        outputBytes,
        mime: processResult.mime,
        extension: processResult.extension,
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
          messageKey: isCancelled ? 'job_cancelled' : 'video_processing_failed',
        },
      });
      outputPort.close();
    }
  }
};
