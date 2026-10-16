import type {
  BatchId,
  HardwareProfile,
  Intensity,
  WorkerEvent,
  ZipEvent,
  ZipCommand,
  WorkerCommand,
} from '../core/types';
import { detectHardwareProfile } from '../core/hardware';
import { sniffFile, decideRoute } from '../core/sniff';
import type { IArchiveSink, ArchiveSinkResult } from './sink';
import { BlobArchiveSink } from './sink';

export type SchedulerEventListener = (event: WorkerEvent | ZipEvent) => void;

export interface BatchResult {
  batchId: BatchId;
  archive: ArchiveSinkResult;
  totalFiles: number;
}

export class BatchScheduler {
  private profile: HardwareProfile;
  private listeners = new Set<SchedulerEventListener>();
  private activeZipWorker: Worker | null = null;
  private activeWorkers = new Set<Worker>();
  private currentAbortController: AbortController | null = null;
  private isProcessing = false;

  constructor() {
    this.profile = detectHardwareProfile();
  }

  getHardwareProfile(): HardwareProfile {
    return this.profile;
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

  async processBatch(
    files: File[],
    intensity: Intensity,
    customSink?: IArchiveSink
  ): Promise<BatchResult> {
    if (this.isProcessing) {
      throw new Error('A batch is already in progress');
    }
    if (files.length === 0) {
      throw new Error('Cannot process empty file list');
    }

    this.isProcessing = true;
    const batchId: BatchId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    this.currentAbortController = new AbortController();
    const abortSignal = this.currentAbortController.signal;

    // Use provided sink or default to bounded BlobArchiveSink
    const sink: IArchiveSink = customSink || new BlobArchiveSink(this.profile.blobLimitBytes);

    const archiveName = `BebiSmash_${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
    await sink.open(archiveName);

    return new Promise<BatchResult>((resolve, reject) => {
      let isResolved = false;

      const cleanup = async () => {
        this.isProcessing = false;
        if (this.activeZipWorker) {
          this.activeZipWorker.terminate();
          this.activeZipWorker = null;
        }
        for (const worker of this.activeWorkers) {
          worker.terminate();
        }
        this.activeWorkers.clear();
      };

      const fail = async (err: Error) => {
        if (isResolved) return;
        isResolved = true;
        await sink.abort();
        await cleanup();
        reject(err);
      };

      abortSignal.addEventListener('abort', () => {
        fail(new Error('Batch processing was cancelled'));
      });

      try {
        // Instantiate ZIP bundler worker
        const zipWorker = new Worker(new URL('../workers/zip.worker.ts', import.meta.url), {
          type: 'module',
        });
        this.activeZipWorker = zipWorker;

        zipWorker.onmessage = async (e: MessageEvent<ZipEvent>) => {
          const event = e.data;
          this.emit(event);

          if (event.type === 'zip-chunk') {
            try {
              await sink.write(event.chunk);
              // Send sink-ack backpressure acknowledgement
              const ack: ZipCommand = {
                version: 1,
                batchId,
                type: 'sink-ack',
                seq: event.seq,
              };
              zipWorker.postMessage(ack);
            } catch (writeErr) {
              await fail(writeErr as Error);
            }
          } else if (event.type === 'zip-complete') {
            if (isResolved) return;
            isResolved = true;
            try {
              const archiveResult = await sink.close();
              await cleanup();
              resolve({
                batchId,
                archive: archiveResult,
                totalFiles: files.length,
              });
            } catch (closeErr) {
              await fail(closeErr as Error);
            }
          } else if (event.type === 'zip-error') {
            await fail(new Error(`Zip worker error: ${event.error.code}`));
          }
        };

        // Open zip worker
        const openCmd: ZipCommand = {
          version: 1,
          batchId,
          type: 'open',
          maxArchiveBytes: this.profile.blobLimitBytes,
          expectedEntries: files.length,
        };
        zipWorker.postMessage(openCmd);

        // Process files sequentially or up to maxWorkers concurrency
        // In M1, process files through generic worker
        (async () => {
          for (let i = 0; i < files.length; i++) {
            if (abortSignal.aborted) return;
            const file = files[i]!;
            const jobId = `job-${i}-${Math.random().toString(36).slice(2, 8)}`;
            const attemptId = `att-1`;
            const entryId = `entry-${i}`;

            const sniffResult = await sniffFile(file);
            const route = decideRoute(sniffResult, file.size, intensity);

            // Channel between Generic Worker and Zip Worker
            const channel = new MessageChannel();

            // Register entry with ZIP worker
            const addCmd: ZipCommand = {
              version: 1,
              batchId,
              type: 'add',
              entry: {
                entryId,
                jobId,
                path: file.name,
                method: route.format === 'zip' ? 'store' : 'deflate',
                level: 6,
                maxBytes: file.size,
              },
              entryPort: channel.port1,
            };
            zipWorker.postMessage(addCmd, [channel.port1]);

            // Spawn generic worker
            const genericWorker = new Worker(
              new URL('../workers/generic.worker.ts', import.meta.url),
              { type: 'module' }
            );
            this.activeWorkers.add(genericWorker);

            await new Promise<void>((jobResolve, jobReject) => {
              genericWorker.onmessage = (workerMsg: MessageEvent<WorkerEvent>) => {
                const wEvent = workerMsg.data;
                this.emit(wEvent);

                if (wEvent.type === 'result') {
                  genericWorker.terminate();
                  this.activeWorkers.delete(genericWorker);
                  jobResolve();
                } else if (wEvent.type === 'error') {
                  genericWorker.terminate();
                  this.activeWorkers.delete(genericWorker);
                  jobReject(new Error(wEvent.error.code));
                }
              };

              const startCmd: WorkerCommand = {
                version: 1,
                batchId,
                jobId,
                attemptId,
                type: 'start',
                source: file,
                sourceMode: 'worker-ranges',
                config: {
                  engine: 'generic',
                  format: route.format,
                  intensity,
                  policy: { kind: 'generic', level: 6 },
                  limits: {
                    maxInputBytes: 2 * 1024 * 1024 * 1024,
                    maxOutputBytes: 2 * 1024 * 1024 * 1024,
                    maxPixels: 24_000_000,
                    maxExpandedBytes: 256 * 1024 * 1024,
                    maxEntryBytes: 256 * 1024 * 1024,
                    maxEntries: 1000,
                    maxExpansionRatio: 100,
                    maxWallTimeMs: 60_000,
                  },
                  allowMultithreadedWasm: false,
                },
                outputPort: channel.port2,
              };

              genericWorker.postMessage(startCmd, [channel.port2]);
            });
          }

          // Finish archive once all entries are fed
          if (!abortSignal.aborted && this.activeZipWorker) {
            const finishCmd: ZipCommand = {
              version: 1,
              batchId,
              type: 'finish',
            };
            this.activeZipWorker.postMessage(finishCmd);
          }
        })().catch(fail);
      } catch (err) {
        fail(err as Error);
      }
    });
  }

  async cancel(): Promise<void> {
    if (this.currentAbortController) {
      this.currentAbortController.abort();
      this.currentAbortController = null;
    }
    this.isProcessing = false;
  }
}

export const scheduler = new BatchScheduler();
