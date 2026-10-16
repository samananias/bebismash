import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const sample = () => ({
  version: 2,
  total_files_processed: 2,
  total_files_compressed: 1,
  input_bytes: 8192,
  output_bytes: 6144,
  saved_bytes: 2048,
  weighted_savings_percent: 25,
  tracking_since: '2026-10-16T00:00:00Z',
  updated_at: '2026-10-16T01:00:00Z',
  retrieved_at: '2026-10-16T02:00:00Z',
  legacy: { files_processed: 0, input_bytes: 0, saved_bytes: 0 },
  formats: [
    { format: 'jpg', outcome: 'compressed', file_count: 1, input_bytes: 4096, output_bytes: 2048 },
    { format: 'jpg', outcome: 'preserved', file_count: 1, input_bytes: 4096, output_bytes: 4096 },
  ],
});
describe('Document statistics snapshot', () => {
  const storage = new Map<string, string>();
  beforeEach(() => {
    vi.resetModules();
    storage.clear();
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, v),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(Response.json(sample())))
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  it('shares one promise across subscribers and repeated calls, persists only public fields', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ ...sample(), filename: 'private-extra' }));
    const { loadStatisticsOnce } = await import('./statistics');
    const a = loadStatisticsOnce(),
      b = loadStatisticsOnce();
    expect(a).toBe(b);
    expect((await a).stale).toBe(false);
    await loadStatisticsOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      '/api/stats',
      expect.objectContaining({ cache: 'no-store' })
    );
    expect([...storage.values()][0]).not.toContain('private-extra');
  });
  it('memoizes a failure and retains a validated stale snapshot', async () => {
    storage.set('bebismash.public-stats.v2', JSON.stringify(sample()));
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    const { loadStatisticsOnce } = await import('./statistics');
    expect(await loadStatisticsOnce()).toEqual({ stats: sample(), stale: true });
    await loadStatisticsOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('skips known-offline boot and does not retry after reconnect', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const { loadStatisticsOnce } = await import('./statistics');
    expect((await loadStatisticsOnce()).stats).toBeNull();
    vi.stubGlobal('navigator', { onLine: true });
    await loadStatisticsOnce();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    {},
    { ...sample(), saved_bytes: 0 },
    { ...sample(), formats: [] },
    { ...sample(), total_files_processed: -1 },
    { ...sample(), updated_at: 'invalid' },
  ])('rejects malformed or inconsistent server/cache data', async (value) => {
    storage.set('bebismash.public-stats.v2', JSON.stringify(value));
    vi.mocked(fetch).mockResolvedValue(Response.json(value));
    const { loadStatisticsOnce } = await import('./statistics');
    expect(await loadStatisticsOnce()).toEqual({ stats: null, stale: true });
  });
  it('works with unavailable storage and a failing HTTP endpoint', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw Error('blocked');
      },
      setItem: () => {
        throw Error('blocked');
      },
    });
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 503 }));
    const { loadStatisticsOnce } = await import('./statistics');
    expect((await loadStatisticsOnce()).stats).toBeNull();
  });
  it('stops reading an oversized response and cancels its stream', async () => {
    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(32769));
      },
      cancel: cancelled,
    });
    vi.mocked(fetch).mockResolvedValue(new Response(stream));
    const { loadStatisticsOnce } = await import('./statistics');
    expect((await loadStatisticsOnce()).stats).toBeNull();
    expect(cancelled).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('aborts a stalled stats request without a retry', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockImplementation(
      (_u, o) =>
        new Promise((_r, reject) =>
          o!.signal!.addEventListener('abort', () => reject(Error('aborted')))
        )
    );
    const { loadStatisticsOnce } = await import('./statistics');
    const p = loadStatisticsOnce();
    await vi.advanceTimersByTimeAsync(5000);
    expect((await p).stats).toBeNull();
    await loadStatisticsOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
