import { create } from 'zustand';
import type { IArchiveSink } from '../services/sink';
import type {
  BatchId,
  JobId,
  AttemptId,
  Intensity,
  Stage,
  HardwareProfile,
  RouteDecision,
  WireError,
  BatchSummary,
  WorkerEvent,
} from '../core/types';
import { detectHardwareProfile } from '../core/hardware';

export type FileStatus =
  | 'staged'
  | 'inspecting'
  | 'queued'
  | 'running'
  | 'awaiting-pack'
  | 'packed'
  | 'failed'
  | 'cancelled';

export interface FileState {
  media?: Extract<WorkerEvent, { type: 'status' }>['media'];
  detail: string;
  engine: string | null;
  startedAt: number | null;
  lastProgressAt: number | null;
  lastHeartbeatAt: number | null;
  completed: number;
  total: number | null;
  unit: 'bytes' | 'frames' | 'steps';
  reservedBytes: number;
  assets: Record<
    string,
    Pick<Extract<WorkerEvent, { type: 'asset' }>, 'state' | 'completed' | 'total'>
  >;
  id: JobId;
  attemptId: AttemptId | null;
  name: string;
  originalBytes: number;
  outputBytes: number | null;
  status: FileStatus;
  route: RouteDecision | null;
  stage: Stage | null;
  progress: number | null;
  durationMs: number | null;
  disposition: 'transformed' | 'original' | null;
  error: WireError | null;
}

export interface SmashState {
  phase:
    | 'idle'
    | 'validating'
    | 'awaiting-confirmation'
    | 'running'
    | 'finalizing'
    | 'complete'
    | 'cancelling'
    | 'cancelled'
    | 'failed';
  batchId: BatchId | null;
  order: JobId[];
  files: Record<JobId, FileState>;
  intensity: Intensity;
  hardware: HardwareProfile | null;
  reservedBytes: number;
  queuedBytes: number;
  completedEntries: number;
  archiveBytes: number;
  summary: BatchSummary | null;
  download: {
    name: string;
    bytes: number;
    kind: 'blob' | 'disk';
    packaging: 'file' | 'zip';
    ready: boolean;
    url?: string | undefined;
  } | null;
  errorMessage: string | null;
  telemetryConsent: boolean;

  // Actions
  stageFiles: (fileList: readonly File[]) => void;
  removeFile: (id: JobId) => void;
  clearQueue: () => void;
  setIntensity: (intensity: Intensity) => void;
  setTelemetryConsent: (value: boolean) => void;
  startSmash: (sink?: IArchiveSink) => Promise<void>;
  cancelSmash: () => Promise<void>;
  reset: () => void;
}

// Local File Handle Registry outside of Zustand store state
const fileRegistry = new Map<JobId, File>();
let runVersion = 0;
const activePhases: SmashState['phase'][] = [
  'validating',
  'awaiting-confirmation',
  'running',
  'finalizing',
  'cancelling',
];
const canEdit = (state: SmashState) =>
  !activePhases.includes(state.phase) && state.phase !== 'complete';
const releaseDownload = (state: SmashState) => {
  if (state.download?.url) URL.revokeObjectURL(state.download.url);
};

export const useSmashStore = create<SmashState>((set, get) => ({
  phase: 'idle',
  batchId: null,
  order: [],
  files: {},
  intensity: 'balanced',
  hardware: typeof window !== 'undefined' ? detectHardwareProfile() : null,
  reservedBytes: 0,
  queuedBytes: 0,
  completedEntries: 0,
  archiveBytes: 0,
  summary: null,
  download: null,
  errorMessage: null,
  telemetryConsent: false,

  stageFiles: (newFiles: readonly File[]) => {
    const state = get();
    if (!canEdit(state)) return;
    const updatedFiles = { ...state.files };
    const updatedOrder = [...state.order];
    let addedBytes = 0;

    for (let i = 0; i < newFiles.length; i++) {
      const file = newFiles[i]!;
      const jobId = `job-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`;
      fileRegistry.set(jobId, file);

      updatedFiles[jobId] = {
        detail: 'Waiting to start',
        engine: null,
        startedAt: null,
        lastProgressAt: null,
        lastHeartbeatAt: null,
        completed: 0,
        total: null,
        unit: 'bytes',
        reservedBytes: 0,
        assets: {},
        id: jobId,
        attemptId: null,
        name: file.name,
        originalBytes: file.size,
        outputBytes: null,
        status: 'staged',
        route: null,
        stage: null,
        progress: null,
        durationMs: null,
        disposition: null,
        error: null,
      };
      updatedOrder.push(jobId);
      addedBytes += file.size;
    }

    set({
      files: updatedFiles,
      order: updatedOrder,
      queuedBytes: state.queuedBytes + addedBytes,
      errorMessage: null,
    });
  },

  removeFile: (id: JobId) => {
    if (!canEdit(get())) return;
    fileRegistry.delete(id);
    const state = get();
    const file = state.files[id];
    const removedBytes = file ? file.originalBytes : 0;
    const { [id]: _, ...remainingFiles } = state.files;

    set({
      files: remainingFiles,
      order: state.order.filter((jobId) => jobId !== id),
      queuedBytes: Math.max(0, state.queuedBytes - removedBytes),
    });
  },

  clearQueue: () => {
    if (!canEdit(get())) return;
    runVersion++;
    releaseDownload(get());
    fileRegistry.clear();
    set({
      files: {},
      order: [],
      queuedBytes: 0,
      download: null,
      phase: 'idle',
      errorMessage: null,
      summary: null,
      completedEntries: 0,
      archiveBytes: 0,
    });
  },

  setIntensity: (intensity: Intensity) => {
    if (!canEdit(get())) return;
    set({ intensity });
  },

  setTelemetryConsent: (value: boolean) => {
    set({ telemetryConsent: value });
  },

  startSmash: async (sink) => {
    const state = get();
    if (!canEdit(state)) return;
    const fileList: File[] = [];
    for (const id of state.order) {
      const file = fileRegistry.get(id);
      if (file) fileList.push(file);
    }

    if (fileList.length === 0) return;

    const version = ++runVersion;
    releaseDownload(state);

    set({
      phase: 'running',
      completedEntries: 0,
      archiveBytes: 0,
      errorMessage: null,
      download: null,
      files: Object.fromEntries(
        state.order.map((id) => [
          id,
          {
            ...state.files[id]!,
            status: 'queued' as const,
            attemptId: null,
            outputBytes: null,
            progress: null,
            stage: null,
            detail: 'Waiting for worker admission',
            assets: {},
            startedAt: null,
            lastProgressAt: null,
            lastHeartbeatAt: null,
            completed: 0,
            total: null,
            error: null,
          },
        ])
      ),
    });

    let unsubscribe: (() => void) | undefined;
    try {
      const { scheduler } = await import('../services/scheduler');
      if (version !== runVersion) return;
      unsubscribe = scheduler.subscribe((event) => {
        if (version !== runVersion) return;
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
            if (
              !previous ||
              previous.completed !== event.completed ||
              previous.state !== event.state
            )
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
            next.durationMs = event.durationMs;
            next.status = 'awaiting-pack';
            next.stage = state.order.length === 1 ? 'save' : 'pack';
            next.progress = null;
            next.lastProgressAt = now;
            next.detail =
              event.disposition === 'original'
                ? state.order.length === 1 ? 'Original retained; preparing download' : 'Original retained; packaging without media compression'
                : state.order.length === 1 ? 'Output prepared; saving file' : 'Output prepared; packaging ZIP';
          } else if (event.type === 'error') {
            next.error = event.error;
            next.status = 'failed';
          }
          return { batchId: event.batchId, files: { ...current.files, [event.jobId]: next } };
        });
      });
      const result = await scheduler.processBatch(fileList, state.intensity, sink, state.order);
      if (version !== runVersion) {
        if (result.archive.url) URL.revokeObjectURL(result.archive.url);
        return;
      }
      set({
        phase: 'complete',
        batchId: result.batchId,
        archiveBytes: result.archive.bytes,
        completedEntries: result.totalFiles,
        files: Object.fromEntries(
          state.order.map((id, index) => [
            id,
            {
              ...get().files[id]!,
              status: 'packed' as const,
              outputBytes: result.results[index]?.compressedBytes ?? null,
              progress: 100,
              detail: result.packaging === 'file' ? 'File ready' : 'Archive ready',
            },
          ])
        ),
        download: {
          name: result.archive.name,
          bytes: result.archive.bytes,
          kind: result.archive.kind,
          packaging: result.packaging,
          ready: true,
          url: result.archive.url,
        },
      });

      if (get().telemetryConsent && result.results && result.results.length > 0) {
        void import('../services/telemetry')
          .then(({ submitTelemetryBatch }) => {
            if (get().telemetryConsent) return submitTelemetryBatch(result.results, true);
          })
          .catch(() => {});
      }
    } catch (err: unknown) {
      if (version !== runVersion) return;
      const message = err instanceof Error ? err.message : 'Processing failed';
      set({
        phase: 'failed',
        errorMessage: message,
        files: Object.fromEntries(
          state.order.map((id) => [
            id,
            {
              ...get().files[id]!,
              status: 'failed' as const,
              progress: null,
              detail:
                get().files[id]?.status === 'queued'
                  ? 'Batch stopped before this file started'
                  : message,
            },
          ])
        ),
      });
    } finally {
      unsubscribe?.();
    }
  },

  cancelSmash: async () => {
    if (!activePhases.includes(get().phase) || get().phase === 'cancelling') return;
    const version = ++runVersion;
    set({ phase: 'cancelling' });
    try {
      const { scheduler } = await import('../services/scheduler');
      await scheduler.cancel();
      if (version === runVersion)
        set((state) => ({
          phase: 'cancelled',
          files: Object.fromEntries(
            state.order.map((id) => [
              id,
              { ...state.files[id]!, status: 'cancelled' as const, progress: null },
            ])
          ),
        }));
    } catch {
      if (version === runVersion)
        set({
          phase: 'failed',
          errorMessage: 'Could not cancel this batch. Reload the page to stop processing.',
        });
    }
  },

  reset: () => {
    if (activePhases.includes(get().phase)) return;
    runVersion++;
    releaseDownload(get());
    fileRegistry.clear();
    set({
      phase: 'idle',
      batchId: null,
      order: [],
      files: {},
      queuedBytes: 0,
      completedEntries: 0,
      archiveBytes: 0,
      summary: null,
      download: null,
      errorMessage: null,
    });
  },
}));
