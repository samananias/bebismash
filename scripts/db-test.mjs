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
  for (const name of fs
    .readdirSync('migrations')
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    db.exec(fs.readFileSync(path.join('migrations', name), 'utf8'));
  }

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

  const aggregate = db.prepare(
    'INSERT INTO telemetry_submissions(submission_id,buckets) VALUES (?,?) ON CONFLICT(submission_id) DO NOTHING'
  );
  const buckets = JSON.stringify([
    {
      format: 'jpg',
      outcome: 'compressed',
      file_count: 100,
      input_bytes: 5368709120,
      output_bytes: 2147483648,
    },
  ]);
  aggregate.run('44444444-4444-4444-4444-444444444444', buckets);
  aggregate.run('44444444-4444-4444-4444-444444444444', buckets);
  const rollup = db.prepare('SELECT * FROM format_stats').get();
  if (
    rollup.file_count !== 100 ||
    rollup.input_bytes !== 5368709120 ||
    rollup.output_bytes !== 2147483648
  ) {
    throw new Error('v2 aggregate rollup or submission idempotency failed');
  }
  db.exec('DELETE FROM telemetry_submissions');
  if (db.prepare('SELECT file_count FROM format_stats').get().file_count !== 100)
    throw new Error('Retention changed lifetime rollup');
  db.close();
  console.log(
    '✅ db:test passed. In-memory SQLite migration, constraints, triggers, and idempotency verified.'
  );
} catch (err) {
  console.error('❌ db:test failed during execution:', err);
  process.exit(1);
}

// Exercise the installed D1 emulator too; SQLite alone cannot verify Wrangler migration tracking.
const { spawnSync } = await import('node:child_process');
const { tmpdir } = await import('node:os');
const tempBase = fs.realpathSync(tmpdir());
const testRoot = fs.mkdtempSync(path.join(tempBase, 'bebismash-db-'));
console.log(`Local D1 test directory: ${testRoot}`);
function cleanupTestDirectory() {
  const target = fs.realpathSync(testRoot);
  if (path.dirname(target) !== tempBase || !path.basename(target).startsWith('bebismash-db-')) {
    throw new Error(`Refusing cleanup outside the test temp directory: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}
try {
  const config = path.join(testRoot, 'wrangler.toml');
  fs.writeFileSync(
    config,
    [
      'name = "bebismash-db-test"',
      'compatibility_date = "2026-10-16"',
      '[[d1_databases]]',
      'binding = "DB"',
      'database_name = "bebismash-test"',
      'database_id = "local-telemetry-test"',
      `migrations_dir = ${JSON.stringify(path.resolve('migrations').replaceAll('\\', '/'))}`,
    ].join('\n')
  );
  const wrangler = path.resolve('node_modules/wrangler/bin/wrangler.js');
  const state = path.join(testRoot, 'state');
  function run(args) {
    const child = spawnSync(
      process.execPath,
      [wrangler, ...args, '--local', '--config', config, '--persist-to', state],
      {
        encoding: 'utf8',
        timeout: 60000,
        env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
        windowsHide: true,
      }
    );
    if (child.error || child.status !== 0)
      throw new Error(child.error?.message || child.stderr || child.stdout);
    return child.stdout;
  }
  run(['d1', 'migrations', 'apply', 'DB']);
  const replay = run(['d1', 'migrations', 'apply', 'DB']);
  if (!replay.includes('No migrations to apply'))
    throw new Error('D1 migration tracking did not skip applied migrations');
  const fixture = path.join(testRoot, 'synthetic.sql');
  const bucket = JSON.stringify([
    {
      format: 'png',
      outcome: 'compressed',
      file_count: 100,
      input_bytes: 5368709120,
      output_bytes: 2147483648,
    },
  ]);
  const insert = `INSERT INTO telemetry_submissions(submission_id,buckets) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','${bucket}') ON CONFLICT(submission_id) DO NOTHING;`;
  fs.writeFileSync(
    fixture,
    `${insert}\n${insert}\nDELETE FROM telemetry_submissions;\nSELECT file_count,input_bytes,output_bytes FROM format_stats;`
  );
  const results = JSON.parse(run(['d1', 'execute', 'DB', '--file', fixture, '--json']));
  const row = results.at(-1)?.results?.[0];
  if (
    !row ||
    row.file_count !== 100 ||
    row.input_bytes !== 5368709120 ||
    row.output_bytes !== 2147483648
  )
    throw new Error('Local D1 aggregate/replay/retention checks failed');
  console.log(
    '✅ Local D1: all migrations applied, replay tracked, aggregate/replay/retention verified.'
  );
} finally {
  // Verify the exact generated target remains a child of the intended temp directory before deletion.
  cleanupTestDirectory();
}
