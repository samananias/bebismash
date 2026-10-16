import { create } from 'zustand';
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
  startSmash: () => Promise<void>;
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

  startSmash: async () => {
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
      errorMessage: null,
      download: null,
      files: Object.fromEntries(
        state.order.map((id) => [
          id,
          { ...state.files[id]!, status: 'running' as const, outputBytes: null, progress: null },
        ])
      ),
    });

    try {
      const { scheduler } = await import('../services/scheduler');
      if (version !== runVersion) return;
      const result = await scheduler.processBatch(fileList, state.intensity);
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
              ...state.files[id]!,
              status: 'packed' as const,
              outputBytes: result.results[index]?.compressedBytes ?? null,
              progress: 100,
            },
          ])
        ),
        download: {
          name: result.archive.name,
          bytes: result.archive.bytes,
          kind: result.archive.kind,
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
            { ...state.files[id]!, status: 'failed' as const, progress: null },
          ])
        ),
      });
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
