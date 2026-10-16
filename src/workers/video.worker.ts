/// <reference lib="webworker" />
import type { WorkerCommand, WorkerEvent } from '../core/types';
import { observeJob, streamPrepared } from './jobRuntime';
self.onmessage = async ({ data: cmd }: MessageEvent<WorkerCommand>) => {
  if (cmd?.version !== 1 || cmd.type !== 'start') return;
  const job = observeJob(cmd);
  try {
    postMessage({ ...job.ids, type: 'ready' } satisfies WorkerEvent);
    job.status('load', 'Loading Mediabunny module; video codecs are provided by your browser');
    const { processVideo, inspectVideo, isWebCodecsSupported } = await import('../codecs/video');
    if (cmd.config.policy.kind !== 'video') throw new Error('Video policy mismatch');
    job.status('decode', 'Analyzing video tracks with bounded File range reads');
    const inspection = await inspectVideo(cmd.source);
    const video = inspection.videoTracks[0];
    if (video)
      postMessage({
        ...job.ids,
        type: 'status',
        stage: 'decode',
        detail: 'Media tracks inspected',
        media: {
          width: video.width,
          height: video.height,
          videoCodec: video.codec,
          audioCodec: inspection.audioTracks[0]?.codec ?? 'none',
          webCodecs: isWebCodecsSupported(),
        },
      } satisfies WorkerEvent);
    if (
      !video ||
      !inspection.isSupported ||
      video.width * video.height > cmd.config.limits.maxPixels ||
      cmd.source.size > cmd.config.limits.maxInputBytes
    ) {
      job.status(
        'output',
        'Keeping original: unsupported tracks or media exceeds safe memory limits'
      );
      streamPrepared(cmd, cmd.source, {
        disposition: 'original',
        outputBytes: cmd.source.size,
        mime: cmd.source.type || inspection.mime,
        extension: cmd.source.name.split('.').pop() || inspection.extension,
        durationMs: 0,
      });
      return;
    }
    job.status('read', 'Reading video into reserved worker memory');
    const buffer = await cmd.source.arrayBuffer();
    job.status('decode', 'Analyzing media tracks and codec availability');
    const result = await processVideo(
      buffer,
      cmd.config.policy,
      cmd.config.limits,
      (ratio) => {
        postMessage({
          ...job.ids,
          type: 'progress',
          seq: ++seq,
          stage: 'transform',
          completed: Math.round(ratio * 10000),
          total: 10000,
          unit: 'steps',
        } satisfies WorkerEvent);
      },
      (stage, detail) => job.status(stage, detail)
    );
    streamPrepared(cmd, result.disposition === 'original' ? cmd.source : result.buffer, {
      ...result,
      outputBytes: result.buffer.byteLength,
    });
  } catch (error) {
    postMessage({
      ...job.ids,
      type: 'error',
      error: {
        code: 'DECODE_FAILED',
        retryable: true,
        messageKey: 'video_processing_failed',
        details:
          error instanceof Error
            ? `${error.message}\n${error.stack ?? ''}`.slice(0, 1800)
            : 'Video processing failed',
      },
    } satisfies WorkerEvent);
    cmd.outputPort.close();
  } finally {
    job.stop();
  }
};
let seq = 0;
