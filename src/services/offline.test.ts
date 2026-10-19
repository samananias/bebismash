import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';

describe('Explicit offline setup ownership', () => {
  let register: ReturnType<typeof vi.fn>;
  let post: ReturnType<typeof vi.fn>;
  let channels: {
    port1: {
      close: ReturnType<typeof vi.fn>;
      onmessage: ((event: { data: { ok: boolean } }) => void) | null;
    };
    port2: { close: ReturnType<typeof vi.fn> };
  }[];
  beforeEach(() => {
    vi.resetModules();
    channels = [];
    vi.stubGlobal(
      'MessageChannel',
      class {
        port1 = {
          close: vi.fn(),
          onmessage: null as ((event: { data: { ok: boolean } }) => void) | null,
        };
        port2 = { close: vi.fn() };
        constructor() {
          channels.push(this);
        }
      }
    );
    post = vi.fn(() => {
      channels[0]!.port1.onmessage!({ data: { ok: true } });
      channels[0]!.port2.close();
    });
    register = vi
      .fn()
      .mockResolvedValue({ active: { state: 'activated', postMessage: post }, waiting: null });
    vi.stubGlobal('navigator', { onLine: true, serviceWorker: { register } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  it('shares preparation, transfers the port explicitly, and closes on completion', async () => {
    const { prepareOffline } = await import('./offline');
    const a = prepareOffline(),
      b = prepareOffline();
    expect(a).toBe(b);
    await a;
    expect(register).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith({ type: 'PREPARE_OFFLINE' }, [channels[0]!.port2]);
    expect(channels[0]!.port1.close).toHaveBeenCalledOnce();
  });
  it('releases ports and timer if posting to a replaced worker throws', async () => {
    vi.useFakeTimers();
    post.mockImplementation(() => {
      throw Error('worker replaced');
    });
    const { prepareOffline } = await import('./offline');
    await expect(prepareOffline()).rejects.toThrow('worker replaced');
    expect(channels[0]!.port1.close).toHaveBeenCalledOnce();
    expect(channels[0]!.port2.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('times out a nonresponsive worker and does not start another request', async () => {
    vi.useFakeTimers();
    post.mockImplementation(() => {});
    const { prepareOffline } = await import('./offline');
    const pending = prepareOffline();
    const rejection = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(120000);
    await rejection;
    expect(channels[0]!.port1.close).toHaveBeenCalledOnce();
    expect(register).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not register or fetch when offline', async () => {
    vi.stubGlobal('navigator', { onLine: false, serviceWorker: { register } });
    const { prepareOffline } = await import('./offline');
    await expect(prepareOffline()).rejects.toThrow('secure online browser');
    expect(register).not.toHaveBeenCalled();
    expect(channels).toEqual([]);
  });
  it('keeps waiting updates from replacing an active version', async () => {
    register.mockResolvedValue({ active: { state: 'activated', postMessage: post }, waiting: {} });
    const { prepareOffline } = await import('./offline');
    await expect(prepareOffline()).rejects.toThrow('Close other');
    expect(post).not.toHaveBeenCalled();
    expect(channels).toEqual([]);
  });
});
