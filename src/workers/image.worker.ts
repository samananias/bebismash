/// <reference lib="webworker" />
import type { WorkerCommand, WorkerEvent } from '../core/types';
import { parseImageMeta, scaleImageData } from '../codecs/parser';
import { observeJob, streamPrepared } from './jobRuntime';
import { observeEngineDownloads } from './engineDownloads';
self.onmessage = async ({ data: cmd }: MessageEvent<WorkerCommand>) => {
  if (cmd?.version !== 1 || cmd.type !== 'start') return;
  const job = observeJob(cmd);
  const loading = observeEngineDownloads(cmd);
  const { source, config } = cmd;
  const start = performance.now();
  let failureCode: 'INVALID_INPUT' | 'ENGINE_LOAD_FAILED' | 'DECODE_FAILED' | 'INTERNAL' =
    'INVALID_INPUT';
  try {
    postMessage({ ...job.ids, type: 'ready' } satisfies WorkerEvent);
    job.status('inspect', 'Analyzing image dimensions and animation');
    const meta = parseImageMeta(await source.slice(0, 1024 * 1024).arrayBuffer());
    if (meta.format === 'unknown' || meta.width <= 0 || meta.height <= 0)
      throw new Error('Image header is unsupported, truncated, or has no valid dimensions.');
    const original = {
      disposition: 'original' as const,
      outputBytes: source.size,
      mime: source.type || `image/${meta.format}`,
      extension: source.name.split('.').pop() || meta.format,
      durationMs: Math.round(performance.now() - start),
    };
    if (
      meta.isAnimated ||
      meta.width * meta.height > config.limits.maxPixels ||
      source.size > config.limits.maxInputBytes
    ) {
      job.status('output', 'Keeping original: animation or image exceeds safe processing limits');
      streamPrepared(cmd, source, {
        ...original,
        reason: meta.isAnimated ? 'unsupported_content' : 'memory_limit',
      });
      return;
    }
    if (config.policy.kind !== 'image') throw new Error('Image policy mismatch');
    job.status('load', `Loading jSquash ${meta.format} engine`);
    failureCode = 'ENGINE_LOAD_FAILED';
    const adapter =
      meta.format === 'png'
        ? (await import('../codecs/png')).pngAdapter
        : meta.format === 'webp'
          ? (await import('../codecs/webp')).webpAdapter
          : meta.format === 'avif'
            ? (await import('../codecs/avif')).avifAdapter
            : (await import('../codecs/jpeg')).jpegAdapter;
    job.status('read', 'Reading image into reserved worker memory');
    const buffer = await source.arrayBuffer();
    failureCode = 'DECODE_FAILED';
    let candidate: ArrayBuffer | null = null;
    if (meta.format === 'png' && adapter.optimize) {
      loading.phase('encode', 'Optimizing PNG losslessly; percentage unavailable');
      job.status('encode', 'Optimizing PNG losslessly; percentage unavailable');
      candidate = await adapter.optimize(buffer, config.policy);
      loading.ready();
    } else {
      loading.phase('decode', 'Decoding image; percentage unavailable');
      job.status('decode', 'Decoding image; percentage unavailable');
      const decoded = await adapter.decode(buffer);
      loading.ready();
      job.status('transform', 'Preparing image dimensions');
      const target = config.policy.maxEdge
        ? scaleImageData(decoded, config.policy.maxEdge)
        : decoded;
      loading.phase('encode', 'Encoding image; percentage unavailable');
      job.status('encode', 'Encoding image; percentage unavailable');
      candidate = await adapter.encode(target, config.policy);
      loading.ready();
    }
    failureCode = 'INTERNAL';
    if (
      candidate &&
      candidate.byteLength < source.size &&
      candidate.byteLength <= config.limits.maxOutputBytes
    ) {
      streamPrepared(cmd, candidate, {
        disposition: 'transformed',
        outputBytes: candidate.byteLength,
        mime: `image/${meta.format}`,
        extension: meta.format === 'jpeg' ? 'jpg' : meta.format,
        durationMs: Math.round(performance.now() - start),
      });
    } else streamPrepared(cmd, source, { ...original, reason: 'no_smaller_candidate' });
  } catch (error) {
    postMessage({
      ...job.ids,
      type: 'error',
      error: {
        code: loading.failed() ? 'ENGINE_LOAD_FAILED' : failureCode,
        retryable: true,
        messageKey: 'image_processing_failed',
        details:
          error instanceof Error
            ? `${error.message}\n${error.stack ?? ''}`.slice(0, 1800)
            : 'Unknown image failure',
      },
    } satisfies WorkerEvent);
    cmd.outputPort.close();
  } finally {
    job.stop();
    loading.restore();
  }
};
