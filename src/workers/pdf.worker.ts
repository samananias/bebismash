/// <reference lib="webworker" />
import type { WorkerCommand, WorkerEvent, DocumentPolicy } from '../core/types';

import { observeJob, streamPrepared } from './jobRuntime';
import { observeEngineDownloads } from './engineDownloads';
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
        total: null,
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
        completed: 0,
        total: null,
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

      observation.status('load', 'Loading PDF engine');
      const { rewritePdf } = await import('../codecs/pdf');
      observation.status('transform', 'Rewriting PDF; percentage unavailable');
      const rewriteResult = await rewritePdf(
        fullSourceBuffer,
        docPolicy,
        config.limits,
        () => isCancelled
      );
      if (isCancelled) throw new Error('Cancelled');

      emitWorkerEvent({
        version: 1,
        batchId,
        jobId,
        attemptId,
        type: 'progress',
        seq: 3,
        stage: 'encode',
        completed: 0,
        total: null,
        unit: 'bytes',
      });

      const finalBuffer = rewriteResult.buffer;
      const outputBytes = finalBuffer.byteLength;
      const durationMs = Math.max(0, Math.round(performance.now() - startTime));

      loading.ready();
      streamPrepared(cmd, finalBuffer, {
        ...(rewriteResult.pdfDiagnostics ? { pdfDiagnostics: rewriteResult.pdfDiagnostics } : {}),
        disposition: rewriteResult.disposition,
        ...(rewriteResult.reason ? { reason: rewriteResult.reason } : {}),
        ...(rewriteResult.pdfMetadataRemoved
          ? { pdfMetadataRemoved: rewriteResult.pdfMetadataRemoved }
          : {}),
        outputBytes,
        mime: 'application/pdf',
        extension: 'pdf',
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
          messageKey: isCancelled ? 'job_cancelled' : 'pdf_processing_failed',
        },
      });
      outputPort.close();
    } finally {
      observation.stop();
      loading.restore();
    }
  }
};
