import type { WorkerCommand, WorkerEvent, Stage } from '../core/types';
type Start = Extract<WorkerCommand, { type: 'start' }>;

/** Installed only inside an admitted worker. Native module requests remain browser-managed. */
export function observeEngineDownloads(cmd: Start) {
  let downloadFailed = false;
  const original = globalThis.fetch;
  const instantiate = WebAssembly.instantiate;
  const instantiateStreaming = WebAssembly.instantiateStreaming;
  let phase: Stage = 'load';
  let detail = 'Loading compression engine';
  const ids = {
    version: 1 as const,
    batchId: cmd.batchId,
    jobId: cmd.jobId,
    attemptId: cmd.attemptId,
  };
  const pending = new Map<string, { completed: number; total: number | null; cached: boolean }>();
  const emit = (
    name: string,
    state: Extract<WorkerEvent, { type: 'asset' }>['state'],
    completed: number,
    total: number | null
  ) => postMessage({ ...ids, type: 'asset', name, state, completed, total } satisfies WorkerEvent);
  const markReady = () => {
    for (const [name, value] of pending)
      emit(name, value.cached ? 'cached' : 'ready', value.completed, value.total);
    pending.clear();
    postMessage({ ...ids, type: 'status', stage: phase, detail } satisfies WorkerEvent);
  };
  WebAssembly.instantiate = (async (
    source: BufferSource | WebAssembly.Module,
    imports?: WebAssembly.Imports
  ) => {
    const result = await instantiate(source as WebAssembly.Module, imports);
    markReady();
    return result;
  }) as typeof WebAssembly.instantiate;
  WebAssembly.instantiateStreaming = async (source, imports) => {
    const result = await instantiateStreaming(source, imports);
    markReady();
    return result;
  };
  globalThis.fetch = async (input, options) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!/\.wasm(?:$|\?)/.test(url)) return original(input, options);
    const name = new URL(url, globalThis.location.href).pathname.split('/').pop()!;
    emit(name, 'downloading', 0, null);
    try {
      const response = await original(input, options);
      if (!response.ok || !response.headers.get('content-type')?.includes('application/wasm'))
        throw new Error(`Engine asset ${name}: HTTP ${response.status}; expected application/wasm`);
      const length = Number(response.headers.get('content-length'));
      const total = !response.headers.get('content-encoding') && length > 0 ? length : null;
      let completed = 0;
      const reader = response.body?.getReader();
      if (!reader) throw new Error(`Engine asset ${name}: response has no body`);
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const item = await reader.read();
            if (item.done) {
              controller.close();
              reader.releaseLock();
              const timing = performance.getEntriesByName(response.url).at(-1) as
                PerformanceResourceTiming | undefined;
              pending.set(name, {
                completed,
                total,
                cached: Boolean(timing && timing.transferSize === 0 && timing.decodedBodySize > 0),
              });
              emit(name, 'initializing', completed, total);
              postMessage({
                ...ids,
                type: 'status',
                stage: 'init',
                detail: `Initializing WASM: ${name}`,
              } satisfies WorkerEvent);
            } else {
              completed += item.value.byteLength;
              if (completed > 64 * 1024 * 1024)
                throw new Error('Engine asset exceeds 64 MiB limit');
              emit(name, 'downloading', completed, total);
              controller.enqueue(item.value);
            }
          } catch (error) {
            downloadFailed = true;
            emit(name, 'failed', completed, total);
            controller.error(error);
          }
        },
        cancel: (reason) => reader.cancel(reason),
      });
      return new Response(stream, { status: response.status, headers: response.headers });
    } catch (error) {
      downloadFailed = true;
      emit(name, 'failed', 0, null);
      throw error;
    }
  };
  return {
    failed: () => downloadFailed,
    phase(next: Stage, message: string) {
      phase = next;
      detail = message;
    },
    ready() {
      for (const [name, value] of pending)
        emit(name, value.cached ? 'cached' : 'ready', value.completed, value.total);
      pending.clear();
    },
    restore() {
      globalThis.fetch = original;
      WebAssembly.instantiate = instantiate;
      WebAssembly.instantiateStreaming = instantiateStreaming;
    },
  };
}
