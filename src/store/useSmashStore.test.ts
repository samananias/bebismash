import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSmashStore } from './useSmashStore';
import type { BatchResult } from '../services/scheduler';

const mocks = vi.hoisted(() => ({
  processBatch: vi.fn(),
  cancel: vi.fn(),
  submit: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
}));
vi.mock('../services/scheduler', () => ({
  scheduler: { processBatch: mocks.processBatch, cancel: mocks.cancel, subscribe: mocks.subscribe },
}));
vi.mock('../services/telemetry', () => ({ submitTelemetryBatch: mocks.submit }));
const file = () => new File(['content'], 'local.txt', { type: 'text/plain' });
const result = (): BatchResult => ({
  batchId: 'batch-test',
  packaging: 'file',
  totalFiles: 1,
  archive: { name: 'test.zip', bytes: 120, kind: 'blob', url: 'blob:test' },
  results: [
    {
      disposition: 'transformed',
      extension: 'txt',
      category: 'other',
      intensity: 'balanced',
      originalBytes: 7,
      compressedBytes: 3,
      durationMs: 10,
      deviceTier: 'standard',
    },
  ],
});

describe('Monoterm batch state', () => {
  beforeEach(() => {
    useSmashStore.setState({ phase: 'idle' });
    useSmashStore.getState().reset();
    useSmashStore.getState().setTelemetryConsent(false);
    useSmashStore.getState().setIntensity('balanced');
    vi.clearAllMocks();
    mocks.cancel.mockResolvedValue(undefined);
    mocks.subscribe.mockReturnValue(mocks.unsubscribe);
  });
  afterEach(() => {
    useSmashStore.setState({ phase: 'idle' });
    useSmashStore.getState().reset();
    vi.restoreAllMocks();
  });
  it('uses real result bytes and keeps telemetry off by default', async () => {
    mocks.processBatch.mockResolvedValueOnce(result());
    useSmashStore.getState().stageFiles([file()]);
    await useSmashStore.getState().startSmash();
    const state = useSmashStore.getState();
    expect(state.files[state.order[0]!]!.outputBytes).toBe(3);
    expect(state.files[state.order[0]!]!.status).toBe('packed');
    expect(state.download?.bytes).toBe(120);
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it('submits only after completed output with consent still enabled', async () => {
    useSmashStore.getState().setTelemetryConsent(true);
    mocks.processBatch.mockResolvedValueOnce(result());
    useSmashStore.getState().stageFiles([file()]);
    await useSmashStore.getState().startSmash();
    await vi.waitFor(() => expect(mocks.submit).toHaveBeenCalledOnce());
    expect(useSmashStore.getState().download?.ready).toBe(true);
    expect(mocks.submit).toHaveBeenCalledWith(result().results, true);
  });
  it('does not send after consent is revoked while processing', async () => {
    let finish!: (value: BatchResult) => void;
    mocks.processBatch.mockImplementationOnce(
      () =>
        new Promise<BatchResult>((resolve) => {
          finish = resolve;
        })
    );
    useSmashStore.getState().setTelemetryConsent(true);
    useSmashStore.getState().stageFiles([file()]);
    const pending = useSmashStore.getState().startSmash();
    await vi.waitFor(() => expect(mocks.processBatch).toHaveBeenCalledOnce());
    useSmashStore.getState().setTelemetryConsent(false);
    finish(result());
    await pending;
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(useSmashStore.getState().phase).toBe('complete');
  });
  it('locks queue, preset and duplicate starts while processing', async () => {
    let finish!: (value: BatchResult) => void;
    mocks.processBatch.mockImplementationOnce(
      () =>
        new Promise<BatchResult>((resolve) => {
          finish = resolve;
        })
    );
    useSmashStore.getState().stageFiles([file()]);
    const original = useSmashStore.getState().order[0]!;
    const pending = useSmashStore.getState().startSmash();
    await vi.waitFor(() => expect(mocks.processBatch).toHaveBeenCalledOnce());
    useSmashStore.getState().stageFiles([file()]);
    useSmashStore.getState().removeFile(original);
    useSmashStore.getState().clearQueue();
    useSmashStore.getState().reset();
    useSmashStore.getState().setIntensity('heavy');
    await useSmashStore.getState().startSmash();
    expect(useSmashStore.getState().order).toEqual([original]);
    expect(useSmashStore.getState().intensity).toBe('balanced');
    expect(mocks.processBatch).toHaveBeenCalledOnce();
    finish(result());
    await pending;
  });
  it('ignores a late cancellation rejection and retains the original for retry', async () => {
    let reject!: (reason: Error) => void;
    mocks.processBatch.mockImplementationOnce(
      () =>
        new Promise<BatchResult>((_, fail) => {
          reject = fail;
        })
    );
    const source = file();
    useSmashStore.getState().stageFiles([source]);
    const pending = useSmashStore.getState().startSmash();
    await vi.waitFor(() => expect(mocks.processBatch).toHaveBeenCalledOnce());
    await useSmashStore.getState().cancelSmash();
    reject(new Error('cancelled'));
    await pending;
    expect(useSmashStore.getState().phase).toBe('cancelled');
    expect(useSmashStore.getState().errorMessage).toBeNull();
    mocks.processBatch.mockResolvedValueOnce(result());
    await useSmashStore.getState().startSmash();
    expect(mocks.processBatch).toHaveBeenLastCalledWith(
      [source],
      'balanced',
      undefined,
      useSmashStore.getState().order
    );
    expect(useSmashStore.getState().phase).toBe('complete');
  });
  it('revokes a stale completion URL after cancellation', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    let finish!: (value: BatchResult) => void;
    mocks.processBatch.mockImplementationOnce(
      () =>
        new Promise<BatchResult>((resolve) => {
          finish = resolve;
        })
    );
    useSmashStore.getState().stageFiles([file()]);
    const pending = useSmashStore.getState().startSmash();
    await vi.waitFor(() => expect(mocks.processBatch).toHaveBeenCalledOnce());
    await useSmashStore.getState().cancelSmash();
    finish(result());
    await pending;
    expect(useSmashStore.getState().download).toBeNull();
    expect(revoke).toHaveBeenCalledWith('blob:test');
  });
  it('releases the archive URL and file registry on a new batch', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    mocks.processBatch.mockResolvedValueOnce(result());
    useSmashStore.getState().stageFiles([file()]);
    await useSmashStore.getState().startSmash();
    useSmashStore.getState().reset();
    expect(revoke).toHaveBeenCalledWith('blob:test');
    expect(useSmashStore.getState().order).toEqual([]);
    expect(useSmashStore.getState().download).toBeNull();
    await useSmashStore.getState().startSmash();
    expect(mocks.processBatch).toHaveBeenCalledOnce();
  });
  it('retains originals after failure and clears the error on retry', async () => {
    mocks.processBatch.mockRejectedValueOnce(new Error('DECODE_FAILED'));
    useSmashStore.getState().stageFiles([file()]);
    await useSmashStore.getState().startSmash();
    expect(useSmashStore.getState().phase).toBe('failed');
    expect(useSmashStore.getState().errorMessage).toBe('DECODE_FAILED');
    expect(useSmashStore.getState().order).toHaveLength(1);
    mocks.processBatch.mockResolvedValueOnce(result());
    await useSmashStore.getState().startSmash();
    expect(useSmashStore.getState().phase).toBe('complete');
    expect(useSmashStore.getState().errorMessage).toBeNull();
  });
});
