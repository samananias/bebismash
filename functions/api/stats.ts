import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env } from '../lib/types';
import { formatCategory } from '../../src/core/telemetryContract';
import type { TelemetryFormat, TelemetryOutcome } from '../../src/core/telemetryContract';
interface Row {
  format: TelemetryFormat | null;
  outcome: TelemetryOutcome | null;
  file_count: number | null;
  input_bytes: number | null;
  output_bytes: number | null;
  updated_at: string | null;
  started_at: string;
  legacy_files: number;
  legacy_input: number;
  legacy_saved: number;
  legacy_updated: string;
}
const utc = (s: string) => new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`).toISOString();
export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  try {
    // One bounded SELECT: at most 26 rollups, never scan retained submissions/logs.
    const { results } = await env.DB.prepare(
      `SELECT f.*, e.started_at,
      g.total_files_smashed AS legacy_files, g.total_bytes_original AS legacy_input,
      g.total_bytes_saved AS legacy_saved, g.updated_at AS legacy_updated
      FROM telemetry_epoch e CROSS JOIN global_stats g LEFT JOIN format_stats f ON 1=1
      WHERE e.id=1 AND g.id=1`
    ).all<Row>();
    if (!results.length) throw new Error('Missing statistics singleton');
    const head = results[0]!;
    const formats = results
      .filter((r) => r.format !== null)
      .map((r) => ({
        format: r.format!,
        category: formatCategory(r.format!),
        outcome: r.outcome!,
        file_count: r.file_count!,
        input_bytes: r.input_bytes!,
        output_bytes: r.output_bytes!,
      }));
    const total_files_processed = formats.reduce((n, r) => n + r.file_count, 0);
    const total_files_compressed = formats
      .filter((r) => r.outcome === 'compressed')
      .reduce((n, r) => n + r.file_count, 0);
    const input = formats.reduce((n, r) => n + r.input_bytes, 0);
    const output = formats.reduce((n, r) => n + r.output_bytes, 0);
    if (
      ![
        total_files_processed,
        total_files_compressed,
        input,
        output,
        head.legacy_files,
        head.legacy_input,
        head.legacy_saved,
        head.legacy_files + total_files_processed,
        head.legacy_input + input,
        head.legacy_saved + input - output,
      ].every((n) => Number.isSafeInteger(n) && n >= 0)
    )
      throw new Error('Statistics exceed safe integer range');
    const updated = results
      .map((r) => utc(r.updated_at ?? head.started_at))
      .sort()
      .at(-1)!;
    return Response.json(
      {
        version: 2,
        total_files_processed,
        total_files_compressed,
        input_bytes: input,
        output_bytes: output,
        saved_bytes: input - output,
        weighted_savings_percent: input ? ((input - output) / input) * 100 : null,
        formats,
        tracking_since: utc(head.started_at),
        updated_at: updated,
        retrieved_at: new Date().toISOString(),
        legacy: {
          files_processed: head.legacy_files,
          input_bytes: head.legacy_input,
          saved_bytes: head.legacy_saved,
        },
        // Compatibility totals are processed counts, never labelled compressed in v2 UI.
        total_files_smashed: head.legacy_files + total_files_processed,
        total_bytes_original: head.legacy_input + input,
        total_bytes_saved: head.legacy_saved + input - output,
      },
      { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } }
    );
  } catch {
    return Response.json(
      { error: 'Statistics unavailable' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } }
    );
  }
};
