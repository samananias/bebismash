import { afterEach, describe, expect, it, vi } from 'vitest';
import { observeEngineDownloads } from './engineDownloads';
import type { WorkerCommand, WorkerEvent } from '../core/types';
const cmd = { version: 1, batchId: 'batch', jobId: 'job', attemptId: 'attempt' } as Extract<
  WorkerCommand,
  { type: 'start' }
>;
const originalInstantiate = WebAssembly.instantiate;
const originalStreaming = WebAssembly.instantiateStreaming;
afterEach(() => {
  WebAssembly.instantiate = originalInstantiate;
  WebAssembly.instantiateStreaming = originalStreaming;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe('engine download instrumentation', () => {
  it.each([false, true])('reports real bytes and cache evidence (cached=%s)', async (cached) => {
    const events: WorkerEvent[] = [];
    vi.stubGlobal('postMessage', (event: WorkerEvent) => events.push(event));
    vi.stubGlobal('location', { href: 'https://local.test/' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]), {
          headers: { 'content-type': 'application/wasm', 'content-length': '8' },
        })
      )
    );
    vi.spyOn(performance, 'getEntriesByName').mockReturnValue(
      cached ? [{ transferSize: 0, decodedBodySize: 8 } as unknown as PerformanceEntry] : []
    );
    const observer = observeEngineDownloads(cmd);
    observer.phase('decode', 'Decoding image');
    await WebAssembly.instantiateStreaming(await fetch('https://local.test/engine.wasm'));
    const assets = events.filter((event) => event.type === 'asset');
    expect(
      assets.some(
        (event) => event.state === 'downloading' && event.completed === 8 && event.total === 8
      )
    ).toBe(true);
    expect(assets.at(-1)?.state).toBe(cached ? 'cached' : 'ready');
    expect(events.at(-1)).toMatchObject({ type: 'status', stage: 'decode' });
    observer.restore();
  });
  it('rejects missing/HTML assets and emits failed instead of remaining pending', async () => {
    const events: WorkerEvent[] = [];
    vi.stubGlobal('postMessage', (event: WorkerEvent) => events.push(event));
    vi.stubGlobal('location', { href: 'https://local.test/' });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response('<html>', { headers: { 'content-type': 'text/html' } }))
    );
    const observer = observeEngineDownloads(cmd);
    await expect(fetch('https://local.test/missing.wasm')).rejects.toThrow(
      'expected application/wasm'
    );
    expect(events.at(-1)).toMatchObject({ type: 'asset', state: 'failed' });
    observer.restore();
  });
});
