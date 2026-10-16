/**
 * Video Codec Adapter & WebCodecs Capabilities
 * Inspects MP4/MOV and WebM tracks, enforces capability boundaries,
 * executes remux/transcode via Mediabunny & WebCodecs when supported,
 * and preserves original byte-identical otherwise.
 * Adheres to Section 4.3 and 3.2 of Master Engineering Blueprint.
 */

import type { VideoPolicy, ResourceLimits, Stage, PreservationReason } from '../core/types';
import type { ConversionVideoOptions } from 'mediabunny';
import { materializeStandaloneBuffer } from './types';

export interface VideoTrackInfo {
  firstTimestampSec?: number;
  lastTimestampSec?: number;
  width: number;
  height: number;
  codec: string;
}

export interface AudioTrackInfo {
  firstTimestampSec?: number;
  lastTimestampSec?: number;
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
    const tracks = await input.getTracks();
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
      // Mediabunny computeDuration returns the last end timestamp, not elapsed playback.
      // WebM SimpleBlocks may omit the final frame duration; finalized segment metadata retains it.
      const computed = await input.computeDuration();
      const metadata = await input.getDurationFromMetadata();
      durationSec = Math.max(
        0,
        Math.max(computed, metadata !== null && Number.isFinite(metadata) ? metadata : 0) -
          Math.max(0, await input.getFirstTimestamp())
      );
    } catch {
      // ignore duration error if metadata is partial
    }

    const vInfo: VideoTrackInfo[] = [];
    for (const vt of videoTracks) {
      const last = await new mb.EncodedPacketSink(vt).getPacket(Infinity, { metadataOnly: true });
      vInfo.push({
        firstTimestampSec: await vt.getFirstTimestamp(),
        ...(last ? { lastTimestampSec: last.timestamp } : {}),
        width: vt.displayWidth || vt.codedWidth || 0,
        height: vt.displayHeight || vt.codedHeight || 0,
        codec: vt.codec || 'unknown',
      });
    }

    const aInfo: AudioTrackInfo[] = [];
    for (const at of audioTracks) {
      const last = await new mb.EncodedPacketSink(at).getPacket(Infinity, { metadataOnly: true });
      aInfo.push({
        firstTimestampSec: await at.getFirstTimestamp(),
        ...(last ? { lastTimestampSec: last.timestamp } : {}),
        codec: at.codec || 'unknown',
        channels: at.numberOfChannels || 2,
        sampleRate: at.sampleRate || 44100,
      });
    }

    // Section 4.3 constraints:
    // Multiple audio tracks require preserve-original until tested
    if (
      audioTracks.length > 1 ||
      videoTracks.length !== 1 ||
      tracks.length !== videoTracks.length + audioTracks.length ||
      audioTracks.some((track) => track.numberOfChannels > 2)
    ) {
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
        reason: 'unsupported_track_layout',
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
  buffer: ArrayBuffer | null;
  reason?: PreservationReason;
  mime: string;
  extension: string;
  durationMs: number;
}

/** Total-file bitrate is only an estimate. Budget audio/overhead and retain final size validation. */
export function adaptiveVideoRates(
  sourceBytes: number,
  duration: number,
  outputCap: number,
  policy: VideoPolicy,
  hasAudio: boolean
): { video: number; audio: number } | null {
  if (![sourceBytes, duration, outputCap].every((n) => Number.isFinite(n) && n > 0)) return null;
  const total = (Math.min(sourceBytes * 0.65, outputCap * 0.9) * 8) / duration;
  const audio = hasAudio ? Math.min(policy.audioBitrate, Math.floor(total * 0.2)) : 0;
  const video = Math.floor(Math.min(policy.webVideoBitrate, total * 0.97 - audio));
  // Avoid forcing a meaningless low-rate encode; this is not a quality guarantee.
  if (video < 100_000 || (hasAudio && audio < 32_000)) return null;
  return { video, audio };
}

/** Reopen candidate before committing it to ZIP; a smaller empty container is not valid output. */
export async function validateVideoCandidate(
  buffer: ArrayBuffer,
  original: VideoInspectionResult,
  limits: ResourceLimits,
  diagnostic?: (detail: string) => void
): Promise<boolean> {
  if (buffer.byteLength === 0 || buffer.byteLength > limits.maxOutputBytes) return false;
  const mb = await import('mediabunny');
  const input = new mb.Input({ source: new mb.BufferSource(buffer), formats: mb.ALL_FORMATS });
  try {
    const video = await input.getVideoTracks();
    const audio = await input.getAudioTracks();
    diagnostic?.(
      `Video validation tracks: ${video.length}/${audio.length}; expected ${original.videoTracks.length}/${original.audioTracks.length}`
    );
    if (
      video.length !== original.videoTracks.length ||
      audio.length !== original.audioTracks.length ||
      video.length === 0
    )
      return false;
    const sourceTracks = [...original.videoTracks, ...original.audioTracks];
    const sourceOrigin = Math.max(
      0,
      Math.min(...sourceTracks.map((track) => track.firstTimestampSec ?? 0))
    );
    const candidateOrigin = Math.max(0, await input.getFirstTimestamp());
    for (const [index, track] of [...video, ...audio].entries()) {
      const packets = new mb.EncodedPacketSink(track);
      const packet = await packets.getFirstPacket();
      if (!packet || packet.data.byteLength === 0) return false;
      const last = await packets.getPacket(Infinity, { metadataOnly: true });
      const sourceTrack = sourceTracks[index]!;
      // Container metadata alone cannot justify accepting truncated or shifted media.
      if (
        !last ||
        (sourceTrack.firstTimestampSec !== undefined &&
          Math.abs(
            packet.timestamp - candidateOrigin - (sourceTrack.firstTimestampSec - sourceOrigin)
          ) > 0.05) ||
        (sourceTrack.lastTimestampSec !== undefined &&
          Math.abs(
            last.timestamp - candidateOrigin - (sourceTrack.lastTimestampSec - sourceOrigin)
          ) > 0.05)
      )
        return false;
    }
    const computed = await input.computeDuration();
    const metadata = await input.getDurationFromMetadata();
    const duration =
      Math.max(computed, metadata !== null && Number.isFinite(metadata) ? metadata : 0) -
      candidateOrigin;
    diagnostic?.(
      `Video validation duration: ${duration.toFixed(3)} s; source ${original.durationSec.toFixed(3)} s`
    );
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
  buffer: ArrayBuffer | Blob,
  policy: VideoPolicy,
  limits: ResourceLimits,
  onProgress?: (ratio: number) => void,
  onStatus?: (stage: Stage, detail: string) => void
): Promise<VideoProcessingResult> {
  const startTime = performance.now();
  const sourceBytes = buffer instanceof Blob ? buffer.size : buffer.byteLength;
  const original = (
    reason: PreservationReason,
    inspection?: VideoInspectionResult
  ): VideoProcessingResult => ({
    disposition: 'original',
    reason,
    buffer: buffer instanceof ArrayBuffer ? materializeStandaloneBuffer(buffer) : null,
    mime: inspection?.mime ?? ((buffer instanceof Blob ? buffer.type : '') || 'video/mp4'),
    extension: inspection?.extension ?? 'mp4',
    durationMs: Math.round(performance.now() - startTime),
  });

  let inspection: VideoInspectionResult;
  try {
    inspection = await inspectVideo(buffer);
  } catch {
    return original('unsupported_content');
  }

  // If unsupported tracks or no video track, preserve original
  if (!inspection.isSupported || inspection.videoTracks.length === 0) {
    return original('unsupported_content', inspection);
  }

  // Check limits (duration or dimension limits)
  const primaryVideo = inspection.videoTracks[0]!;
  if (
    primaryVideo.width * primaryVideo.height > limits.maxPixels ||
    sourceBytes > limits.maxInputBytes
  ) {
    return original('memory_limit', inspection);
  }

  // If WebCodecs is not available and mode is transcode, or in test environments,
  // remux or preserve original
  const hasWebCodecs = isWebCodecsSupported();
  if (policy.mode === 'transcode' && !hasWebCodecs) {
    return original('unsupported_codec', inspection);
  }

  {
    const mb = await import('mediabunny');
    const source = buffer instanceof Blob ? new mb.BlobSource(buffer) : new mb.BufferSource(buffer);
    const input = new mb.Input({
      source,
      formats: mb.ALL_FORMATS,
    });

    onStatus?.('init', 'Checking decoder / encoder configurations and initializing conversion');
    // Preallocate only admitted bytes; reject positioned writes before copying into the candidate.
    const candidate = new Uint8Array(limits.maxOutputBytes);
    let candidateSize = 0;
    let overflow = false;
    const target = new mb.StreamTarget(
      new WritableStream({
        write({ position, data }) {
          if (
            !Number.isSafeInteger(position) ||
            position < 0 ||
            position + data.byteLength > candidate.byteLength
          ) {
            overflow = true;
            throw new Error('Video output exceeds reserved memory limit');
          }
          candidate.set(data, position);
          candidateSize = Math.max(candidateSize, position + data.byteLength);
        },
      })
    );
    const outputFormat =
      inspection.format === 'webm'
        ? new mb.WebMOutputFormat()
        : inspection.format === 'mov'
          ? new mb.MovOutputFormat({ fastStart: false })
          : new mb.Mp4OutputFormat({ fastStart: false });

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
        const rate = adaptiveVideoRates(
          sourceBytes,
          inspection.durationSec,
          limits.maxOutputBytes,
          policy,
          inspection.audioTracks.length > 0
        );
        if (!rate) return original('no_smaller_candidate', inspection);
        const videoOptions: ConversionVideoOptions = { bitrate: rate.video };
        if (policy.maxHeight) {
          videoOptions.height = Math.min(primaryVideo.height, policy.maxHeight);
        }
        if (policy.maxFps) {
          const sourceFps = await input
            .getPrimaryVideoTrack()
            .then((track) =>
              track?.computePacketStats(100).then((stats) => stats.averagePacketRate)
            );
          if (sourceFps && Number.isFinite(sourceFps) && sourceFps > policy.maxFps)
            videoOptions.frameRate = policy.maxFps;
        }

        conversion = await mb.Conversion.init({
          input,
          output,
          copy: false,
          showWarnings: false,
          video: videoOptions,
          ...(inspection.audioTracks.length ? { audio: { bitrate: rate.audio } } : {}),
        });
      }

      if (!conversion.isValid || conversion.discardedTracks.length > 0) {
        return original('unsupported_codec', inspection);
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

      const resultBuffer = candidateSize ? candidate.buffer.slice(0, candidateSize) : null;
      if (
        resultBuffer &&
        resultBuffer.byteLength < sourceBytes &&
        (await validateVideoCandidate(resultBuffer, inspection, limits, (detail) =>
          onStatus?.('output', detail)
        ))
      ) {
        return {
          disposition: 'transformed',
          buffer: materializeStandaloneBuffer(resultBuffer),
          mime: await output.getMimeType(),
          extension: inspection.extension,
          durationMs: Math.round(performance.now() - startTime),
        };
      }

      onStatus?.('output', 'Candidate was larger or failed media validation; keeping original');
      return original(
        resultBuffer && resultBuffer.byteLength < sourceBytes
          ? 'validation_failed'
          : 'no_smaller_candidate',
        inspection
      );
    } catch (error) {
      if (overflow) return original('memory_limit', inspection);
      throw error;
    } finally {
      try {
        if (output.state !== 'finalized' && output.state !== 'canceled') await output.cancel();
      } finally {
        await input.dispose();
      }
    }
  }
}
