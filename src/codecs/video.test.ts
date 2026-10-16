import { describe, it, expect } from 'vitest';
import { isWebCodecsSupported, processVideo, validateVideoCandidate } from './video';
import type { ResourceLimits, VideoPolicy } from '../core/types';

const defaultLimits: ResourceLimits = {
  maxInputBytes: 2 * 1024 * 1024 * 1024,
  maxOutputBytes: 256 * 1024 * 1024,
  maxPixels: 24_000_000,
  maxExpandedBytes: 256 * 1024 * 1024,
  maxEntryBytes: 100 * 1024 * 1024,
  maxEntries: 1000,
  maxExpansionRatio: 100,
  maxWallTimeMs: 600_000,
};

const defaultVideoPolicy: VideoPolicy = {
  kind: 'video',
  mode: 'remux',
  maxHeight: null,
  maxFps: null,
  webVideoBitrate: 4_000_000,
  audioBitrate: 128_000,
  ffmpegCrf: 26,
  ffmpegPreset: 'medium',
};

describe('Video Capabilities and Baseline Adapter', () => {
  it('probes WebCodecs support safely without throwing', () => {
    const supported = isWebCodecsSupported();
    expect(typeof supported).toBe('boolean');
  });

  it('preserves unsupported or corrupted video data byte-identical', async () => {
    const corruptVideo = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
    const result = await processVideo(corruptVideo.buffer, defaultVideoPolicy, defaultLimits);

    expect(result.disposition).toBe('original');
    expect(result.buffer.byteLength).toBe(corruptVideo.byteLength);
    const view = new Uint8Array(result.buffer);
    expect(view[4]).toBe(0x66); // 'f'
    expect(view[5]).toBe(0x74); // 't'
    expect(view[6]).toBe(0x79); // 'y'
    expect(view[7]).toBe(0x70); // 'p'
  });

  it('preserves original bytes when input exceeds maxInputBytes limit', async () => {
    const strictLimits: ResourceLimits = {
      ...defaultLimits,
      maxInputBytes: 10,
    };
    const buffer = new Uint8Array(50).buffer;
    const result = await processVideo(buffer, defaultVideoPolicy, strictLimits);
    expect(result.disposition).toBe('original');
    expect(result.buffer.byteLength).toBe(50);
  });
  it('rejects a finalized container without encoded media packets', async () => {
    const mb = await import('mediabunny');
    const target = new mb.BufferTarget();
    const output = new mb.Output({ target, format: new mb.WebMOutputFormat() });
    const source = new mb.EncodedVideoPacketSource('vp8');
    output.addVideoTrack(source);
    await output.start();
    source.close();
    await output.finalize();
    expect(target.buffer).not.toBeNull();
    expect(
      await validateVideoCandidate(
        target.buffer!,
        {
          format: 'webm',
          mime: 'video/webm',
          extension: 'webm',
          durationSec: 1,
          videoTracks: [{ width: 160, height: 120, codec: 'vp8' }],
          audioTracks: [],
          isSupported: true,
          canRemux: true,
          canTranscode: true,
        },
        defaultLimits
      )
    ).toBe(false);
  });
});
