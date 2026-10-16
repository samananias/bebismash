import type { CompletedFileResult } from './scheduler';
import {
  MAX_REPORTED_BYTES,
  MAX_REPORTED_FILES,
  MAX_TELEMETRY_BYTES,
  telemetryFormat,
} from '../core/telemetryContract';
import type { AggregateTelemetry, TelemetryBucket } from '../core/telemetryContract';
export type TelemetryReportItem = CompletedFileResult;

/** One foreground best-effort write. No retry, queue, beacon or stats invalidation. */
export async function submitTelemetryBatch(
  items: TelemetryReportItem[],
  consent: boolean
): Promise<void> {
  if (
    !consent ||
    !items.length ||
    items.length > MAX_REPORTED_FILES ||
    (typeof navigator !== 'undefined' && navigator.onLine === false) ||
    (typeof document !== 'undefined' && document.visibilityState !== 'visible')
  )
    return;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const buckets = new Map<string, TelemetryBucket>();
    let total = 0;
    for (const item of items) {
      if (
        ![item.originalBytes, item.compressedBytes].every(
          (n) => Number.isSafeInteger(n) && n >= 0
        ) ||
        item.compressedBytes > item.originalBytes ||
        !['original', 'transformed'].includes(item.disposition)
      )
        return;
      const format = telemetryFormat(item.extension);
      const outcome =
        item.disposition === 'transformed' && item.compressedBytes < item.originalBytes
          ? 'compressed'
          : 'preserved';
      const input = Math.floor(item.originalBytes / 1024) * 1024;
      const output =
        outcome === 'preserved' ? input : Math.floor(item.compressedBytes / 1024) * 1024;
      total += input;
      if (!Number.isSafeInteger(total) || total > MAX_REPORTED_BYTES) return;
      const key = `${format}:${outcome}`;
      const b = buckets.get(key) ?? {
        format,
        outcome,
        file_count: 0,
        input_bytes: 0,
        output_bytes: 0,
      };
      b.file_count++;
      b.input_bytes += input;
      b.output_bytes += output;
      buckets.set(key, b);
    }
    const payload: AggregateTelemetry = {
      version: 2,
      submission_id: crypto.randomUUID(),
      buckets: [...buckets.values()],
    };
    const body = JSON.stringify(payload);
    if (new TextEncoder().encode(body).byteLength > MAX_TELEMETRY_BYTES) return;
    timer = setTimeout(() => controller.abort(), 5000);
    await fetch('/api/telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
      body,
      signal: controller.signal,
    });
  } catch {
    // Statistics never affect the completed output; discard failed observations.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
