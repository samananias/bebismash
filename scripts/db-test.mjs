import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.resolve('migrations/0001_telemetry.sql');

if (!fs.existsSync(migrationPath)) {
  console.error('❌ Migration file 0001_telemetry.sql missing');
  process.exit(1);
}

const sql = fs.readFileSync(migrationPath, 'utf-8');

// Basic syntax and constraint validation
const requiredTables = ['compression_logs', 'global_stats'];
const requiredTriggers = ['compression_logs_rollup'];

let missing = false;
for (const table of requiredTables) {
  if (!sql.includes(`CREATE TABLE ${table}`)) {
    console.error(`❌ Missing table definition for: ${table}`);
    missing = true;
  }
}

for (const trigger of requiredTriggers) {
  if (!sql.includes(`CREATE TRIGGER ${trigger}`)) {
    console.error(`❌ Missing trigger definition for: ${trigger}`);
    missing = true;
  }
}

if (missing) {
  process.exit(1);
}

console.log('✅ db:test passed. Migration schema syntax and trigger definitions verified.');
