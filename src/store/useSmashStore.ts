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

  // Actions
  stageFiles: (fileList: readonly File[]) => void;
  removeFile: (id: JobId) => void;
  clearQueue: () => void;
  setIntensity: (intensity: Intensity) => void;
  startSmash: () => Promise<void>;
  cancelSmash: () => Promise<void>;
  reset: () => void;
}

// Local File Handle Registry outside of Zustand store state
const fileRegistry = new Map<JobId, File>();

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

  stageFiles: (newFiles: readonly File[]) => {
    const state = get();
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
    fileRegistry.clear();
    set({
      files: {},
      order: [],
      queuedBytes: 0,
      download: null,
      phase: 'idle',
      errorMessage: null,
    });
  },

  setIntensity: (intensity: Intensity) => {
    set({ intensity });
  },

  startSmash: async () => {
    const state = get();
    const fileList: File[] = [];
    for (const id of state.order) {
      const file = fileRegistry.get(id);
      if (file) fileList.push(file);
    }

    if (fileList.length === 0) return;

    set({
      phase: 'running',
      errorMessage: null,
      download: null,
    });

    try {
      const { scheduler } = await import('../services/scheduler');
      const result = await scheduler.processBatch(fileList, state.intensity);
      set({
        phase: 'complete',
        batchId: result.batchId,
        archiveBytes: result.archive.bytes,
        download: {
          name: result.archive.name,
          bytes: result.archive.bytes,
          kind: result.archive.kind,
          ready: true,
          url: result.archive.url,
        },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Processing failed';
      set({
        phase: 'failed',
        errorMessage: message,
      });
    }
  },

  cancelSmash: async () => {
    set({ phase: 'cancelling' });
    const { scheduler } = await import('../services/scheduler');
    await scheduler.cancel();
    set({ phase: 'cancelled' });
  },

  reset: () => {
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
