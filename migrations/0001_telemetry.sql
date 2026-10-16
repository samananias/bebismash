-- Migration: 0001_telemetry.sql
-- Anonymous telemetry compression log & global rollup trigger

CREATE TABLE compression_logs (
  id INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE CHECK(length(event_id) = 36),
  batch_id TEXT NOT NULL CHECK(length(batch_id) = 36),
  file_ext TEXT NOT NULL CHECK(file_ext IN
    ('jpg','png','webp','avif','mp4','mov','webm','pdf','docx','pptx','xlsx','zip','other')),
  category TEXT NOT NULL CHECK(category IN ('image','video','document','archive','other')),
  intensity TEXT NOT NULL CHECK(intensity IN ('gentle','balanced','heavy')),
  original_bytes INTEGER NOT NULL CHECK(original_bytes BETWEEN 0 AND 2147483647),
  compressed_bytes INTEGER NOT NULL CHECK(compressed_bytes BETWEEN 0 AND original_bytes),
  saved_bytes INTEGER NOT NULL CHECK(saved_bytes = original_bytes - compressed_bytes),
  duration_ms INTEGER NOT NULL CHECK(duration_ms BETWEEN 0 AND 3600000),
  device_tier TEXT NOT NULL CHECK(device_tier IN ('constrained','standard','high')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX compression_logs_created_at ON compression_logs(created_at);

CREATE TABLE global_stats (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  total_files_smashed INTEGER NOT NULL DEFAULT 0 CHECK(total_files_smashed >= 0),
  total_bytes_original INTEGER NOT NULL DEFAULT 0 CHECK(total_bytes_original >= 0),
  total_bytes_saved INTEGER NOT NULL DEFAULT 0 CHECK(total_bytes_saved >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO global_stats(id) VALUES (1);

CREATE TRIGGER compression_logs_rollup AFTER INSERT ON compression_logs
BEGIN
  UPDATE global_stats SET
    total_files_smashed = total_files_smashed + 1,
    total_bytes_original = total_bytes_original + NEW.original_bytes,
    total_bytes_saved = total_bytes_saved + NEW.saved_bytes,
    updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;
