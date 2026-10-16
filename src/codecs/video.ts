/**
 * Video Codec Adapter & WebCodecs Capabilities
 * Inspects MP4/MOV and WebM tracks, enforces capability boundaries,
 * executes remux/transcode via Mediabunny & WebCodecs when supported,
 * and preserves original byte-identical otherwise.
 * Adheres to Section 4.3 and 3.2 of Master Engineering Blueprint.
 */

import type { VideoPolicy, ResourceLimits, Stage } from '../core/types';
import type { ConversionVideoOptions } from 'mediabunny';
import { materializeStandaloneBuffer } from './types';

export interface VideoTrackInfo {
  width: number;
  height: number;
  codec: string;
}

export interface AudioTrackInfo {
  codec: string;
  channels: number;
  sampleRate: number;
}

export interface VideoInspectionResult {
  format: 'mp4' | 'mov' | 'webm' | 'unknown';
  mime: string;
  extension: string;
  durationSec: number;
  videoTracks: VideoTrackInfo[];
  audioTracks: AudioTrackInfo[];
  isSupported: boolean;
  canRemux: boolean;
  canTranscode: boolean;
  reason?: string;
}

export function isWebCodecsSupported(): boolean {
  return (
    typeof globalThis !== 'undefined' &&
    typeof (globalThis as unknown as { VideoEncoder?: unknown }).VideoEncoder !== 'undefined' &&
    typeof (globalThis as unknown as { VideoDecoder?: unknown }).VideoDecoder !== 'undefined'
  );
}

export async function inspectVideo(buffer: ArrayBuffer | Blob): Promise<VideoInspectionResult> {
  const mb = await import('mediabunny');

  const source = buffer instanceof Blob ? new mb.BlobSource(buffer) : new mb.BufferSource(buffer);
  const input = new mb.Input({
    source,
    formats: mb.ALL_FORMATS,
  });

  try {
    const videoTracks = await input.getVideoTracks();
    const audioTracks = await input.getAudioTracks();
    const mime = (await input.getMimeType()) || 'video/mp4';

    let format: 'mp4' | 'mov' | 'webm' | 'unknown' = 'unknown';
    let extension = 'mp4';
    if (mime.includes('webm')) {
      format = 'webm';
      extension = 'webm';
    } else if (mime.includes('quicktime')) {
      format = 'mov';
      extension = 'mov';
    } else if (mime.includes('mp4')) {
      format = 'mp4';
      extension = 'mp4';
    }

    let durationSec = 0;
    try {
      durationSec = (await input.computeDuration()) || 0;
    } catch {
      // ignore duration error if metadata is partial
    }

    const vInfo: VideoTrackInfo[] = [];
    for (const vt of videoTracks) {
      vInfo.push({
        width: vt.displayWidth || vt.codedWidth || 0,
        height: vt.displayHeight || vt.codedHeight || 0,
        codec: vt.codec || 'unknown',
      });
    }

    const aInfo: AudioTrackInfo[] = [];
    for (const at of audioTracks) {
      aInfo.push({
        codec: at.codec || 'unknown',
        channels: at.numberOfChannels || 2,
        sampleRate: at.sampleRate || 44100,
      });
    }

    // Section 4.3 constraints:
    // Multiple audio tracks require preserve-original until tested
    if (audioTracks.length > 1) {
      return {
        format,
        mime,
        extension,
        durationSec,
        videoTracks: vInfo,
        audioTracks: aInfo,
        isSupported: false,
        canRemux: false,
        canTranscode: false,
        reason: 'multiple_audio_tracks',
      };
    }

    const hasWebCodecs = isWebCodecsSupported();

    return {
      format,
      mime,
      extension,
      durationSec,
      videoTracks: vInfo,
      audioTracks: aInfo,
      isSupported: vInfo.length > 0,
      canRemux: true,
      canTranscode: hasWebCodecs,
    };
  } finally {
    await input.dispose();
  }
}

export interface VideoProcessingResult {
  disposition: 'transformed' | 'original';
  buffer: ArrayBuffer;
  mime: string;
  extension: string;
  durationMs: number;
}

/** Reopen candidate before committing it to ZIP; a smaller empty container is not valid output. */
export async function validateVideoCandidate(
  buffer: ArrayBuffer,
  original: VideoInspectionResult,
  limits: ResourceLimits
): Promise<boolean> {
  if (buffer.byteLength === 0 || buffer.byteLength > limits.maxOutputBytes) return false;
  const mb = await import('mediabunny');
  const input = new mb.Input({ source: new mb.BufferSource(buffer), formats: mb.ALL_FORMATS });
  try {
    const video = await input.getVideoTracks();
    const audio = await input.getAudioTracks();
    if (
      video.length !== original.videoTracks.length ||
      audio.length !== original.audioTracks.length ||
      video.length === 0
    )
      return false;
    for (const track of [...video, ...audio]) {
      const packet = await new mb.EncodedPacketSink(track).getFirstPacket();
      if (!packet || packet.data.byteLength === 0) return false;
    }
    const duration = await input.computeDuration();
    return (
      Number.isFinite(duration) &&
      (original.durationSec <= 0 || Math.abs(duration - original.durationSec) <= 0.05)
    );
  } catch {
    return false;
  } finally {
    await input.dispose();
  }
}

export async function processVideo(
  buffer: ArrayBuffer,
  policy: VideoPolicy,
  limits: ResourceLimits,
  onProgress?: (ratio: number) => void,
  onStatus?: (stage: Stage, detail: string) => void
): Promise<VideoProcessingResult> {
  const startTime = performance.now();

  let inspection: VideoInspectionResult;
  try {
    inspection = await inspectVideo(buffer);
  } catch {
    return {
      disposition: 'original',
      buffer: materializeStandaloneBuffer(buffer),
      mime: 'video/mp4',
      extension: 'mp4',
      durationMs: 0,
    };
  }

  // If unsupported tracks or no video track, preserve original
  if (!inspection.isSupported || inspection.videoTracks.length === 0) {
    return {
      disposition: 'original',
      buffer: materializeStandaloneBuffer(buffer),
      mime: inspection.mime,
      extension: inspection.extension,
      durationMs: Math.round(performance.now() - startTime),
    };
  }

  // Check limits (duration or dimension limits)
  const primaryVideo = inspection.videoTracks[0]!;
  if (
    primaryVideo.width * primaryVideo.height > limits.maxPixels ||
    buffer.byteLength > limits.maxInputBytes
  ) {
    return {
      disposition: 'original',
      buffer: materializeStandaloneBuffer(buffer),
      mime: inspection.mime,
      extension: inspection.extension,
      durationMs: Math.round(performance.now() - startTime),
    };
  }

  // If WebCodecs is not available and mode is transcode, or in test environments,
  // remux or preserve original
  const hasWebCodecs = isWebCodecsSupported();
  if (policy.mode === 'transcode' && !hasWebCodecs) {
    return {
      disposition: 'original',
      buffer: materializeStandaloneBuffer(buffer),
      mime: inspection.mime,
      extension: inspection.extension,
      durationMs: Math.round(performance.now() - startTime),
    };
  }

  {
    const mb = await import('mediabunny');
    const source = new mb.BufferSource(buffer);
    const input = new mb.Input({
      source,
      formats: mb.ALL_FORMATS,
    });

    onStatus?.('init', 'Checking decoder / encoder configurations and initializing conversion');
    const target = new mb.BufferTarget();
    target.onwrite = (_start, end) => {
      if (end > limits.maxOutputBytes)
        throw new Error('Video output exceeds reserved memory limit');
    };
    const outputFormat =
      inspection.format === 'webm' ? new mb.WebMOutputFormat() : new mb.Mp4OutputFormat();

    const output = new mb.Output({
      target,
      format: outputFormat,
    });

    try {
      // Configure Conversion options based on policy
      let conversion;
      if (policy.mode === 'remux' || !hasWebCodecs) {
        // Gentle preset: remux supported tracks
        conversion = await mb.Conversion.init({
          input,
          output,
          copy: {},
          showWarnings: false,
        });
      } else {
        // Transcode mode via Mediabunny & WebCodecs
        const videoOptions: ConversionVideoOptions = {
          bitrate: policy.webVideoBitrate,
        };
        if (policy.maxHeight) {
          videoOptions.height = Math.min(primaryVideo.height, policy.maxHeight);
        }
        if (policy.maxFps) {
          videoOptions.frameRate = policy.maxFps;
        }

        conversion = await mb.Conversion.init({
          input,
          output,
          copy: false,
          showWarnings: false,
          video: videoOptions,
          audio: {
            bitrate: policy.audioBitrate,
          },
        });
      }

      if (!conversion.isValid || conversion.discardedTracks.length > 0) {
        return {
          disposition: 'original',
          buffer: materializeStandaloneBuffer(buffer),
          mime: inspection.mime,
          extension: inspection.extension,
          durationMs: Math.round(performance.now() - startTime),
        };
      }

      if (onProgress) {
        conversion.onProgress = (progress) => {
          onProgress(progress);
        };
      }

      onStatus?.(
        'transform',
        policy.mode === 'remux'
          ? 'Remuxing supported tracks'
          : 'Processing video with browser WebCodecs'
      );
      await conversion.execute();
      onStatus?.('output', 'Finalizing video output and comparing sizes');

      const resultBuffer = target.buffer;
      if (
        resultBuffer &&
        resultBuffer.byteLength < buffer.byteLength &&
        (await validateVideoCandidate(resultBuffer, inspection, limits))
      ) {
        return {
          disposition: 'transformed',
          buffer: materializeStandaloneBuffer(resultBuffer),
          mime: inspection.mime,
          extension: inspection.extension,
          durationMs: Math.round(performance.now() - startTime),
        };
      }

      onStatus?.('output', 'Candidate was larger or failed media validation; keeping original');
      return {
        disposition: 'original',
        buffer: materializeStandaloneBuffer(buffer),
        mime: inspection.mime,
        extension: inspection.extension,
        durationMs: Math.round(performance.now() - startTime),
      };
    } finally {
      await input.dispose();
    }
  }
}
