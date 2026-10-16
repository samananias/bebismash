import fs from 'node:fs';
import path from 'node:path';

const WASM_DIR = path.resolve('public/wasm');

if (!fs.existsSync(WASM_DIR)) {
  fs.mkdirSync(WASM_DIR, { recursive: true });
}

const manifestPath = path.join(WASM_DIR, 'manifest.json');
const manifest = {
  version: 1,
  generatedAt: new Date().toISOString(),
  assets: {},
};

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(
  '✅ assets:prepare completed. Wasm asset manifest initialized at public/wasm/manifest.json'
);
