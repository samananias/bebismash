import { z } from 'zod';
import {
  TELEMETRY_FORMATS,
  MAX_REPORTED_BYTES,
  MAX_REPORTED_FILES,
} from '../../src/core/telemetryContract';

const count = z.number().int().min(0).max(2_147_483_647);

export const EXT_TO_CATEGORY: Record<string, string> = {
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

export const TelemetryEventSchema = z
  .strictObject({
    event_id: z.string().uuid(),
    ext: z.enum([
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
      'other',
    ]),
    category: z.enum(['image', 'video', 'document', 'archive', 'other']),
    intensity: z.enum(['gentle', 'balanced', 'heavy']),
    original_bytes: count,
    compressed_bytes: count,
    duration_ms: z.number().int().min(0).max(3_600_000),
    device_tier: z.enum(['constrained', 'standard', 'high']),
  })
  .superRefine((value, ctx) => {
    if (value.compressed_bytes > value.original_bytes) {
      ctx.addIssue({ code: 'custom', message: 'invalid byte relationship: compressed > original' });
    }
    const expectedCat = EXT_TO_CATEGORY[value.ext] || 'other';
    if (value.category !== expectedCat) {
      ctx.addIssue({
        code: 'custom',
        message: `extension ${value.ext} does not match category ${value.category}`,
      });
    }
  });

export const TelemetryBatchSchema = z
  .strictObject({
    version: z.literal(1),
    batch_id: z.string().uuid(),
    events: z.array(TelemetryEventSchema).min(1).max(20),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.events.map((event) => event.event_id)).size !== value.events.length) {
      ctx.addIssue({ code: 'custom', message: 'duplicate event id in batch' });
    }
    if (value.events.reduce((sum, event) => sum + event.original_bytes, 0) > 2_147_483_647) {
      ctx.addIssue({ code: 'custom', message: 'batch aggregate original bytes too large' });
    }
  });

export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;
export type TelemetryBatch = z.infer<typeof TelemetryBatchSchema>;

export const AggregateTelemetrySchema = z
  .strictObject({
    version: z.literal(2),
    submission_id: z.string().uuid(),
    buckets: z
      .array(
        z.strictObject({
          format: z.enum(TELEMETRY_FORMATS),
          outcome: z.enum(['compressed', 'preserved']),
          file_count: z.number().int().min(1).max(MAX_REPORTED_FILES),
          input_bytes: z.number().int().min(0).max(MAX_REPORTED_BYTES),
          output_bytes: z.number().int().min(0).max(MAX_REPORTED_BYTES),
        })
      )
      .min(1)
      .max(26),
  })
  .superRefine(({ buckets }, ctx) => {
    if (
      new Set(buckets.map((b) => `${b.format}:${b.outcome}`)).size !== buckets.length ||
      buckets.reduce((n, b) => n + b.file_count, 0) > MAX_REPORTED_FILES ||
      buckets.reduce((n, b) => n + b.input_bytes, 0) > MAX_REPORTED_BYTES ||
      buckets.some(
        (b) =>
          b.output_bytes > b.input_bytes ||
          b.input_bytes % 1024 !== 0 ||
          b.output_bytes % 1024 !== 0 ||
          (b.outcome === 'preserved' && b.input_bytes !== b.output_bytes)
      )
    ) {
      ctx.addIssue({ code: 'custom', message: 'Invalid aggregate relationships or limits' });
    }
  });
