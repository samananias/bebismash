import type { PagesFunction } from '@cloudflare/workers-types';
import type { Env, GlobalStatsRow } from '../lib/types';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const row = await context.env.DB.prepare(
      'SELECT total_files_smashed, total_bytes_original, total_bytes_saved, updated_at FROM global_stats WHERE id = 1'
    ).first<GlobalStatsRow>();

    const stats = {
      total_files_smashed: row?.total_files_smashed ?? 0,
      total_bytes_original: row?.total_bytes_original ?? 0,
      total_bytes_saved: row?.total_bytes_saved ?? 0,
      updated_at: row?.updated_at ?? new Date().toISOString(),
    };

    return new Response(JSON.stringify(stats), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'Cache-Control': 'public, max-age=30',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (err) {
    console.error('Error fetching global statistics:', err);
    return new Response(JSON.stringify({ error: 'Database unavailable' }), {
      status: 503,
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }
};
