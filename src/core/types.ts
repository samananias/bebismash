/**
 * BebiSmash System Contracts & Shared Wire Protocol
 *
 * This is the shared source of truth across all four domains:
 * - Core / Router
 * - Media Workers
 * - UI / State
 * - Edge / Telemetry
 *
 * Worker dependencies import with `import type`.
 * All byte counts are nonnegative safe integers, durations finite nonnegative milliseconds,
 * identifiers random per batch/job and never derived from filenames.
 */

export type BatchId = string;
export type JobId = string;
export type AttemptId = string;
export type EntryId = string;
export type Intensity = 'gentle' | 'balanced' | 'heavy';
export type Engine = 'image' | 'video' | 'officePdf' | 'generic';
export type Category = 'image' | 'video' | 'document' | 'archive' | 'other';
export type Format =
  | 'jpeg'
  | 'png'
  | 'webp'
  | 'avif'
  | 'mp4'
  | 'mov'
  | 'webm'
  | 'pdf'
  | 'docx'
  | 'pptx'
  | 'xlsx'
  | 'zip'
  | 'unknown';
export type Stage =
  | 'inspect'
  | 'load'
  | 'init'
  | 'start'
  | 'read'
  | 'decode'
  | 'transform'
  | 'encode'
  | 'output'
  | 'pack'
  | 'save';
export type ErrorCode =
  | 'INVALID_INPUT'
  | 'UNSUPPORTED'
  | 'LIMIT_EXCEEDED'
  | 'DECODE_FAILED'
  | 'ENGINE_LOAD_FAILED'
  | 'TIMED_OUT'
  | 'CANCELLED'
  | 'PROTOCOL_ERROR'
  | 'SINK_FAILED'
  | 'INTERNAL';

export interface WireError {
  code: ErrorCode;
  retryable: boolean;
  messageKey: string; // local UI translation key, never raw file/codec text
  details?: string; // bounded local diagnostics; never included in telemetry
}

export interface Envelope {
  version: 1;
  batchId: BatchId;
}

export interface JobEnvelope extends Envelope {
  jobId: JobId;
  attemptId: AttemptId; // new on retry, stale attempt events are discarded
}

export interface HardwareProfile {
  tier: 'constrained' | 'standard' | 'high';
  cores: number;
  memoryGiB: number | null;
  isolated: boolean;
  maxWorkers: 1 | 2 | 3 | 4;
  memoryBudgetBytes: number;
  blobLimitBytes: number;
  fileSystemSink: boolean;
}

export interface FileDescriptor {
  jobId: JobId;
  displayName: string; // local only; never included in telemetry
  sourceBytes: number;
  lastModified: number;
}

export interface RouteDecision {
  format: Format;
  category: Category;
  engine: Engine;
  disposition: 'transform' | 'original';
  reservationBytes: number;
  reasonKey?: string;
}

export interface ResourceLimits {
  maxInputBytes: number;
  maxOutputBytes: number;
  maxPixels: number;
  maxExpandedBytes: number;
  maxEntryBytes: number;
  maxEntries: number;
  maxExpansionRatio: number;
  maxWallTimeMs: number;
}

export interface ImagePolicy {
  kind: 'image';
  quality: number; // normalized 0..100; adapters map native codec scales
  lossless: boolean;
  maxEdge: number | null;
  quantizeColors: 256 | null;
  oxipngLevel: 2 | 3 | 4;
  allowFormatChange: boolean;
}

export interface VideoPolicy {
  kind: 'video';
  mode: 'remux' | 'transcode';
  maxHeight: number | null;
  maxFps: number | null;
  webVideoBitrate: number;
  audioBitrate: number;
  ffmpegCrf: 20 | 26 | 32;
  ffmpegPreset: 'medium';
}

export interface DocumentPolicy {
  kind: 'document';
  image: ImagePolicy;
  deflateLevel: 6 | 9;
  pdfMode: 'rewrite' | 'image-adapter';
  targetDpi: 150 | 96 | null;
}

export interface GenericPolicy {
  kind: 'generic';
  level: 0 | 4 | 6 | 9;
}

export type EnginePolicy = ImagePolicy | VideoPolicy | DocumentPolicy | GenericPolicy;

export interface EngineConfig {
  engine: Engine;
  format: Format;
  intensity: Intensity;
  policy: EnginePolicy; // guard engine/format/policy compatibility at runtime
  limits: ResourceLimits;
  allowMultithreadedWasm: boolean;
}

export interface OwnedChunk {
  buffer: ArrayBuffer; // exact-sized, standalone, never a Wasm heap buffer
  byteLength: number; // must equal buffer.byteLength
}

export type WorkerCommand =
  | (JobEnvelope & {
      type: 'start';
      source: File;
      sourceMode: 'worker-ranges' | 'credited-slices';
      config: EngineConfig;
      outputPort: MessagePort;
    })
  | (JobEnvelope & {
      type: 'input';
      offset: number;
      chunk: OwnedChunk;
      final: boolean;
    })
  | (JobEnvelope & {
      type: 'cancel';
    });

/** Local result diagnostics; never included in telemetry. */
export type PreservationReason =
  | 'memory_limit'
  | 'unsupported_content'
  | 'unsupported_codec'
  | 'no_smaller_candidate'
  | 'validation_failed'
  | 'protected_document';

export type WorkerEvent =
  | (JobEnvelope & {
      type: 'status';
      stage: Stage;
      detail: string;
      engine?: string;
      reservedBytes?: number;
      media?: {
        width: number;
        height: number;
        videoCodec: string;
        audioCodec: string;
        webCodecs: boolean;
      };
    })
  | (JobEnvelope & { type: 'heartbeat' })
  | (JobEnvelope & {
      type: 'asset';
      name: string;
      state: 'downloading' | 'initializing' | 'ready' | 'cached' | 'failed';
      completed: number;
      total: number | null;
    })
  | (JobEnvelope & { type: 'ready' })
  | (JobEnvelope & { type: 'input-credit'; nextOffset: number; maxBytes: number })
  | (JobEnvelope & {
      type: 'progress';
      seq: number;
      stage: Stage;
      completed: number;
      total: number | null;
      unit: 'bytes' | 'frames' | 'steps';
    })
  | (JobEnvelope & {
      type: 'result';
      disposition: 'transformed' | 'original';
      reason?: PreservationReason;
      outputBytes: number;
      mime: string;
      extension: string;
      durationMs: number;
    })
  | (JobEnvelope & { type: 'error'; error: WireError });

export interface EntrySpec {
  entryId: EntryId;
  jobId: JobId;
  path: string; // sanitized archive basename with collision suffix
  method: 'store' | 'deflate';
  level: 0 | 4 | 6 | 9;
  maxBytes: number;
}

export type ZipCommand =
  | (Envelope & { type: 'open'; maxArchiveBytes: number; expectedEntries: number })
  | (Envelope & { type: 'add'; entry: EntrySpec; entryPort: MessagePort })
  | (Envelope & { type: 'sink-ack'; seq: number })
  | (Envelope & { type: 'finish' })
  | (Envelope & { type: 'abort' });

export type EntryData =
  | (JobEnvelope & {
      type: 'entry-chunk';
      entryId: EntryId;
      seq: number;
      chunk: OwnedChunk;
      final: boolean;
    })
  | (JobEnvelope & {
      type: 'entry-abort';
      entryId: EntryId;
      error: WireError;
    });

export type EntryControl =
  | (Envelope & { type: 'credit'; entryId: EntryId; seq: number; maxBytes: number })
  | (Envelope & { type: 'entry-accepted'; entryId: EntryId; bytes: number })
  | (Envelope & { type: 'entry-rejected'; entryId: EntryId; error: WireError });

export type ZipEvent =
  | (Envelope & { type: 'zip-ready' })
  | (Envelope & { type: 'zip-chunk'; seq: number; chunk: OwnedChunk; final: boolean })
  | (Envelope & { type: 'entry-packed'; entryId: EntryId; inputBytes: number })
  | (Envelope & { type: 'zip-complete'; archiveBytes: number; entries: number })
  | (Envelope & { type: 'zip-error'; error: WireError });

export interface BatchSummary {
  inputBytes: number;
  outputFileBytes: number; // excludes ZIP container overhead
  archiveBytes: number;
  transformed: number;
  originals: number;
  failed: number;
  durationMs: number;
}
