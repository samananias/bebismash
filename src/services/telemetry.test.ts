import { describe, expect, it, vi, beforeEach } from 'vitest';
import { submitTelemetryBatch } from './telemetry';

describe('Client Telemetry Service', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('does nothing when consent is false', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    submitTelemetryBatch(
      [
        {
          extension: 'png',
          category: 'image',
          intensity: 'balanced',
          originalBytes: 100000,
          compressedBytes: 50000,
          durationMs: 340,
          deviceTier: 'standard',
        },
      ],
      false
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('dispatches anonymous batch via sendBeacon when available', () => {
    const sendBeaconMock = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { sendBeacon: sendBeaconMock });

    submitTelemetryBatch(
      [
        {
          extension: 'jpg',
          category: 'image',
          intensity: 'heavy',
          originalBytes: 204800,
          compressedBytes: 102400,
          durationMs: 462,
          deviceTier: 'high',
        },
      ],
      true
    );

    expect(sendBeaconMock).toHaveBeenCalledTimes(1);
    const [endpoint, blob] = sendBeaconMock.mock.calls[0] as [string, Blob];
    expect(endpoint).toBe('/api/telemetry');
    expect(blob.type.toLowerCase()).toBe('text/plain;charset=utf-8');
  });

  it('falls back to nonblocking fetch with keepalive when sendBeacon fails', () => {
    const sendBeaconMock = vi.fn().mockReturnValue(false);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('navigator', { sendBeacon: sendBeaconMock });
    vi.stubGlobal('fetch', fetchMock);

    submitTelemetryBatch(
      [
        {
          extension: 'webp',
          category: 'image',
          intensity: 'gentle',
          originalBytes: 8192,
          compressedBytes: 4096,
          durationMs: 120,
          deviceTier: 'constrained',
        },
      ],
      true
    );

    expect(sendBeaconMock).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/telemetry',
      expect.objectContaining({
        method: 'POST',
        keepalive: true,
        credentials: 'omit',
      })
    );
  });

  it('filters out items where compressedBytes exceeds originalBytes', () => {
    const sendBeaconMock = vi.fn().mockReturnValue(true);
    vi.stubGlobal('navigator', { sendBeacon: sendBeaconMock });

    submitTelemetryBatch(
      [
        {
          extension: 'jpg',
          category: 'image',
          intensity: 'balanced',
          originalBytes: 1000,
          compressedBytes: 2000, // expanded!
          durationMs: 50,
          deviceTier: 'standard',
        },
      ],
      true
    );

    expect(sendBeaconMock).not.toHaveBeenCalled();
  });
});
