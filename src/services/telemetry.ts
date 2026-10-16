export interface TelemetryReportItem {
  extension: string;
  category: 'image' | 'video' | 'document' | 'archive' | 'other';
  intensity: 'gentle' | 'balanced' | 'heavy';
  originalBytes: number;
  compressedBytes: number;
  durationMs: number;
  deviceTier: 'constrained' | 'standard' | 'high';
}

const ALLOWED_EXTS = new Set([
  'jpg',
  'png',
  'webp',
  'avif',
  'mp4',
  'mov',
  'webm',
  'pdf',
  'docx',
  'pptx',
  'xlsx',
  'zip',
]);

const EXT_TO_CATEGORY: Record<string, 'image' | 'video' | 'document' | 'archive' | 'other'> = {
  jpg: 'image',
  png: 'image',
  webp: 'image',
  avif: 'image',
  mp4: 'video',
  mov: 'video',
  webm: 'video',
  pdf: 'document',
  docx: 'document',
  pptx: 'document',
  xlsx: 'document',
  zip: 'archive',
  other: 'other',
};

/**
 * Opt-in, privacy-preserving, nonblocking telemetry submission.
 * Strictly anonymous: no filenames, no hashes, no IPs, rounded KiB bytes and 100ms durations.
 */
export function submitTelemetryBatch(items: TelemetryReportItem[], consent: boolean): void {
  if (!consent || items.length === 0) return;

  try {
    const validEvents = [];
    for (const item of items) {
      if (item.compressedBytes > item.originalBytes) continue;

      // Bytes rounded down to KiB before submission (sub-KiB becomes zero)
      const originalKiB = Math.floor(item.originalBytes / 1024) * 1024;
      const compressedKiB = Math.floor(item.compressedBytes / 1024) * 1024;
      if (compressedKiB > originalKiB) continue;

      // Duration rounded to 100 ms
      const durationRounded = Math.min(
        3_600_000,
        Math.max(0, Math.round(item.durationMs / 100) * 100)
      );

      const rawExt = item.extension.toLowerCase().replace(/^\./, '');
      const ext = (ALLOWED_EXTS.has(rawExt) ? rawExt : 'other') as
        | 'jpg'
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
        | 'other';

      const category = EXT_TO_CATEGORY[ext] || 'other';

      validEvents.push({
        event_id: crypto.randomUUID(),
        ext,
        category,
        intensity: item.intensity,
        original_bytes: originalKiB,
        compressed_bytes: compressedKiB,
        duration_ms: durationRounded,
        device_tier: item.deviceTier,
      });
    }

    if (validEvents.length === 0) return;

    // Send at most three 20-event envelopes per user batch
    const envelopes: (typeof validEvents)[] = [];
    for (let i = 0; i < validEvents.length && envelopes.length < 3; i += 20) {
      envelopes.push(validEvents.slice(i, i + 20));
    }

    for (const eventChunk of envelopes) {
      const payload = {
        version: 1,
        batch_id: crypto.randomUUID(),
        events: eventChunk,
      };

      const jsonStr = JSON.stringify(payload);
      if (jsonStr.length > 16384) continue; // enforce < 16 KiB limit

      let sent = false;
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        const blob = new Blob([jsonStr], { type: 'text/plain;charset=UTF-8' });
        sent = navigator.sendBeacon('/api/telemetry', blob);
      }

      if (!sent && typeof fetch === 'function') {
        fetch('/api/telemetry', {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
          body: jsonStr,
          keepalive: true,
          credentials: 'omit',
        }).catch(() => {
          // Silently ignore network failures; telemetry must never fail user jobs
        });
      }
    }
  } catch {
    // Never fail application execution
  }
}

export async function fetchGlobalStats(): Promise<{
  total_files_smashed: number;
  total_bytes_original: number;
  total_bytes_saved: number;
} | null> {
  try {
    const res = await fetch('/api/stats', {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
