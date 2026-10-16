import fs from 'node:fs';
import path from 'node:path';

const wranglerPath = path.resolve('wrangler.toml');
const headersPath = path.resolve('public/_headers');
const routesPath = path.resolve('public/_routes.json');

let hasError = false;

// Check files exist
for (const [name, filePath] of [
  ['wrangler.toml', wranglerPath],
  ['public/_headers', headersPath],
  ['public/_routes.json', routesPath],
]) {
  if (!fs.existsSync(filePath)) {
    console.error(`❌ Missing infrastructure file: ${name}`);
    hasError = true;
  }
}

if (!hasError) {
  const headersContent = fs.readFileSync(headersPath, 'utf-8');
  if (
    !headersContent.includes('Cross-Origin-Opener-Policy: same-origin') ||
    !headersContent.includes('Cross-Origin-Embedder-Policy: require-corp')
  ) {
    console.error('❌ public/_headers missing required isolation headers (COOP/COEP)!');
    hasError = true;
  }

  const routesContent = fs.readFileSync(routesPath, 'utf-8');
  try {
    const routes = JSON.parse(routesContent);
    if (!routes.include?.includes('/api/*')) {
      console.error('❌ public/_routes.json does not properly include /api/*');
      hasError = true;
    }
  } catch (err) {
    console.error('❌ public/_routes.json is not valid JSON:', err.message);
    hasError = true;
  }
}

if (hasError) {
  process.exit(1);
} else {
  console.log('✅ infra:check passed. Infrastructure configuration and static headers verified.');
}
