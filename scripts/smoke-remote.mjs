import process from 'node:process';

const args = process.argv.slice(2);
const originIndex = args.indexOf('--origin');
const origin = originIndex !== -1 ? args[originIndex + 1] : null;

if (!origin) {
  console.error('Usage: node scripts/smoke-remote.mjs --origin <URL>');
  process.exit(1);
}

console.log(`Checking smoke tests against deployed origin: ${origin}`);

try {
  const res = await fetch(origin, { method: 'HEAD' });
  const coop = res.headers.get('cross-origin-opener-policy');
  const coep = res.headers.get('cross-origin-embedder-policy');

  console.log(`Status: ${res.status}`);
  console.log(`COOP: ${coop}`);
  console.log(`COEP: ${coep}`);

  if (coop !== 'same-origin' || coep !== 'require-corp') {
    console.error('❌ Remote smoke check failed: Missing or invalid COOP/COEP isolation headers!');
    process.exit(1);
  }

  console.log('✅ Remote origin smoke check passed successfully.');
} catch (err) {
  console.error('❌ Failed to connect to origin:', err.message);
  process.exit(1);
}
