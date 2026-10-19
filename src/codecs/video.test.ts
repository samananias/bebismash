import { describe, it, expect } from 'vitest';
import {
  adaptiveVideoRates,
  inspectVideo,
  isWebCodecsSupported,
  processVideo,
  validateVideoCandidate,
} from './video';
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
  it('compares elapsed media duration across different timestamp origins without relaxing tolerance', async () => {
    const mb = await import('mediabunny');
    const container = async (start: number) => {
      const target = new mb.BufferTarget();
      const output = new mb.Output({ target, format: new mb.WebMOutputFormat() });
      const source = new mb.EncodedVideoPacketSource('vp8');
      output.addVideoTrack(source, { frameRate: 1 });
      await output.start();
      // Container-timing fixture only; independent playback is exercised in browser tests.
      await source.add(
        new mb.EncodedPacket(new Uint8Array([16, 0, 0, 157, 1, 42, 16, 0, 16, 0]), 'key', start, 1),
        { decoderConfig: { codec: 'vp8', codedWidth: 16, codedHeight: 16 } }
      );
      source.close();
      await output.finalize();
      return target.buffer!;
    };
    const inspection = await inspectVideo(await container(5));
    expect(inspection.durationSec).toBeCloseTo(1);
    const candidate = await container(0);
    expect(await validateVideoCandidate(candidate, inspection, defaultLimits)).toBe(true);
    expect(
      await validateVideoCandidate(candidate, { ...inspection, durationSec: 1.1 }, defaultLimits)
    ).toBe(false);
    expect(
      await validateVideoCandidate(
        candidate,
        { ...inspection, videoTracks: [{ ...inspection.videoTracks[0]!, lastTimestampSec: 5.1 }] },
        defaultLimits
      )
    ).toBe(false);
  });
  it('budgets audio and overhead within a capped candidate, without exceeding the preset', () => {
    const rates = adaptiveVideoRates(100_000_000, 100, 20_000_000, defaultVideoPolicy, true)!;
    expect(rates.video).toBeLessThanOrEqual(defaultVideoPolicy.webVideoBitrate);
    expect(rates.audio).toBeLessThanOrEqual(defaultVideoPolicy.audioBitrate);
    expect(((rates.video + rates.audio) * 100) / 8).toBeLessThan(20_000_000);
    expect(adaptiveVideoRates(1000, 100, 1000, defaultVideoPolicy, false)).toBeNull();
    expect(adaptiveVideoRates(1000, 0, 1000, defaultVideoPolicy, false)).toBeNull();
    expect(adaptiveVideoRates(1000, NaN, 1000, defaultVideoPolicy, false)).toBeNull();
  });
  it('preserves a Blob without reading the complete source into an ArrayBuffer', async () => {
    const blob = new Blob([new Uint8Array(100)]);
    blob.arrayBuffer = () => {
      throw new Error('Full source read forbidden');
    };
    const result = await processVideo(blob, defaultVideoPolicy, defaultLimits);
    expect(result.disposition).toBe('original');
    expect(result.buffer).toBeNull();
  });
  it('probes WebCodecs support safely without throwing', () => {
    const supported = isWebCodecsSupported();
    expect(typeof supported).toBe('boolean');
  });

  it('preserves unsupported or corrupted video data byte-identical', async () => {
    const corruptVideo = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
    const result = await processVideo(corruptVideo.buffer, defaultVideoPolicy, defaultLimits);

    expect(result.disposition).toBe('original');
    expect(result.buffer!.byteLength).toBe(corruptVideo.byteLength);
    const view = new Uint8Array(result.buffer!);
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
    expect(result.buffer!.byteLength).toBe(50);
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
