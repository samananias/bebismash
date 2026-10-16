import type { PagesFunction } from '@cloudflare/workers-types';
import { AggregateTelemetrySchema, TelemetryBatchSchema } from '../lib/telemetrySchema';
import type { Env } from '../lib/types';
export { onRequestGet } from './stats';

const MAX_BODY_BYTES = 16 * 1024; // 16 KiB

export const onRequestOptions: PagesFunction = async () => {
  return new Response(null, {
    status: 405,
    headers: {
      Allow: 'GET, POST',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  // 1. Origin and Sec-Fetch-Site validation
  const origin = request.headers.get('Origin');
  if (!origin) {
    return new Response('Forbidden: Missing Origin', { status: 403 });
  }

  const secFetchSite = request.headers.get('Sec-Fetch-Site');
  if (secFetchSite === 'cross-site') {
    return new Response('Forbidden: Cross-site requests rejected', { status: 403 });
  }

  const requestUrl = new URL(request.url);
  const allowedOrigin = env.APP_ORIGIN;
  const isOriginAllowed =
    (allowedOrigin && origin === allowedOrigin) || origin === requestUrl.origin;

  if (!isOriginAllowed) {
    return new Response('Forbidden: Disallowed Origin', { status: 403 });
  }

  // 2. Kill switch check
  if (env.TELEMETRY_ENABLED !== 'true') {
    return new Response(null, {
      status: 204,
      headers: {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  // 3. Content-Encoding check (must be identity or unset)
  const contentEncoding = request.headers.get('Content-Encoding');
  if (contentEncoding && contentEncoding.toLowerCase() !== 'identity') {
    return new Response('Unsupported Content-Encoding', { status: 415 });
  }

  // 4. Content-Type check (application/json or text/plain;charset=UTF-8)
  const contentType = (request.headers.get('Content-Type') || '').toLowerCase();
  const isValidContentType =
    contentType.startsWith('application/json') || contentType.startsWith('text/plain');

  if (!isValidContentType) {
    return new Response('Unsupported Media Type', { status: 415 });
  }

  // 5. Body stream reading with hard 16 KiB limit
  const reader = request.body?.getReader();
  if (!reader) {
    return new Response('Empty body', { status: 400 });
  }

  let totalBytes = 0;
  const chunks: Uint8Array[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_BODY_BYTES) {
        await reader.cancel();
        return new Response('Payload Too Large', { status: 413 });
      }
      chunks.push(value);
    }
  } catch {
    return new Response('Body stream read error', { status: 400 });
  }

  // 6. Decode UTF-8
  let text: string;
  try {
    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(merged);
  } catch {
    return new Response('Invalid UTF-8 encoding', { status: 400 });
  }

  // 7. Parse JSON
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return new Response('Malformed JSON', { status: 400 });
  }

  // 8. Validate schema
  const aggregate = AggregateTelemetrySchema.safeParse(json);
  if (aggregate.success) {
    try {
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM telemetry_submissions WHERE submission_id IN
          (SELECT submission_id FROM telemetry_submissions WHERE received_at < strftime('%Y-%m-%dT%H:%M:%SZ','now','-30 days') ORDER BY received_at LIMIT 100)`),
        env.DB.prepare(`DELETE FROM compression_logs WHERE id IN
          (SELECT id FROM compression_logs WHERE created_at < datetime('now','-30 days') ORDER BY created_at LIMIT 100)`),
        env.DB.prepare(
          'INSERT INTO telemetry_submissions(submission_id,buckets) VALUES (?,?) ON CONFLICT(submission_id) DO NOTHING'
        ).bind(aggregate.data.submission_id, JSON.stringify(aggregate.data.buckets)),
      ]);
      return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
    } catch {
      return new Response('Statistics unavailable', {
        status: 503,
        headers: { 'Cache-Control': 'no-store' },
      });
    }
  }
  const parsed = TelemetryBatchSchema.safeParse(json);
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: 'Invalid telemetry envelope' }), {
      status: 422,
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  const batch = parsed.data;

  // 9. Batch insert into Cloudflare D1
  try {
    const stmt = env.DB.prepare(
      `INSERT INTO compression_logs (
         event_id, batch_id, file_ext, category, intensity,
         original_bytes, compressed_bytes, saved_bytes,
         duration_ms, device_tier
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id) DO NOTHING`
    );

    const statements = batch.events.map((evt) => {
      const saved = evt.original_bytes - evt.compressed_bytes;
      return stmt.bind(
        evt.event_id,
        batch.batch_id,
        evt.ext,
        evt.category,
        evt.intensity,
        evt.original_bytes,
        evt.compressed_bytes,
        saved,
        evt.duration_ms,
        evt.device_tier
      );
    });

    await env.DB.batch(statements);

    return new Response(null, {
      status: 204,
      headers: {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (err) {
    console.error('D1 batch insertion error:', err);
    return new Response('Database Error', {
      status: 503,
      headers: {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }
};
