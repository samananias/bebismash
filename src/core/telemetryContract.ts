/** Public, bounded metadata only. Never put names, paths or binary payloads here. */
export const TELEMETRY_FORMATS = [
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
] as const;
export type TelemetryFormat = (typeof TELEMETRY_FORMATS)[number];
export type TelemetryOutcome = 'compressed' | 'preserved';
export const MAX_TELEMETRY_BYTES = 16_384;
export const MAX_REPORTED_BYTES = 1_099_511_627_776; // 1 TiB per envelope; > 2 GiB supported.
export const MAX_REPORTED_FILES = 1000;
export interface TelemetryBucket {
  format: TelemetryFormat;
  outcome: TelemetryOutcome;
  file_count: number;
  input_bytes: number;
  output_bytes: number;
}
export interface AggregateTelemetry {
  version: 2;
  submission_id: string;
  buckets: TelemetryBucket[];
}
export function telemetryFormat(extension: string): TelemetryFormat {
  const ext = extension.toLowerCase().replace(/^\./, '');
  if (ext === 'jpeg') return 'jpg';
  return TELEMETRY_FORMATS.includes(ext as TelemetryFormat) ? (ext as TelemetryFormat) : 'other';
}
export function formatCategory(format: TelemetryFormat): string {
  if (['jpg', 'png', 'webp', 'avif'].includes(format)) return 'image';
  if (['mp4', 'mov', 'webm'].includes(format)) return 'video';
  if (['pdf', 'docx', 'pptx', 'xlsx'].includes(format)) return 'document';
  return format === 'zip' ? 'archive' : 'other';
}
