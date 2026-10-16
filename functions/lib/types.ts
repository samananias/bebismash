export interface Env {
  DB: D1Database;
  APP_ORIGIN?: string;
  TELEMETRY_ENABLED?: string;
}

export interface GlobalStatsRow {
  id: number;
  total_files_smashed: number;
  total_bytes_original: number;
  total_bytes_saved: number;
  updated_at: string;
}
