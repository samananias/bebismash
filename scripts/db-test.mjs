import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const migrationPath = path.resolve('migrations/0001_telemetry.sql');

if (!fs.existsSync(migrationPath)) {
  console.error('❌ Migration file 0001_telemetry.sql missing');
  process.exit(1);
}

const sql = fs.readFileSync(migrationPath, 'utf-8');

// 1. Static AST/Content checks
const requiredTables = ['compression_logs', 'global_stats'];
const requiredTriggers = ['compression_logs_rollup'];

for (const table of requiredTables) {
  if (!sql.includes(`CREATE TABLE ${table}`)) {
    console.error(`❌ Missing table definition for: ${table}`);
    process.exit(1);
  }
}

for (const trigger of requiredTriggers) {
  if (!sql.includes(`CREATE TRIGGER ${trigger}`)) {
    console.error(`❌ Missing trigger definition for: ${trigger}`);
    process.exit(1);
  }
}

// 2. Real SQLite engine execution & trigger verification
try {
  const db = new DatabaseSync(':memory:');
  db.exec(sql);

  // Verify initial global_stats
  const initialRow = db.prepare('SELECT * FROM global_stats WHERE id = 1').get();
  if (
    !initialRow ||
    initialRow.total_files_smashed !== 0 ||
    initialRow.total_bytes_original !== 0 ||
    initialRow.total_bytes_saved !== 0
  ) {
    console.error('❌ Unexpected initial global_stats row:', initialRow);
    process.exit(1);
  }

  // Insert a test compression log
  const insertStmt = db.prepare(`
    INSERT INTO compression_logs (
      event_id, batch_id, file_ext, category, intensity,
      original_bytes, compressed_bytes, saved_bytes, duration_ms, device_tier
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id) DO NOTHING
  `);

  insertStmt.run(
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222',
    'jpg',
    'image',
    'balanced',
    100000,
    60000,
    40000,
    150,
    'standard'
  );

  // Verify trigger executed
  const updatedRow = db.prepare('SELECT * FROM global_stats WHERE id = 1').get();
  if (
    updatedRow.total_files_smashed !== 1 ||
    updatedRow.total_bytes_original !== 100000 ||
    updatedRow.total_bytes_saved !== 40000
  ) {
    console.error('❌ Trigger failed to roll up correctly:', updatedRow);
    process.exit(1);
  }

  // Verify idempotency with ON CONFLICT DO NOTHING
  insertStmt.run(
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222',
    'jpg',
    'image',
    'balanced',
    100000,
    60000,
    40000,
    150,
    'standard'
  );

  const idempotentRow = db.prepare('SELECT * FROM global_stats WHERE id = 1').get();
  if (
    idempotentRow.total_files_smashed !== 1 ||
    idempotentRow.total_bytes_original !== 100000 ||
    idempotentRow.total_bytes_saved !== 40000
  ) {
    console.error('❌ Duplicate event erroneously incremented rollups:', idempotentRow);
    process.exit(1);
  }

  // Verify check constraint on compressed_bytes <= original_bytes
  let constraintCaught = false;
  try {
    insertStmt.run(
      '33333333-3333-3333-3333-333333333333',
      '22222222-2222-2222-2222-222222222222',
      'png',
      'image',
      'gentle',
      50000,
      60000,
      -10000,
      100,
      'standard'
    );
  } catch {
    constraintCaught = true;
  }

  if (!constraintCaught) {
    console.error('❌ CHECK constraint failed to reject compressed_bytes > original_bytes');
    process.exit(1);
  }

  console.log(
    '✅ db:test passed. In-memory SQLite migration, constraints, triggers, and idempotency verified.'
  );
} catch (err) {
  console.error('❌ db:test failed during execution:', err);
  process.exit(1);
}
