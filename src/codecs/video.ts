/**
 * Video Codec Adapter & WebCodecs Capabilities
 * Inspects MP4/MOV and WebM tracks, enforces capability boundaries,
 * executes remux/transcode via Mediabunny & WebCodecs when supported,
 * and preserves original byte-identical otherwise.
 * Adheres to Section 4.3 and 3.2 of Master Engineering Blueprint.
 */

import type { VideoPolicy, ResourceLimits } from '../core/types';
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

/**
 * Checks if browser environment natively supports WebCodecs (VideoEncoder, VideoDecoder)
 */
export function isWebCodecsSupported(): boolean {
  return (
    typeof globalThis !== 'undefined' &&
    typeof (globalThis as unknown as { VideoEncoder?: unknown }).VideoEncoder !== 'undefined' &&
    typeof (globalThis as unknown as { VideoDecoder?: unknown }).VideoDecoder !== 'undefined'
  );
}

/**
 * Bounded inspection of video container headers and tracks using Mediabunny.
 */
export async function inspectVideo(buffer: ArrayBuffer): Promise<VideoInspectionResult> {
  const mb = await import('mediabunny');

  const source = new mb.BufferSource(buffer);
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

/**
 * Remuxes or transcodes video based on policy and available capabilities.
 * If unsupported or if output is larger than input, preserves original byte-identical.
 */
export async function processVideo(
  buffer: ArrayBuffer,
  policy: VideoPolicy,
  limits: ResourceLimits,
  onProgress?: (ratio: number) => void
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

  try {
    const mb = await import('mediabunny');
    const source = new mb.BufferSource(buffer);
    const input = new mb.Input({
      source,
      formats: mb.ALL_FORMATS,
    });

    const target = new mb.BufferTarget();
    const outputFormat =
      inspection.format === 'webm' ? new mb.MkvOutputFormat() : new mb.Mp4OutputFormat();

    const output = new mb.Output({
      target,
      format: outputFormat,
    });

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

    if (!conversion.isValid) {
      await input.dispose();
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

    await conversion.execute();
    await input.dispose();

    const resultBuffer = target.buffer;
    if (resultBuffer && resultBuffer.byteLength < buffer.byteLength) {
      return {
        disposition: 'transformed',
        buffer: materializeStandaloneBuffer(resultBuffer),
        mime: inspection.mime,
        extension: inspection.extension,
        durationMs: Math.round(performance.now() - startTime),
      };
    }

    return {
      disposition: 'original',
      buffer: materializeStandaloneBuffer(buffer),
      mime: inspection.mime,
      extension: inspection.extension,
      durationMs: Math.round(performance.now() - startTime),
    };
  } catch {
    return {
      disposition: 'original',
      buffer: materializeStandaloneBuffer(buffer),
      mime: inspection.mime,
      extension: inspection.extension,
      durationMs: Math.round(performance.now() - startTime),
    };
  }
}
