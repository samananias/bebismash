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
import { sniffFile, decideRoute, createEnginePolicy } from '../core/sniff';
import type { IArchiveSink, ArchiveSinkResult } from './sink';
import { BlobArchiveSink } from './sink';

export type SchedulerEventListener = (event: WorkerEvent | ZipEvent) => void;

export interface CompletedFileResult {
  extension: string;
  category: 'image' | 'video' | 'document' | 'archive' | 'other';
  intensity: Intensity;
  originalBytes: number;
  compressedBytes: number;
  durationMs: number;
  deviceTier: 'constrained' | 'standard' | 'high';
}

export interface BatchResult {
  batchId: BatchId;
  archive: ArchiveSinkResult;
  totalFiles: number;
  results: CompletedFileResult[];
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
                results: completedResults,
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

        const completedResults: CompletedFileResult[] = [];

        // Process files sequentially or up to maxWorkers concurrency
        (async () => {
          for (let i = 0; i < files.length; i++) {
            if (abortSignal.aborted) return;
            const file = files[i]!;
            const jobId = `job-${i}-${Math.random().toString(36).slice(2, 8)}`;
            const attemptId = `att-1`;
            const entryId = `entry-${i}`;

            const sniffResult = await sniffFile(file);
            const route = decideRoute(sniffResult, file.size, intensity);
            const policy = createEnginePolicy(route.engine, route.format, intensity);

            // Channel between Job Worker and Zip Worker
            const channel = new MessageChannel();

            const isAlreadyCompressed =
              route.format === 'zip' ||
              route.format === 'jpeg' ||
              route.format === 'png' ||
              route.format === 'webp' ||
              route.format === 'avif' ||
              route.format === 'docx' ||
              route.format === 'pptx' ||
              route.format === 'xlsx' ||
              route.format === 'pdf' ||
              route.format === 'mp4' ||
              route.format === 'mov' ||
              route.format === 'webm';

            // Register entry with ZIP worker
            const addCmd: ZipCommand = {
              version: 1,
              batchId,
              type: 'add',
              entry: {
                entryId,
                jobId,
                path: file.name,
                method: isAlreadyCompressed ? 'store' : 'deflate',
                level: intensity === 'heavy' ? 9 : intensity === 'balanced' ? 6 : 4,
                maxBytes: file.size,
              },
              entryPort: channel.port1,
            };
            zipWorker.postMessage(addCmd, [channel.port1]);

            // Keep each URL inside its Worker constructor so Vite compiles the worker graph.
            let jobWorker: Worker;
            if (route.engine === 'image') {
              jobWorker = new Worker(new URL('../workers/image.worker.ts', import.meta.url), {
                type: 'module',
              });
            } else if (route.format === 'pdf') {
              jobWorker = new Worker(new URL('../workers/pdf.worker.ts', import.meta.url), {
                type: 'module',
              });
            } else if (
              route.engine === 'officePdf' &&
              (route.format === 'docx' || route.format === 'pptx' || route.format === 'xlsx')
            ) {
              jobWorker = new Worker(new URL('../workers/office.worker.ts', import.meta.url), {
                type: 'module',
              });
            } else if (route.engine === 'video') {
              jobWorker = new Worker(new URL('../workers/video.worker.ts', import.meta.url), {
                type: 'module',
              });
            } else {
              jobWorker = new Worker(new URL('../workers/generic.worker.ts', import.meta.url), {
                type: 'module',
              });
            }

            this.activeWorkers.add(jobWorker);

            await new Promise<void>((jobResolve, jobReject) => {
              jobWorker.onmessage = (workerMsg: MessageEvent<WorkerEvent>) => {
                const wEvent = workerMsg.data;
                this.emit(wEvent);

                if (wEvent.type === 'result') {
                  const rawExt = file.name.split('.').pop()?.toLowerCase() || 'other';
                  const category =
                    route.engine === 'video'
                      ? 'video'
                      : route.engine === 'image'
                        ? 'image'
                        : route.format === 'zip'
                          ? 'archive'
                          : route.engine === 'generic' || route.format === 'unknown'
                            ? 'other'
                            : 'document';

                  completedResults.push({
                    extension: rawExt,
                    category,
                    intensity,
                    originalBytes: file.size,
                    compressedBytes: wEvent.outputBytes,
                    durationMs: wEvent.durationMs,
                    deviceTier: this.profile.tier,
                  });

                  jobWorker.terminate();
                  this.activeWorkers.delete(jobWorker);
                  jobResolve();
                } else if (wEvent.type === 'error') {
                  jobWorker.terminate();
                  this.activeWorkers.delete(jobWorker);
                  jobReject(new Error(wEvent.error.code));
                }
              };

              const maxPixels =
                this.profile.tier === 'constrained'
                  ? 12_000_000
                  : this.profile.tier === 'standard'
                    ? 24_000_000
                    : 48_000_000;

              const startCmd: WorkerCommand = {
                version: 1,
                batchId,
                jobId,
                attemptId,
                type: 'start',
                source: file,
                sourceMode: 'worker-ranges',
                config: {
                  engine: route.engine,
                  format: route.format,
                  intensity,
                  policy,
                  limits: {
                    maxInputBytes: 2 * 1024 * 1024 * 1024,
                    maxOutputBytes: this.profile.blobLimitBytes,
                    maxPixels,
                    maxExpandedBytes: 200 * 1024 * 1024,
                    maxEntryBytes: 100 * 1024 * 1024,
                    maxEntries: 1000,
                    maxExpansionRatio: 100,
                    maxWallTimeMs: 60_000,
                  },
                  allowMultithreadedWasm: false,
                },
                outputPort: channel.port2,
              };

              jobWorker.postMessage(startCmd, [channel.port2]);
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
