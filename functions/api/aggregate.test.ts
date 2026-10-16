import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onRequestPost } from './telemetry';
import { onRequestGet } from './stats';
import type { Env } from '../lib/types';

describe('Aggregate API against real SQLite migrations', () => {
  let db: DatabaseSync;
  let env: Env;
  let prepares: string[];
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    for (const path of readdirSync('migrations')
      .filter((p) => p.endsWith('.sql'))
      .sort())
      db.exec(readFileSync(`migrations/${path}`, 'utf8'));
    prepares = [];
    env = {
      APP_ORIGIN: 'https://local.test',
      TELEMETRY_ENABLED: 'true',
      DB: {
        prepare: (sql: string) => {
          prepares.push(sql);
          const stmt = db.prepare(sql);
          return {
            sql,
            bind: (...args: (string | number)[]) => ({ sql, args }),
            all: async () => ({ results: stmt.all() }),
          };
        },
        batch: async (statements: { sql: string; args?: (string | number)[] }[]) => {
          db.exec('BEGIN');
          try {
            const results = statements.map((s) => db.prepare(s.sql).run(...(s.args ?? [])));
            db.exec('COMMIT');
            return results;
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
        },
      } as unknown as Env['DB'],
    };
  });
  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });
  const envelope = () => ({
    version: 2,
    submission_id: '223e4567-e89b-12d3-a456-426614174000',
    buckets: [
      {
        format: 'jpg',
        outcome: 'compressed',
        file_count: 100,
        input_bytes: 5 * 1024 ** 3,
        output_bytes: 2 * 1024 ** 3,
      },
    ],
  });
  const context = (request: Request) => ({ env, request }) as Parameters<typeof onRequestPost>[0];
  const post = (value: unknown) =>
    onRequestPost(
      context(
        new Request('https://local.test/api/telemetry', {
          method: 'POST',
          headers: { Origin: 'https://local.test', 'Content-Type': 'application/json' },
          body: JSON.stringify(value),
        })
      )
    );
  it('rolls up 100 files in one submission; duplicate and changed replay cannot increment counters', async () => {
    expect((await post(envelope())).status).toBe(204);
    expect((await post(envelope())).status).toBe(204);
    const changed = envelope();
    changed.buckets[0]!.file_count = 500;
    expect((await post(changed)).status).toBe(204);
    expect(db.prepare('SELECT file_count FROM format_stats').get()!.file_count).toBe(100);
    expect(db.prepare('SELECT count(*) AS n FROM telemetry_submissions').get()!.n).toBe(1);
    prepares = [];
    const response = await onRequestGet(context(new Request('https://local.test/api/stats')));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(prepares).toHaveLength(1);
    expect(await response.json()).toMatchObject({
      total_files_compressed: 100,
      total_files_processed: 100,
      input_bytes: 5 * 1024 ** 3,
      output_bytes: 2 * 1024 ** 3,
      saved_bytes: 3 * 1024 ** 3,
      weighted_savings_percent: 60,
    });
  });
  it('keeps preserved/legacy counts distinct, including an empty database', async () => {
    const empty = await onRequestGet(context(new Request('https://local.test/api/stats')));
    expect(await empty.json()).toMatchObject({
      total_files_compressed: 0,
      weighted_savings_percent: null,
      formats: [],
    });
    db.exec(
      'UPDATE global_stats SET total_files_smashed=10,total_bytes_original=8192,total_bytes_saved=4096'
    );
    const a = envelope();
    a.buckets = [
      {
        format: 'other',
        outcome: 'preserved',
        file_count: 3,
        input_bytes: 4096,
        output_bytes: 4096,
      },
    ];
    await post(a);
    const response = await onRequestGet(context(new Request('https://local.test/api/stats')));
    expect(await response.json()).toMatchObject({
      total_files_compressed: 0,
      total_files_processed: 3,
      total_files_smashed: 13,
      legacy: { files_processed: 10, saved_bytes: 4096 },
    });
  });
  it('retains rollups while removing bounded expired records', async () => {
    await post(envelope());
    db.exec("UPDATE telemetry_submissions SET received_at='2020-01-01T00:00:00Z'");
    const b = envelope();
    b.submission_id = '323e4567-e89b-12d3-a456-426614174000';
    await post(b);
    expect(db.prepare('SELECT count(*) AS n FROM telemetry_submissions').get()!.n).toBe(1);
    expect(db.prepare('SELECT file_count FROM format_stats').get()!.file_count).toBe(200);
  });
  it('rolls back submission and retention if a counter would overflow', async () => {
    await post(envelope());
    db.exec('UPDATE format_stats SET input_bytes=9007199254740991');
    const b = envelope();
    b.submission_id = '323e4567-e89b-12d3-a456-426614174000';
    expect((await post(b)).status).toBe(503);
    expect(db.prepare('SELECT count(*) AS n FROM telemetry_submissions').get()!.n).toBe(1);
  });
  it('rejects private properties and invalid relationships before any SQL', async () => {
    expect((await post({ ...envelope(), filename: 'private.jpg' })).status).toBe(422);
    expect(prepares).toEqual([]);
  });
  it('does no D1 work while disabled and returns 503 on D1 outages', async () => {
    env.TELEMETRY_ENABLED = 'false';
    expect((await post(envelope())).status).toBe(204);
    expect(prepares).toEqual([]);
    env.TELEMETRY_ENABLED = 'true';
    vi.spyOn(env.DB, 'batch').mockRejectedValue(new Error('quota'));
    expect((await post(envelope())).status).toBe(503);
  });
});
