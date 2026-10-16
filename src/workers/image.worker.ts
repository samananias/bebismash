/// <reference lib="webworker" />
import type {
  WorkerCommand,
  WorkerEvent,
  EntryData,
  EntryControl,
  ImagePolicy,
} from '../core/types';
import { parseImageMeta, scaleImageData } from '../codecs/parser';

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

    const extMatch = source.name.match(/\.([a-zA-Z0-9]+)$/);
    const originalExt = extMatch ? extMatch[1]!.toLowerCase() : 'jpg';
    let outputMime: string;
    let outputExt: string;

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

      // 1. Preflight bounded inspection (first 1 MiB max)
      const headerLength = Math.min(sourceSize, 1024 * 1024);
      const headerSlice = source.slice(0, headerLength);
      const headerBuffer = await headerSlice.arrayBuffer();
      const meta = parseImageMeta(headerBuffer);

      let finalBuffer: ArrayBuffer | null = null;
      let disposition: 'transformed' | 'original' = 'original';

      // Fallback to original if animated or if limits exceeded
      const exceedsPixels =
        meta.width > 0 && meta.height > 0 && meta.width * meta.height > config.limits.maxPixels;

      const shouldPreserve = meta.isAnimated || exceedsPixels || isCancelled;

      if (!shouldPreserve && config.policy.kind === 'image') {
        const imagePolicy = config.policy as ImagePolicy;

        emitWorkerEvent({
          version: 1,
          batchId,
          jobId,
          attemptId,
          type: 'progress',
          seq: 2,
          stage: 'load',
          completed: Math.round(sourceSize * 0.2),
          total: sourceSize,
          unit: 'bytes',
        });

        // Dynamic import inside admitted worker job (Non-negotiable rule)
        let adapter;
        const format = config.format === 'unknown' ? meta.format : config.format;

        switch (format) {
          case 'png': {
            const { pngAdapter } = await import('../codecs/png');
            adapter = pngAdapter;
            outputMime = 'image/png';
            outputExt = 'png';
            break;
          }
          case 'webp': {
            const { webpAdapter } = await import('../codecs/webp');
            adapter = webpAdapter;
            outputMime = 'image/webp';
            outputExt = 'webp';
            break;
          }
          case 'avif': {
            const { avifAdapter } = await import('../codecs/avif');
            adapter = avifAdapter;
            outputMime = 'image/avif';
            outputExt = 'avif';
            break;
          }
          case 'jpeg':
          default: {
            const { jpegAdapter } = await import('../codecs/jpeg');
            adapter = jpegAdapter;
            outputMime = 'image/jpeg';
            outputExt = 'jpg';
            break;
          }
        }

        if (isCancelled) throw new Error('Cancelled');

        emitWorkerEvent({
          version: 1,
          batchId,
          jobId,
          attemptId,
          type: 'progress',
          seq: 3,
          stage: 'decode',
          completed: Math.round(sourceSize * 0.4),
          total: sourceSize,
          unit: 'bytes',
        });

        const fullSourceBuffer = await source.arrayBuffer();
        if (isCancelled) throw new Error('Cancelled');

        let candidate: ArrayBuffer | null = null;

        // Try direct lossless PNG optimization if applicable
        if (format === 'png' && adapter.optimize) {
          try {
            const opt = await adapter.optimize(fullSourceBuffer, imagePolicy);
            if (opt && opt.byteLength < fullSourceBuffer.byteLength) {
              candidate = opt;
            }
          } catch {
            // fallback to decode/encode
          }
        }

        if (!candidate) {
          const decoded = await adapter.decode(fullSourceBuffer);
          if (isCancelled) throw new Error('Cancelled');

          emitWorkerEvent({
            version: 1,
            batchId,
            jobId,
            attemptId,
            type: 'progress',
            seq: 4,
            stage: 'transform',
            completed: Math.round(sourceSize * 0.6),
            total: sourceSize,
            unit: 'bytes',
          });

          // Downscale if maxEdge specified (e.g. Heavy preset)
          let target = decoded;
          if (imagePolicy.maxEdge && imagePolicy.maxEdge > 0) {
            target = scaleImageData(decoded, imagePolicy.maxEdge);
          }

          emitWorkerEvent({
            version: 1,
            batchId,
            jobId,
            attemptId,
            type: 'progress',
            seq: 5,
            stage: 'encode',
            completed: Math.round(sourceSize * 0.8),
            total: sourceSize,
            unit: 'bytes',
          });

          candidate = await adapter.encode(target, imagePolicy);
        }

        // Section 4.2 / Section 3.2: Staging comparison
        // If candidate is smaller than original, keep transformed; otherwise preserve original byte-identical
        if (candidate && candidate.byteLength < sourceSize) {
          disposition = 'transformed';
          finalBuffer = candidate;
        } else {
          disposition = 'original';
          finalBuffer = fullSourceBuffer;
          outputMime = source.type || outputMime;
          outputExt = originalExt;
        }
      } else {
        // Preserved as original
        disposition = 'original';
        finalBuffer = await source.arrayBuffer();
        outputMime = source.type || 'image/jpeg';
        outputExt = originalExt;
      }

      if (!finalBuffer) {
        finalBuffer = await source.arrayBuffer();
      }

      const outputBytes = finalBuffer.byteLength;
      const durationMs = Math.max(0, Math.round(performance.now() - startTime));

      emitWorkerEvent({
        version: 1,
        batchId,
        jobId,
        attemptId,
        type: 'result',
        disposition,
        outputBytes,
        mime: outputMime,
        extension: outputExt,
        durationMs,
      });

      // Stream to outputPort honoring backpressure credits
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

          // Materialize standalone slice buffer
          const sliceBuffer = finalBuffer!.slice(offset, offset + sliceLength);

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

          // Transfer buffer to prevent cloning
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
          messageKey: isCancelled ? 'job_cancelled' : 'image_processing_failed',
        },
      });
      outputPort.close();
    }
  }
};
