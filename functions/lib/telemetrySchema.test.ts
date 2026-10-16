import { describe, expect, it } from 'vitest';
import { TelemetryBatchSchema, TelemetryEventSchema } from './telemetrySchema';

describe('Edge Telemetry Schemas', () => {
  const validEvent = {
    event_id: '123e4567-e89b-12d3-a456-426614174000',
    ext: 'jpg' as const,
    category: 'image' as const,
    intensity: 'balanced' as const,
    original_bytes: 100000,
    compressed_bytes: 60000,
    duration_ms: 1200,
    device_tier: 'standard' as const,
  };

  it('validates a correct telemetry event', () => {
    const res = TelemetryEventSchema.safeParse(validEvent);
    expect(res.success).toBe(true);
  });

  it('rejects an event where compressed_bytes exceeds original_bytes', () => {
    const invalid = {
      ...validEvent,
      original_bytes: 50000,
      compressed_bytes: 60000,
    };
    const res = TelemetryEventSchema.safeParse(invalid);
    expect(res.success).toBe(false);
  });

  it('rejects an event where category does not match file extension', () => {
    const mismatched = {
      ...validEvent,
      ext: 'jpg' as const,
      category: 'video' as const,
    };
    const res = TelemetryEventSchema.safeParse(mismatched);
    expect(res.success).toBe(false);
  });

  it('rejects unrecognized properties (strictObject enforcement)', () => {
    const extraField = {
      ...validEvent,
      filename: 'secret.jpg',
    };
    const res = TelemetryEventSchema.safeParse(extraField);
    expect(res.success).toBe(false);
  });

  it('validates a proper telemetry batch', () => {
    const batch = {
      version: 1 as const,
      batch_id: '223e4567-e89b-12d3-a456-426614174000',
      events: [validEvent],
    };
    const res = TelemetryBatchSchema.safeParse(batch);
    expect(res.success).toBe(true);
  });

  it('rejects duplicate event_ids within the same batch', () => {
    const batchWithDupes = {
      version: 1 as const,
      batch_id: '223e4567-e89b-12d3-a456-426614174000',
      events: [validEvent, validEvent],
    };
    const res = TelemetryBatchSchema.safeParse(batchWithDupes);
    expect(res.success).toBe(false);
  });

  it('rejects empty batches or batches exceeding 20 events', () => {
    const emptyBatch = {
      version: 1 as const,
      batch_id: '223e4567-e89b-12d3-a456-426614174000',
      events: [],
    };
    expect(TelemetryBatchSchema.safeParse(emptyBatch).success).toBe(false);
  });
});
