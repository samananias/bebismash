import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { submitTelemetryBatch } from './telemetry';
import type { TelemetryReportItem } from './telemetry';
const item = (overrides: Partial<TelemetryReportItem> = {}): TelemetryReportItem => ({
  disposition: 'transformed',
  extension: 'jpeg',
  category: 'image',
  intensity: 'heavy',
  originalBytes: 5 * 1024 * 1024 * 1024,
  compressedBytes: 2 * 1024 * 1024 * 1024,
  durationMs: 123,
  deviceTier: 'high',
  ...overrides,
});
describe('Foreground aggregate telemetry', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', { onLine: true, sendBeacon: vi.fn() });
    vi.stubGlobal('document', { visibilityState: 'visible' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  it('sends one anonymous aggregate for 100 files above the old 2 GiB limit', async () => {
    await submitTelemetryBatch(
      Array.from({ length: 100 }, () => item()),
      true
    );
    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('/api/telemetry');
    expect(options).toMatchObject({ method: 'POST', credentials: 'omit', cache: 'no-store' });
    expect(options).not.toHaveProperty('keepalive');
    expect(navigator.sendBeacon).not.toHaveBeenCalled();
    const body = JSON.parse(options!.body as string);
    expect(Object.keys(body).sort()).toEqual(['buckets', 'submission_id', 'version']);
    expect(body.buckets).toEqual([
      {
        format: 'jpg',
        outcome: 'compressed',
        file_count: 100,
        input_bytes: 500 * 1024 ** 3,
        output_bytes: 200 * 1024 ** 3,
      },
    ]);
    expect(JSON.stringify(body)).not.toMatch(/filename|duration|device|intensity|category|hash/);
  });
  it('separates preserved originals from actually smaller transforms and rounds sizes', async () => {
    await submitTelemetryBatch(
      [
        item({ originalBytes: 4097, compressedBytes: 2049 }),
        item({ disposition: 'original', originalBytes: 4097, compressedBytes: 4097 }),
      ],
      true
    );
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string);
    expect(body.buckets).toEqual([
      {
        format: 'jpg',
        outcome: 'compressed',
        file_count: 1,
        input_bytes: 4096,
        output_bytes: 2048,
      },
      { format: 'jpg', outcome: 'preserved', file_count: 1, input_bytes: 4096, output_bytes: 4096 },
    ]);
  });
  it('keeps PDF cleanup counts and reasons out of consented telemetry', async () => {
    await submitTelemetryBatch(
      [
        item({
          extension: 'pdf',
          category: 'document',
          pdfMetadataRemoved: 42,
          reason: 'cleanup_unsupported',
        }),
      ],
      true
    );
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string);
    expect(Object.keys(body).sort()).toEqual(['buckets', 'submission_id', 'version']);
    expect(Object.keys(body.buckets[0]).sort()).toEqual([
      'file_count',
      'format',
      'input_bytes',
      'outcome',
      'output_bytes',
    ]);
    expect(JSON.stringify(body)).not.toMatch(/metadata|cleanup|reason|42/);
  });
  it.each(['no consent', 'offline', 'hidden', 'invalid', 'expanded', 'too many', 'too large'])(
    'does not submit: %s',
    async (reason) => {
      if (reason === 'offline') vi.stubGlobal('navigator', { onLine: false });
      if (reason === 'hidden') vi.stubGlobal('document', { visibilityState: 'hidden' });
      const items =
        reason === 'too many'
          ? Array.from({ length: 1001 }, () => item())
          : [
              item(
                reason === 'invalid'
                  ? { originalBytes: NaN }
                  : reason === 'expanded'
                    ? { compressedBytes: 6 * 1024 ** 3 }
                    : reason === 'too large'
                      ? { originalBytes: 2 * 1024 ** 4 }
                      : {}
              ),
            ];
      await submitTelemetryBatch(items, reason !== 'no consent');
      expect(fetch).not.toHaveBeenCalled();
    }
  );
  it('discards network failures without retry', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    await expect(submitTelemetryBatch([item()], true)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('aborts a stalled request and releases its timer', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) =>
          options!.signal!.addEventListener('abort', () => reject(new Error('aborted')))
        )
    );
    const result = submitTelemetryBatch([item()], true);
    await vi.advanceTimersByTimeAsync(5000);
    await result;
    expect(vi.getTimerCount()).toBe(0);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
