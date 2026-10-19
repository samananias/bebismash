import type {
  BatchId,
  HardwareProfile,
  Intensity,
  WorkerEvent,
  ZipEvent,
  ZipCommand,
  WorkerCommand,
  Stage,
  PreservationReason,
  DocumentPolicy,
  PdfDiagnostics,
} from '../core/types';
import { detectHardwareProfile } from '../core/hardware';
import { sniffFile, decideRoute, createEnginePolicy } from '../core/sniff';
import type { IArchiveSink, ArchiveSinkResult } from './sink';
import { BlobArchiveSink } from './sink';
import { writeDirectOutput } from './directOutput';
import { validPdfDiagnostics } from '../core/pdfDiagnostics';

export type SchedulerEventListener = (event: WorkerEvent | ZipEvent) => void;
export interface CompletedFileResult {
  pdfDiagnostics?: PdfDiagnostics | undefined;
  pdfMetadataRemoved?: number | undefined;
  reason?: PreservationReason | undefined;
  disposition: 'original' | 'transformed';
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
  packaging: 'file' | 'zip';
  archive: ArchiveSinkResult | null;
  totalFiles: number;
  results: CompletedFileResult[];
}

/** Sequential admission keeps one candidate and one credited ZIP entry alive at a time. */
export class BatchScheduler {
  private profile: HardwareProfile;
  private listeners = new Set<SchedulerEventListener>();
  private currentAbortController: AbortController | null = null;
  private pending: Promise<BatchResult> | null = null;
  constructor() {
    this.profile = detectHardwareProfile();
  }
  getHardwareProfile() {
    return this.profile;
  }
  subscribe(listener: SchedulerEventListener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  protected emit(event: WorkerEvent | ZipEvent) {
    for (const listener of this.listeners) listener(event);
  }
  processBatch(
    files: File[],
    intensity: Intensity,
    customSink?: IArchiveSink,
    jobIds?: string[],
    pdfMetadata: NonNullable<DocumentPolicy['pdfMetadata']> = 'preserve'
  ): Promise<BatchResult> {
    if (this.pending) return Promise.reject(new Error('A batch is already in progress'));
    if (!files.length || files.length > 1000)
      return Promise.reject(new Error('Choose between 1 and 1,000 files.'));
    const controller = new AbortController();
    this.currentAbortController = controller;
    const pending = this.run(
      files,
      intensity,
      customSink,
      jobIds,
      controller.signal,
      pdfMetadata
    ).finally(() => {
      if (this.pending === pending) {
        this.pending = null;
        this.currentAbortController = null;
      }
    });
    this.pending = pending;
    return pending;
  }
  private async run(
    files: File[],
    intensity: Intensity,
    customSink: IArchiveSink | undefined,
    jobIds: string[] | undefined,
    signal: AbortSignal,
    pdfMetadata: NonNullable<DocumentPolicy['pdfMetadata']>
  ): Promise<BatchResult> {
    const batchId = crypto.randomUUID();
    const single = files.length === 1;
    const sink = customSink ?? new BlobArchiveSink(this.profile.blobLimitBytes);
    const workers = new Set<Worker>();
    const ports = new Set<MessagePort>();
    const completedResults: CompletedFileResult[] = [];
    let fail!: (error: Error) => void;
    const failure = new Promise<never>((_, reject) => {
      fail = reject;
    });
    // Observe immediately: failures can arrive between sequential awaits.
    void failure.catch(() => {});
    const race = <T>(work: Promise<T>) => Promise.race([work, failure]);
    const cancel = () => {
      for (const worker of workers) worker.terminate();
      for (const port of ports) port.close();
      fail(new Error('Batch processing was cancelled'));
    };
    signal.addEventListener('abort', cancel, { once: true });
    let timer: ReturnType<typeof setInterval> | undefined;
    let lastContact = Date.now();
    let jobDeadline = Date.now() + 30_000;
    let stage: Stage = 'start';
    let jobLabel = 'ZIP worker';
    let retainedBytes = 0;
    const addWorker = (worker: Worker) => {
      workers.add(worker);
      worker.onerror = (event) => {
        event.preventDefault();
        fail(
          new Error(
            `${jobLabel}: worker failed to load or crashed. ${event.message || 'Check engine assets and browser memory.'}`
          )
        );
      };
      worker.onmessageerror = () =>
        fail(new Error(`${jobLabel}: worker message could not be decoded.`));
      return worker;
    };
    try {
      if (signal.aborted) throw new Error('Batch processing was cancelled');
      const opening = single
        ? Promise.resolve()
        : sink.open(`BebiSmash_${new Date().toISOString().replace(/[:.]/g, '-')}.zip`);
      void opening
        .then(() => {
          if (signal.aborted) return sink.abort();
        })
        .catch(() => {});
      await race(opening);
      timer = setInterval(() => {
        const now = Date.now();
        if (now > jobDeadline)
          fail(new Error(`${jobLabel}: ${stage} exceeded its execution deadline.`));
        else if (stage === 'start' && now - lastContact > 30_000)
          fail(new Error(`${jobLabel}: worker initialization timed out after 30 seconds.`));
      }, 1000);
      const zipWorker = single
        ? null
        : addWorker(
            new Worker(new URL('../workers/zip.worker.ts', import.meta.url), { type: 'module' })
          );
      let ready!: () => void;
      const zipReady = new Promise<void>((resolve) => {
        ready = resolve;
      });
      let done!: () => void;
      const zipDone = new Promise<void>((resolve) => {
        done = resolve;
      });
      let packed: (() => void) | undefined;
      let expectedEntry: string | undefined;
      let writeChain = Promise.resolve();
      let expectedSeq = 1;
      if (zipWorker) {
        zipWorker.onmessage = ({ data: event }: MessageEvent<ZipEvent>) => {
          if (!event || typeof event !== 'object') {
            fail(new Error('Invalid ZIP worker message'));
            return;
          }
          if (signal.aborted || event.batchId !== batchId) return;
          if (event.version !== 1) {
            fail(new Error('ZIP protocol version mismatch'));
            return;
          }
          lastContact = Date.now();
          if (event.type === 'zip-chunk') {
            if (
              event.seq !== expectedSeq++ ||
              !(event.chunk.buffer instanceof ArrayBuffer) ||
              event.chunk.byteLength !== event.chunk.buffer.byteLength ||
              event.chunk.byteLength > 256 * 1024
            ) {
              fail(new Error('Invalid ZIP chunk or sequence'));
              return;
            }
            writeChain = writeChain.then(async () => {
              if (signal.aborted) return;
              await sink.write(event.chunk);
              retainedBytes += customSink ? 0 : event.chunk.byteLength;
              zipWorker.postMessage({
                version: 1,
                batchId,
                type: 'sink-ack',
                seq: event.seq,
              } satisfies ZipCommand);
            });
            void writeChain.catch((error: Error) => fail(error));
          } else if (event.type === 'zip-ready') ready();
          else if (event.type === 'entry-packed' && event.entryId === expectedEntry) packed?.();
          else if (event.type === 'zip-complete') done();
          else if (event.type === 'zip-error')
            fail(new Error(`ZIP: ${event.error.code} (${event.error.messageKey})`));
          this.emit(event);
        };
        zipWorker.postMessage({
          version: 1,
          batchId,
          type: 'open',
          maxArchiveBytes: customSink ? 2 ** 31 - 1 : this.profile.blobLimitBytes,
          expectedEntries: files.length,
        } satisfies ZipCommand);
        await race(zipReady);
      }
      const names = new Set<string>();
      for (let i = 0; i < files.length; i++) {
        if (signal.aborted) throw new Error('Batch processing was cancelled');
        const file = files[i]!;
        const ids = {
          version: 1 as const,
          batchId,
          jobId: jobIds?.[i] ?? crypto.randomUUID(),
          attemptId: crypto.randomUUID(),
        };
        const status = (
          nextStage: Stage,
          detail: string,
          engine?: string,
          reservedBytes?: number
        ) => {
          stage = nextStage;
          this.emit({
            ...ids,
            type: 'status',
            stage: nextStage,
            detail,
            ...(engine ? { engine } : {}),
            ...(reservedBytes !== undefined ? { reservedBytes } : {}),
          });
        };
        jobLabel = file.name;
        jobDeadline = Date.now() + 30_000;
        status('inspect', 'Checking file signature and memory budget');
        if (file.size >= 2 ** 31) throw new Error('File exceeds the ZIP32 input limit.');
        const sniff = await race(sniffFile(file));
        const route = decideRoute(sniff, file.size, intensity);
        const overhead = 32 * 1024 * 1024;
        const available = this.profile.memoryBudgetBytes - overhead - 2 * retainedBytes;
        // Reserve sequential image working memory in addition to the full PDF parser/candidate.
        const pdfImageWorkingBytes =
          route.format === 'pdf' && intensity !== 'gentle'
            ? Math.max(0, Math.min(128 * 1024 * 1024, available - route.reservationBytes))
            : 0;
        route.reservationBytes += pdfImageWorkingBytes;
        // Range-read video retains bounded output, not the entire source. Reserve copies too.
        const candidateCap =
          route.engine === 'video'
            ? Math.max(
                0,
                Math.min(
                  file.size,
                  this.profile.blobLimitBytes,
                  Math.floor((available - route.reservationBytes) / 4)
                )
              )
            : Math.min(file.size, this.profile.blobLimitBytes);
        if (route.engine === 'video') route.reservationBytes += 4 * candidateCap;
        const originalOnly =
          route.reservationBytes > available || (route.engine === 'video' && candidateCap === 0);
        if (
          !customSink &&
          file.size + retainedBytes + (single ? 0 : 256 * 1024) > this.profile.blobLimitBytes
        ) {
          throw new Error(
            `This file cannot safely fit the browser archive limit (${Math.floor(this.profile.blobLimitBytes / 1024 / 1024)} MiB). Use a smaller batch or Save ${single ? 'file' : 'ZIP'} to disk.`
          );
        }
        if (originalOnly && available < 17 * 1024 * 1024)
          throw new Error(
            `Insufficient working memory for this batch. Use fewer files or Save ${single ? 'file' : 'ZIP'} to disk.`
          );
        const generic = originalOnly || route.engine === 'generic';
        const engine = originalOnly
          ? 'Original file · memory safeguard'
          : route.engine === 'video'
            ? 'Mediabunny / WebCodecs'
            : route.engine === 'image'
              ? `jSquash ${route.format}`
              : route.engine === 'officePdf'
                ? route.format === 'pdf'
                  ? 'pdf-lib'
                  : 'OOXML / jSquash'
                : single
                  ? 'File streaming'
                  : 'File streaming / fflate';
        status(
          'start',
          originalOnly
            ? single
              ? 'Transform exceeds memory budget; keeping original file'
              : 'Transform exceeds memory budget; packaging original without compression'
            : 'Starting processing worker',
          engine,
          originalOnly ? 17 * 1024 * 1024 : route.reservationBytes
        );
        let worker: Worker;
        if (generic)
          worker = new Worker(new URL('../workers/generic.worker.ts', import.meta.url), {
            type: 'module',
          });
        else if (route.engine === 'image')
          worker = new Worker(new URL('../workers/image.worker.ts', import.meta.url), {
            type: 'module',
          });
        else if (route.engine === 'video')
          worker = new Worker(new URL('../workers/video.worker.ts', import.meta.url), {
            type: 'module',
          });
        else if (route.format === 'pdf')
          worker = new Worker(new URL('../workers/pdf.worker.ts', import.meta.url), {
            type: 'module',
          });
        else
          worker = new Worker(new URL('../workers/office.worker.ts', import.meta.url), {
            type: 'module',
          });
        addWorker(worker);
        lastContact = Date.now();
        jobDeadline =
          Date.now() +
          (route.engine === 'video' && !generic
            ? 600_000
            : generic
              ? 600_000
              : route.engine === 'image'
                ? 30_000
                : 60_000);
        const channel = new MessageChannel();
        ports.add(channel.port1);
        const entryId = ids.jobId;
        expectedEntry = entryId;
        const entryDone = new Promise<void>((resolve) => {
          packed = resolve;
        });
        let resultReceived = false;
        const progressSequence = new Map<Stage, number>();
        worker.onmessage = ({ data: event }: MessageEvent<WorkerEvent>) => {
          if (!event || typeof event !== 'object') {
            fail(new Error('Invalid worker message'));
            return;
          }
          if (
            signal.aborted ||
            event.batchId !== batchId ||
            event.jobId !== ids.jobId ||
            event.attemptId !== ids.attemptId
          )
            return;
          if (event.version !== 1) {
            fail(new Error('Worker protocol version mismatch'));
            return;
          }
          if (
            ![
              'status',
              'progress',
              'heartbeat',
              'asset',
              'ready',
              'input-credit',
              'result',
              'error',
            ].includes(event.type)
          ) {
            fail(new Error('Unknown worker event'));
            return;
          }
          if (event.type !== 'result' && JSON.stringify(event).length > 4096) {
            fail(new Error('Worker metadata exceeds limit'));
            return;
          }
          if (event.type === 'status' || event.type === 'progress') {
            if (
              ![
                'inspect',
                'load',
                'init',
                'start',
                'read',
                'decode',
                'transform',
                'encode',
                'output',
                'pack',
                'save',
              ].includes(event.stage)
            ) {
              fail(new Error('Unknown processing stage'));
              return;
            }
          }
          if (event.type === 'progress') {
            if (
              !Number.isSafeInteger(event.seq) ||
              event.seq <= (progressSequence.get(event.stage) ?? -1) ||
              !Number.isFinite(event.completed) ||
              event.completed < 0 ||
              (event.total !== null &&
                (!Number.isFinite(event.total) || event.total < event.completed))
            ) {
              fail(new Error('Invalid progress metrics'));
              return;
            }
            progressSequence.set(event.stage, event.seq);
          }
          lastContact = Date.now();
          if (event.type === 'status' || event.type === 'progress')
            stage = single && event.stage === 'pack' ? 'save' : event.stage;
          if (event.type === 'ready') stage = 'inspect';
          if (event.type === 'error') {
            fail(
              new Error(
                `${engine}: ${event.error.code} (${event.error.messageKey})${event.error.details ? `\n${event.error.details}` : ''}`
              )
            );
          } else if (event.type === 'result') {
            if (
              resultReceived ||
              !Number.isSafeInteger(event.outputBytes) ||
              event.outputBytes < 0 ||
              event.outputBytes > file.size ||
              !['original', 'transformed'].includes(event.disposition) ||
              (event.disposition === 'original' && event.outputBytes !== file.size) ||
              (event.disposition === 'transformed' && event.outputBytes >= file.size) ||
              (event.reason !== undefined &&
                ![
                  'memory_limit',
                  'unsupported_content',
                  'unsupported_codec',
                  'no_smaller_candidate',
                  'validation_failed',
                  'cleanup_unsupported',
                  'conformance_document',
                  'protected_document',
                ].includes(event.reason)) ||
              (event.pdfMetadataRemoved !== undefined &&
                (route.format !== 'pdf' ||
                  pdfMetadata !== 'remove-xmp' ||
                  event.disposition !== 'transformed' ||
                  !Number.isSafeInteger(event.pdfMetadataRemoved) ||
                  event.pdfMetadataRemoved < 1 ||
                  event.pdfMetadataRemoved > 100_000)) ||
              (event.pdfDiagnostics !== undefined &&
                (route.format !== 'pdf' || !validPdfDiagnostics(event.pdfDiagnostics)))
            ) {
              fail(new Error('Invalid or duplicate worker result'));
              return;
            }
            resultReceived = true;
            if (event.disposition === 'original') {
              event.reason = originalOnly
                ? 'memory_limit'
                : (event.reason ?? (generic ? 'unsupported_content' : 'no_smaller_candidate'));
            }
            completedResults.push({
              pdfDiagnostics: event.pdfDiagnostics,
              pdfMetadataRemoved: event.pdfMetadataRemoved,
              disposition: event.disposition,
              reason: event.reason,
              extension: file.name.split('.').pop()?.toLowerCase() ?? 'other',
              category: route.category,
              intensity,
              originalBytes: file.size,
              compressedBytes: event.outputBytes,
              durationMs: event.durationMs,
              deviceTier: this.profile.tier,
            });
            if (single && event.disposition === 'original') {
              // No credit, writable, Blob URL or duplicate output for an unchanged single file.
              this.emit(event);
              packed?.();
              return;
            }
            // Filename controls must be removed before archive extraction.
            // eslint-disable-next-line no-control-regex
            const unsafeName = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069:]/g;
            let base = file.name
              .normalize('NFC')
              .replace(/^.*[\\/]/, '')
              .replace(unsafeName, '_');
            const sourceExtension = base.match(/\.[a-z0-9]{1,16}$/i)?.[0] ?? '';
            let stem = sourceExtension ? base.slice(0, -sourceExtension.length) : base;
            const nameBudget =
              (single ? 220 : 96) - new TextEncoder().encode(sourceExtension).length;
            while (new TextEncoder().encode(stem).length > nameBudget)
              stem = Array.from(stem).slice(0, -1).join('');
            base = stem + sourceExtension;
            base ||= 'file';
            if (base === '.' || base === '..') base = 'file';
            if (event.disposition === 'transformed')
              base =
                base.replace(/\.[^.]*$/, '') +
                '.' +
                event.extension.replace(/[^a-z0-9]/gi, '').slice(0, 8);
            let name = base;
            for (let suffix = 2; names.has(name); suffix++) name = `${base} (${suffix})`;
            names.add(name);
            stage = single ? 'save' : 'pack';
            if (zipWorker)
              zipWorker.postMessage(
                {
                  version: 1,
                  batchId,
                  type: 'add',
                  entry: {
                    entryId,
                    jobId: ids.jobId,
                    path: name,
                    method: route.format === 'unknown' ? 'deflate' : 'store',
                    level: intensity === 'heavy' ? 9 : intensity === 'balanced' ? 6 : 4,
                    maxBytes: event.outputBytes,
                  },
                  entryPort: channel.port1,
                } satisfies ZipCommand,
                [channel.port1]
              );
            if (single) {
              let progressSeq = 0;
              const saving = (async () => {
                await sink.open(name, event.mime);
                if (signal.aborted) {
                  await sink.abort();
                  throw new Error('File save was cancelled');
                }
                await writeDirectOutput(
                  channel.port1,
                  ids,
                  event.outputBytes,
                  sink,
                  signal,
                  (completed) => {
                    this.emit({
                      ...ids,
                      type: 'progress',
                      seq: ++progressSeq,
                      stage: 'save',
                      completed,
                      total: event.outputBytes,
                      unit: 'bytes',
                    });
                  }
                );
              })();
              void saving.then(() => packed?.()).catch((error: Error) => fail(error));
            } else ports.delete(channel.port1);
          }
          if (single && event.type === 'progress' && event.stage === 'pack') return;
          if (single && event.type === 'status' && event.stage === 'output')
            this.emit({ ...event, detail: 'Output prepared for direct save' });
          else this.emit(event);
        };
        const maxPixels =
          this.profile.tier === 'constrained'
            ? 12_000_000
            : this.profile.tier === 'standard'
              ? 24_000_000
              : 48_000_000;
        worker.postMessage(
          {
            ...ids,
            type: 'start',
            source: file,
            sourceMode: 'worker-ranges',
            config: {
              engine: generic ? 'generic' : route.engine,
              format: route.format,
              intensity,
              policy: {
                ...createEnginePolicy(generic ? 'generic' : route.engine, route.format, intensity),
                ...(route.format === 'pdf' && !generic ? { pdfMetadata } : {}),
              },
              limits: {
                ...(route.format === 'pdf' && !generic ? { pdfImageWorkingBytes } : {}),
                maxInputBytes:
                  route.engine === 'video'
                    ? file.size
                    : Math.min(file.size, Math.floor(available / 6)),
                maxOutputBytes: candidateCap,
                maxPixels: Math.min(
                  maxPixels,
                  Math.max(
                    0,
                    Math.floor(
                      (available -
                        (route.engine === 'video'
                          ? 4 * candidateCap + 128 * 1024 * 1024
                          : 2 * file.size + overhead)) /
                        (route.engine === 'video' ? 32 : 20)
                    )
                  )
                ),
                maxExpandedBytes: Math.min(file.size * 5, 64 * 1024 * 1024),
                maxEntryBytes:
                  this.profile.tier === 'constrained' ? 16 * 1024 * 1024 : 64 * 1024 * 1024,
                maxEntries: 1000,
                maxExpansionRatio: 100,
                maxWallTimeMs: jobDeadline - Date.now(),
              },
              allowMultithreadedWasm: false,
            },
            outputPort: channel.port2,
          } satisfies WorkerCommand,
          [channel.port2]
        );
        await race(entryDone);
        // Result only means prepared. Keep the producer alive until ZIP received its final chunk.
        worker.terminate();
        workers.delete(worker);
      }
      stage = 'save';
      jobLabel = single ? 'File finalization' : 'Archive finalization';
      jobDeadline = Date.now() + 30_000;
      if (zipWorker) {
        zipWorker.postMessage({ version: 1, batchId, type: 'finish' } satisfies ZipCommand);
        await race(zipDone);
      }
      await race(writeChain);
      const archive =
        single && completedResults[0]?.disposition === 'original' ? null : await race(sink.close());
      return {
        batchId,
        packaging: single ? 'file' : 'zip',
        archive,
        totalFiles: files.length,
        results: completedResults,
      };
    } catch (error) {
      for (const worker of workers) worker.terminate();
      for (const port of ports) port.close();
      let abortTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          sink.abort(),
          new Promise<void>((resolve) => {
            abortTimer = setTimeout(resolve, 250);
          }),
        ]);
      } catch {
        /* Preserve the processing error. */
      } finally {
        if (abortTimer) clearTimeout(abortTimer);
      }
      throw error;
    } finally {
      if (timer) clearInterval(timer);
      signal.removeEventListener('abort', cancel);
      for (const worker of workers) worker.terminate();
      for (const port of ports) port.close();
    }
  }
  async cancel() {
    this.currentAbortController?.abort();
    await this.pending?.catch(() => {});
  }
}
export const scheduler = new BatchScheduler();
