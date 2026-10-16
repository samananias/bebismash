import type { StoreApi } from 'zustand';
import type { SmashState, FileState } from './useSmashStore';
import type { IArchiveSink } from '../services/sink';
import { detectHardwareProfile } from '../core/hardware';
import { preservationMessage } from '../core/outcome';
/** Loaded only after explicit processing starts; stale attempts cannot change the store. */
export async function runSmash(
  state: SmashState,
  fileList: File[],
  sink: IArchiveSink | undefined,
  get: () => SmashState,
  set: StoreApi<SmashState>['setState'],
  isCurrent: () => boolean
): Promise<void> {
  let unsubscribe: (() => void) | undefined;
  try {
    set({ hardware: detectHardwareProfile() });
    const { scheduler } = await import('../services/scheduler');
    if (!isCurrent()) return;
    unsubscribe = scheduler.subscribe((event) => {
      if (!isCurrent()) return;
      if (event.type === 'zip-complete') {
        set({ phase: 'finalizing' });
        return;
      }
      if (event.type === 'entry-packed') {
        set((current) => ({
          completedEntries: current.completedEntries + 1,
          files: {
            ...current.files,
            [event.entryId]: {
              ...current.files[event.entryId]!,
              status: 'packed',
              stage: 'save',
              progress: null,
              detail: 'Entry packed; waiting for archive to finish',
            },
          },
        }));
        return;
      }
      if (!('jobId' in event)) return;
      set((current) => {
        const file = current.files[event.jobId];
        if (!file || (file.attemptId && file.attemptId !== event.attemptId)) return current;
        const now = Date.now();
        const next: FileState = {
          ...file,
          attemptId: event.attemptId,
          status: file.status === 'packed' ? 'packed' : 'running',
          startedAt: file.startedAt ?? now,
          lastHeartbeatAt: now,
        };
        if (event.type === 'status') {
          if (next.stage !== event.stage) next.lastProgressAt = now;
          if (event.media) next.media = event.media;
          next.stage = event.stage;
          next.detail = event.detail;
          next.progress = null;
          next.completed = 0;
          next.total = null;
          next.engine = event.engine ?? next.engine;
          next.reservedBytes = event.reservedBytes ?? next.reservedBytes;
        } else if (event.type === 'progress') {
          if (
            !Number.isFinite(event.completed) ||
            event.completed < 0 ||
            (event.total !== null &&
              (!Number.isFinite(event.total) || event.total < event.completed))
          )
            return current;
          if (next.stage !== event.stage || next.completed !== event.completed)
            next.lastProgressAt = now;
          next.stage = event.stage;
          next.completed = event.completed;
          next.total = event.total;
          next.unit = event.unit;
          next.progress =
            event.total && event.total > 0
              ? Math.min(100, (event.completed / event.total) * 100)
              : null;
          next.detail =
            event.stage === 'save'
              ? 'Writing output file'
              : event.stage === 'pack'
                ? 'Sending output to ZIP worker'
                : event.stage === 'transform'
                  ? event.unit === 'frames'
                    ? 'Processing video frames'
                    : 'Processing video timeline'
                  : 'Processing; percentage unavailable';
        } else if (event.type === 'asset') {
          const previous = next.assets[event.name];
          if (!previous || previous.completed !== event.completed || previous.state !== event.state)
            next.lastProgressAt = now;
          next.assets = {
            ...next.assets,
            [event.name]: { state: event.state, completed: event.completed, total: event.total },
          };
          if (event.state === 'downloading') {
            next.stage = 'load';
            next.detail = 'Downloading engine asset; your file stays on this device';
            next.completed = event.completed;
            next.total = event.total;
            next.unit = 'bytes';
            next.progress = event.total ? (event.completed / event.total) * 100 : null;
          }
        } else if (event.type === 'result') {
          next.outputBytes = event.outputBytes;
          next.disposition = event.disposition;
          next.preservationReason = event.reason;
          next.durationMs = event.durationMs;
          next.status = 'awaiting-pack';
          next.stage = state.order.length === 1 ? 'save' : 'pack';
          next.progress = null;
          next.lastProgressAt = now;
          next.detail =
            event.disposition === 'original' && state.order.length === 1
              ? preservationMessage(event.reason)
              : event.disposition === 'original'
                ? state.order.length === 1
                  ? 'Original retained; preparing download'
                  : 'Original retained; packaging without media compression'
                : state.order.length === 1
                  ? 'Output prepared; saving file'
                  : 'Output prepared; packaging ZIP';
        } else if (event.type === 'error') {
          next.error = event.error;
          next.status = 'failed';
        }
        return { batchId: event.batchId, files: { ...current.files, [event.jobId]: next } };
      });
    });
    const result = await scheduler.processBatch(fileList, state.intensity, sink, state.order);
    if (!isCurrent()) {
      if (result.archive?.url) URL.revokeObjectURL(result.archive.url);
      return;
    }
    set({
      phase: 'complete',
      batchId: result.batchId,
      archiveBytes: result.archive?.bytes ?? 0,
      completedEntries: result.totalFiles,
      files: Object.fromEntries(
        state.order.map((id, index) => [
          id,
          {
            ...get().files[id]!,
            status: 'packed' as const,
            outputBytes: result.results[index]?.compressedBytes ?? null,
            disposition: result.results[index]?.disposition ?? null,
            preservationReason: result.results[index]?.reason,
            progress: 100,
            detail:
              result.results[index]?.disposition === 'original'
                ? preservationMessage(result.results[index]?.reason) +
                  (result.packaging === 'zip'
                    ? ' Original included in ZIP.'
                    : ' No duplicate saved.')
                : result.packaging === 'file'
                  ? 'Smaller file ready'
                  : 'Smaller file included in ZIP',
          },
        ])
      ),
      download: result.archive
        ? {
            name: result.archive.name,
            bytes: result.archive.bytes,
            kind: result.archive.kind,
            packaging: result.packaging,
            ready: true,
            url: result.archive.url,
          }
        : null,
    });

    if (get().telemetryConsent && result.results && result.results.length > 0) {
      void import('../services/telemetry')
        .then(({ submitTelemetryBatch }) => {
          if (get().telemetryConsent) return submitTelemetryBatch(result.results, true);
        })
        .catch(() => {});
    }
  } finally {
    unsubscribe?.();
  }
}
