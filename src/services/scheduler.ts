import type { BatchId, HardwareProfile, Intensity, WorkerEvent, ZipEvent } from '../core/types';
import { detectHardwareProfile } from '../core/hardware';

export type SchedulerEventListener = (event: WorkerEvent | ZipEvent) => void;

export interface IScheduler {
  getHardwareProfile(): HardwareProfile;
  startBatch(files: File[], intensity: Intensity): Promise<BatchId>;
  cancelBatch(batchId: BatchId): Promise<void>;
  subscribe(listener: SchedulerEventListener): () => void;
}

/**
 * MockScheduler facade for M0 milestone.
 * Provides frozen interface compliance for UI/State and protocol verification
 * without loading heavy codec engines.
 */
export class MockScheduler implements IScheduler {
  private profile: HardwareProfile;
  private listeners = new Set<SchedulerEventListener>();
  private activeBatches = new Set<BatchId>();

  constructor() {
    this.profile = detectHardwareProfile();
  }

  getHardwareProfile(): HardwareProfile {
    return this.profile;
  }

  async startBatch(files: File[], _intensity: Intensity): Promise<BatchId> {
    const batchId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    this.activeBatches.add(batchId);

    // Validate inputs
    if (files.length === 0) {
      throw new Error('Cannot start batch with zero files');
    }

    return batchId;
  }

  async cancelBatch(batchId: BatchId): Promise<void> {
    this.activeBatches.delete(batchId);
  }

  subscribe(listener: SchedulerEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  protected emit(event: WorkerEvent | ZipEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

export const scheduler = new MockScheduler();
