/// <reference lib="webworker" />
import type { WorkerCommand, WorkerEvent, DocumentPolicy } from '../core/types';
import { parseImageMeta, scaleImageData } from '../codecs/parser';
import type { ImageCodecAdapter } from '../codecs/types';

import { observeJob, streamPrepared } from './jobRuntime';
import { observeEngineDownloads } from './engineDownloads';
import { canReencodeOfficeJpeg } from '../codecs/officeImage';
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
    const observation = observeJob(cmd);
    const loading = observeEngineDownloads(cmd);
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
        total: null,
        unit: 'bytes',
      });

      observation.status('load', 'Loading Office archive engine');
      const { preflightOoxml } = await import('../codecs/ooxml');
      const { unzipSync, zipSync } = await import('fflate');
      observation.status('read', 'Reading document into reserved memory');
      if (source.size > config.limits.maxInputBytes)
        throw new Error('Document exceeds reserved input memory');
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
          completed: 0,
          total: null,
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
          completed: 0,
          total: null,
          unit: 'bytes',
        });

        // Scan for media files in word/media/, ppt/media/, xl/media/
        const mediaEntries = Object.keys(unzipped).filter((path) =>
          /^(word|ppt|xl)\/media\/[^/]+\.(png|jpe?g)$/i.test(path)
        );

        if (mediaEntries.length > 0) {
          // Dynamic import of adapters inside admitted worker job
          let pngAdapter: ImageCodecAdapter | null = null;
          let jpegAdapter: ImageCodecAdapter | null = null;

          for (const mediaPath of mediaEntries) {
            if (isCancelled) break;
            const entryBytes = unzipped[mediaPath];
            if (!entryBytes || entryBytes.byteLength === 0) continue;

            const meta = parseImageMeta(entryBytes.buffer);
            if (
              meta.isAnimated ||
              meta.width <= 0 ||
              meta.height <= 0 ||
              meta.width * meta.height > config.limits.maxPixels ||
              2 * entryBytes.byteLength + 20 * meta.width * meta.height >
                Math.min(config.limits.maxEntryBytes, 64 * 1024 * 1024)
            )
              continue;
            const isPng = /\.png$/i.test(mediaPath);
            const isJpeg = /\.jpe?g$/i.test(mediaPath);
            if ((isPng && meta.format !== 'png') || (isJpeg && meta.format !== 'jpeg')) continue;

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
                if (docPolicy.image.lossless || !canReencodeOfficeJpeg(entryBytes)) continue;
                if (!jpegAdapter) {
                  const mod = await import('../codecs/jpeg');
                  jpegAdapter = mod.jpegAdapter;
                }
                const decoded = await jpegAdapter.decode(entryBytes.buffer);
                const target = docPolicy.image.maxEdge
                  ? scaleImageData(decoded, docPolicy.image.maxEdge)
                  : decoded;
                const encoded = await jpegAdapter.encode(target, docPolicy.image);
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
          stage: 'encode',
          completed: 0,
          total: null,
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

      loading.ready();
      streamPrepared(cmd, finalBuffer, {
        disposition,
        ...(disposition === 'original'
          ? {
              reason:
                preflight.isSigned || preflight.isEncrypted
                  ? ('protected_document' as const)
                  : !preflight.valid || preflight.isMacroEnabled
                    ? ('unsupported_content' as const)
                    : ('no_smaller_candidate' as const),
            }
          : {}),
        outputBytes,
        mime,
        extension,
        durationMs,
      });
    } catch (error) {
      emitWorkerEvent({
        version: 1,
        batchId,
        jobId,
        attemptId,
        type: 'error',
        error: {
          code: isCancelled ? 'CANCELLED' : 'INTERNAL',
          retryable: false,
          details:
            error instanceof Error
              ? `${error.message}\n${error.stack ?? ''}`.slice(0, 1800)
              : 'Unknown worker error',
          messageKey: isCancelled ? 'job_cancelled' : 'office_processing_failed',
        },
      });
      outputPort.close();
    } finally {
      observation.stop();
      loading.restore();
    }
  }
};
