-- Append-only: legacy logs/counters remain separate and compatible with v1 clients.
CREATE TABLE telemetry_epoch (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
INSERT INTO telemetry_epoch(id) VALUES (1);

CREATE TABLE telemetry_submissions (
  submission_id TEXT PRIMARY KEY CHECK(length(submission_id) = 36),
  buckets TEXT NOT NULL CHECK(json_valid(buckets) AND json_type(buckets) = 'array'
    AND json_array_length(buckets) BETWEEN 1 AND 26),
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX telemetry_submissions_received_at ON telemetry_submissions(received_at);

CREATE TABLE format_stats (
  format TEXT NOT NULL CHECK(format IN
    ('jpg','png','webp','avif','mp4','mov','webm','pdf','docx','pptx','xlsx','zip','other')),
  outcome TEXT NOT NULL CHECK(outcome IN ('compressed','preserved')),
  file_count INTEGER NOT NULL CHECK(typeof(file_count) = 'integer' AND file_count BETWEEN 1 AND 9007199254740991),
  input_bytes INTEGER NOT NULL CHECK(typeof(input_bytes) = 'integer' AND input_bytes BETWEEN 0 AND 9007199254740991),
  output_bytes INTEGER NOT NULL CHECK(typeof(output_bytes) = 'integer' AND output_bytes BETWEEN 0 AND input_bytes),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(format, outcome),
  CHECK(outcome != 'preserved' OR input_bytes = output_bytes)
);

CREATE TRIGGER telemetry_submissions_rollup AFTER INSERT ON telemetry_submissions
BEGIN
  INSERT INTO format_stats(format, outcome, file_count, input_bytes, output_bytes, updated_at)
  SELECT json_extract(value, '$.format'), json_extract(value, '$.outcome'),
    json_extract(value, '$.file_count'), json_extract(value, '$.input_bytes'),
    json_extract(value, '$.output_bytes'), NEW.received_at
  FROM json_each(NEW.buckets) WHERE true
  ON CONFLICT(format, outcome) DO UPDATE SET
    file_count = file_count + excluded.file_count,
    input_bytes = input_bytes + excluded.input_bytes,
    output_bytes = output_bytes + excluded.output_bytes,
    updated_at = excluded.updated_at;
END;
