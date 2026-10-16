import { TELEMETRY_FORMATS } from '../core/telemetryContract';
import type { TelemetryBucket } from '../core/telemetryContract';
export interface PublicStatistics {
  version: 2;
  total_files_processed: number;
  total_files_compressed: number;
  input_bytes: number;
  output_bytes: number;
  saved_bytes: number;
  weighted_savings_percent: number | null;
  tracking_since: string;
  updated_at: string;
  retrieved_at: string;
  formats: TelemetryBucket[];
  legacy: { files_processed: number; input_bytes: number; saved_bytes: number };
}
export interface StatisticsSnapshot {
  stats: PublicStatistics | null;
  stale: boolean;
}
const CACHE_KEY = 'bebismash.public-stats.v2';
const count = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const date = (s: unknown): s is string =>
  typeof s === 'string' && /^\d{4}-\d\d-\d\dT.*Z$/.test(s) && Number.isFinite(Date.parse(s));
/** Validate both cached and remote data, including consistency of bounded rollups. */
export function validateStatistics(value: unknown): value is PublicStatistics {
  if (!value || typeof value !== 'object') return false;
  const s = value as PublicStatistics;
  if (
    s.version !== 2 ||
    ![
      s.total_files_processed,
      s.total_files_compressed,
      s.input_bytes,
      s.output_bytes,
      s.saved_bytes,
    ].every(count) ||
    s.total_files_compressed > s.total_files_processed ||
    s.output_bytes > s.input_bytes ||
    s.saved_bytes !== s.input_bytes - s.output_bytes ||
    ![s.tracking_since, s.updated_at, s.retrieved_at].every(date) ||
    !Array.isArray(s.formats) ||
    s.formats.length > 26 ||
    !s.legacy ||
    ![s.legacy.files_processed, s.legacy.input_bytes, s.legacy.saved_bytes].every(count) ||
    s.legacy.saved_bytes > s.legacy.input_bytes
  )
    return false;
  if (s.weighted_savings_percent !== (s.input_bytes ? (s.saved_bytes / s.input_bytes) * 100 : null))
    return false;
  const keys = new Set<string>();
  let files = 0,
    compressed = 0,
    input = 0,
    output = 0;
  for (const b of s.formats) {
    if (
      !b ||
      !TELEMETRY_FORMATS.includes(b.format) ||
      !['compressed', 'preserved'].includes(b.outcome) ||
      ![b.file_count, b.input_bytes, b.output_bytes].every(count) ||
      b.file_count < 1 ||
      b.output_bytes > b.input_bytes ||
      (b.outcome === 'preserved' && b.input_bytes !== b.output_bytes)
    )
      return false;
    const key = `${b.format}:${b.outcome}`;
    if (keys.has(key)) return false;
    keys.add(key);
    files += b.file_count;
    input += b.input_bytes;
    output += b.output_bytes;
    if (b.outcome === 'compressed') compressed += b.file_count;
  }
  return (
    files === s.total_files_processed &&
    compressed === s.total_files_compressed &&
    input === s.input_bytes &&
    output === s.output_bytes
  );
}
export function readStatisticsCache(): PublicStatistics | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw || raw.length > 32_768) return null;
    const parsed: unknown = JSON.parse(raw);
    return validateStatistics(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
let boot: Promise<StatisticsSnapshot> | undefined;
/** Failed attempts are memoized too: only a new document may retry. */
export function loadStatisticsOnce(): Promise<StatisticsSnapshot> {
  return (boot ??= fetchSnapshot());
}
async function fetchSnapshot(): Promise<StatisticsSnapshot> {
  const fallback = { stats: readStatisticsCache(), stale: true };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return fallback;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch('/api/stats', {
      cache: 'no-store',
      credentials: 'omit',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return fallback;
    const reader = response.body?.getReader();
    if (!reader) return fallback;
    let raw = '',
      bytes = 0;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 32_768) {
          await reader.cancel();
          return fallback;
        }
        raw += decoder.decode(chunk.value, { stream: true });
      }
      raw += decoder.decode();
    } finally {
      reader.releaseLock();
    }
    const data: unknown = JSON.parse(raw);
    if (!validateStatistics(data)) return fallback;
    const s = data;
    // Persist only known public fields, never extra properties from a server response.
    const stats: PublicStatistics = {
      version: 2,
      total_files_processed: s.total_files_processed,
      total_files_compressed: s.total_files_compressed,
      input_bytes: s.input_bytes,
      output_bytes: s.output_bytes,
      saved_bytes: s.saved_bytes,
      weighted_savings_percent: s.weighted_savings_percent,
      tracking_since: s.tracking_since,
      updated_at: s.updated_at,
      retrieved_at: s.retrieved_at,
      formats: s.formats.map(({ format, outcome, file_count, input_bytes, output_bytes }) => ({
        format,
        outcome,
        file_count,
        input_bytes,
        output_bytes,
      })),
      legacy: {
        files_processed: s.legacy.files_processed,
        input_bytes: s.legacy.input_bytes,
        saved_bytes: s.legacy.saved_bytes,
      },
    };
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(stats));
    } catch {
      /* Optional public cache. */
    }
    return { stats, stale: false };
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}
