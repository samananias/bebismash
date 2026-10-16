import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../lib/types';
import { onRequestGet as onStatsGet } from './stats';
import { onRequestGet, onRequestOptions, onRequestPost } from './telemetry';

describe('Edge Telemetry Functions', () => {
  const mockEnv: Env = {
    APP_ORIGIN: 'https://bebismash.example',
    TELEMETRY_ENABLED: 'true',
    DB: {
      prepare: vi.fn().mockReturnValue({
        all: vi.fn().mockResolvedValue({
          results: [
            {
              format: null,
              outcome: null,
              file_count: null,
              input_bytes: null,
              output_bytes: null,
              updated_at: null,
              started_at: '2026-10-16T00:00:00Z',
              legacy_files: 42,
              legacy_input: 5000000,
              legacy_saved: 2000000,
              legacy_updated: '2026-10-16T12:00:00Z',
            },
          ],
        }),
        first: vi.fn().mockResolvedValue({
          id: 1,
          total_files_smashed: 42,
          total_bytes_original: 5000000,
          total_bytes_saved: 2000000,
          updated_at: '2026-10-16T12:00:00Z',
        }),
        bind: vi.fn().mockReturnValue('mock-statement'),
      }),
      batch: vi.fn().mockResolvedValue([]),
    } as unknown as Env['DB'],
  };

  function createMockContext(request: Request, env = mockEnv) {
    return {
      request,
      env,
      params: {},
      data: {},
      waitUntil: vi.fn(),
      next: vi.fn(),
      functionPath: '',
    } as unknown as Parameters<typeof onRequestPost>[0];
  }

  it('rejects OPTIONS requests with 405 Method Not Allowed', async () => {
    const dummyReq = new Request('https://bebismash.example/api/telemetry', {
      method: 'OPTIONS',
    });
    const context = createMockContext(dummyReq) as unknown as Parameters<
      typeof onRequestOptions
    >[0];
    const res = await onRequestOptions(context);
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET, POST');
  });

  it('returns global aggregate counters on GET', async () => {
    const req = new Request('https://bebismash.example/api/telemetry');
    const context = createMockContext(req);

    const res = await onRequestGet(context);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');

    const json = (await res.json()) as {
      total_files_smashed: number;
      total_bytes_saved: number;
    };
    expect(json.total_files_smashed).toBe(42);
    expect(json.total_bytes_saved).toBe(2000000);
  });

  it('returns global aggregate counters on stats endpoint GET', async () => {
    const req = new Request('https://bebismash.example/api/stats');
    const context = createMockContext(req);

    const res = await onStatsGet(context);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { total_files_smashed: number };
    expect(json.total_files_smashed).toBe(42);
  });

  it('rejects POST with missing Origin', async () => {
    const req = new Request('https://bebismash.example/api/telemetry', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const context = createMockContext(req);

    const res = await onRequestPost(context);
    expect(res.status).toBe(403);
  });

  it('rejects cross-site Sec-Fetch-Site requests', async () => {
    const req = new Request('https://bebismash.example/api/telemetry', {
      method: 'POST',
      headers: {
        Origin: 'https://bebismash.example',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: JSON.stringify({}),
    });
    const context = createMockContext(req);

    const res = await onRequestPost(context);
    expect(res.status).toBe(403);
  });

  it('rejects disallowed Origin', async () => {
    const req = new Request('https://bebismash.example/api/telemetry', {
      method: 'POST',
      headers: {
        Origin: 'https://attacker.com',
      },
      body: JSON.stringify({}),
    });
    const context = createMockContext(req);

    const res = await onRequestPost(context);
    expect(res.status).toBe(403);
  });

  it('silently accepts with 204 when TELEMETRY_ENABLED is false (kill switch)', async () => {
    const req = new Request('https://bebismash.example/api/telemetry', {
      method: 'POST',
      headers: {
        Origin: 'https://bebismash.example',
      },
      body: JSON.stringify({}),
    });
    const disabledEnv: Env = { ...mockEnv, TELEMETRY_ENABLED: 'false' };
    const context = createMockContext(req, disabledEnv);

    const res = await onRequestPost(context);
    expect(res.status).toBe(204);
  });

  it('rejects unsupported Media Types', async () => {
    const req = new Request('https://bebismash.example/api/telemetry', {
      method: 'POST',
      headers: {
        Origin: 'https://bebismash.example',
        'Content-Type': 'multipart/form-data',
      },
      body: 'fake-data',
    });
    const context = createMockContext(req);

    const res = await onRequestPost(context);
    expect(res.status).toBe(415);
  });

  it('rejects payloads larger than 16 KiB with 413', async () => {
    const largeBody = 'x'.repeat(17000);
    const req = new Request('https://bebismash.example/api/telemetry', {
      method: 'POST',
      headers: {
        Origin: 'https://bebismash.example',
        'Content-Type': 'text/plain;charset=UTF-8',
      },
      body: largeBody,
    });
    const context = createMockContext(req);

    const res = await onRequestPost(context);
    expect(res.status).toBe(413);
  });

  it('rejects malformed JSON with 400', async () => {
    const req = new Request('https://bebismash.example/api/telemetry', {
      method: 'POST',
      headers: {
        Origin: 'https://bebismash.example',
        'Content-Type': 'application/json',
      },
      body: '{ not valid json }',
    });
    const context = createMockContext(req);

    const res = await onRequestPost(context);
    expect(res.status).toBe(400);
  });

  it('validates and batch-inserts valid telemetry batch with 204', async () => {
    const validBatch = {
      version: 1,
      batch_id: '123e4567-e89b-12d3-a456-426614174000',
      events: [
        {
          event_id: '223e4567-e89b-12d3-a456-426614174000',
          ext: 'png',
          category: 'image',
          intensity: 'balanced',
          original_bytes: 81920,
          compressed_bytes: 40960,
          duration_ms: 500,
          device_tier: 'standard',
        },
      ],
    };

    const req = new Request('https://bebismash.example/api/telemetry', {
      method: 'POST',
      headers: {
        Origin: 'https://bebismash.example',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(validBatch),
    });
    const context = createMockContext(req);

    const res = await onRequestPost(context);
    expect(res.status).toBe(204);
    expect(mockEnv.DB.batch).toHaveBeenCalled();
  });
});
