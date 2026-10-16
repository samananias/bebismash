/// <reference lib="webworker" />
import type {
  WorkerCommand,
  WorkerEvent,
  EntryData,
  EntryControl,
  DocumentPolicy,
} from '../core/types';
import type { ImageCodecAdapter } from '../codecs/types';
import { preflightOoxml } from '../codecs/ooxml';
import { unzipSync, zipSync } from 'fflate';

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
    const extension = extMatch ? extMatch[1]!.toLowerCase() : 'docx';
    const mime = source.type || 'application/vnd.openxmlformats-officedocument';

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

      // 1. Preflight security & bomb inspection
      const preflight = preflightOoxml(fullSourceBuffer, config.limits);

      let finalBuffer: ArrayBuffer = fullSourceBuffer;
      let disposition: 'transformed' | 'original' = 'original';

      const shouldPreserve =
        !preflight.valid ||
        preflight.isMacroEnabled ||
        preflight.isSigned ||
        preflight.isEncrypted ||
        isCancelled;

      if (!shouldPreserve && config.policy.kind === 'document') {
        const docPolicy = config.policy as DocumentPolicy;

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

        // Safe unzipping of bounded OOXML archive
        const unzipped = unzipSync(new Uint8Array(fullSourceBuffer));
        if (isCancelled) throw new Error('Cancelled');

        emitWorkerEvent({
          version: 1,
          batchId,
          jobId,
          attemptId,
          type: 'progress',
          seq: 3,
          stage: 'transform',
          completed: Math.round(sourceSize * 0.5),
          total: sourceSize,
          unit: 'bytes',
        });

        // Scan for media files in word/media/, ppt/media/, xl/media/
        const mediaEntries = Object.keys(unzipped).filter((path) =>
          /\bmedia\/[^/]+\.(png|jpe?g)$/i.test(path)
        );

        if (mediaEntries.length > 0) {
          // Dynamic import of adapters inside admitted worker job
          let pngAdapter: ImageCodecAdapter | null = null;
          let jpegAdapter: ImageCodecAdapter | null = null;

          for (const mediaPath of mediaEntries) {
            if (isCancelled) break;
            const entryBytes = unzipped[mediaPath];
            if (!entryBytes || entryBytes.byteLength === 0) continue;

            const isPng = /\.png$/i.test(mediaPath);
            const isJpeg = /\.jpe?g$/i.test(mediaPath);

            try {
              if (isPng) {
                if (!pngAdapter) {
                  const mod = await import('../codecs/png');
                  pngAdapter = mod.pngAdapter;
                }
                const opt = await pngAdapter.optimize!(entryBytes.buffer, docPolicy.image);
                if (opt && opt.byteLength < entryBytes.byteLength) {
                  unzipped[mediaPath] = new Uint8Array(opt);
                }
              } else if (isJpeg) {
                if (!jpegAdapter) {
                  const mod = await import('../codecs/jpeg');
                  jpegAdapter = mod.jpegAdapter;
                }
                const decoded = await jpegAdapter.decode(entryBytes.buffer);
                const encoded = await jpegAdapter.encode(decoded, docPolicy.image);
                if (encoded && encoded.byteLength < entryBytes.byteLength) {
                  unzipped[mediaPath] = new Uint8Array(encoded);
                }
              }
            } catch {
              // Retain original media entry if transformation fails
            }
          }
        }

        emitWorkerEvent({
          version: 1,
          batchId,
          jobId,
          attemptId,
          type: 'progress',
          seq: 4,
          stage: 'pack',
          completed: Math.round(sourceSize * 0.8),
          total: sourceSize,
          unit: 'bytes',
        });

        // Repack with fflate zipSync using specified deflate level (6 or 9)
        const deflateLevel = docPolicy.deflateLevel || 6;
        const repacked = zipSync(unzipped, { level: deflateLevel });

        if (repacked.byteLength < sourceSize) {
          disposition = 'transformed';
          finalBuffer = repacked.buffer.slice(
            repacked.byteOffset,
            repacked.byteOffset + repacked.byteLength
          );
        } else {
          disposition = 'original';
          finalBuffer = fullSourceBuffer;
        }
      } else {
        disposition = 'original';
        finalBuffer = fullSourceBuffer;
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
        mime,
        extension,
        durationMs,
      });

      // Stream to outputPort
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
          messageKey: isCancelled ? 'job_cancelled' : 'office_processing_failed',
        },
      });
      outputPort.close();
    }
  }
};
