import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const DIST_DIR = path.resolve('dist');
const MAX_GZIP_BUDGET_BYTES = 80_000; // Strictly < 80,000 bytes per ADR 0001 (React 19 baseline)

if (!fs.existsSync(DIST_DIR)) {
  console.error('Error: dist directory does not exist. Run "pnpm build" first.');
  process.exit(1);
}

// Find index.html
const indexHtmlPath = path.join(DIST_DIR, 'index.html');
if (!fs.existsSync(indexHtmlPath)) {
  console.error('Error: dist/index.html not found.');
  process.exit(1);
}

const htmlContent = fs.readFileSync(indexHtmlPath, 'utf-8');

// Parse script and stylesheet references from index.html
const scriptRegex = /<script\s+[^>]*src="([^"]+)"[^>]*>/gi;
const styleRegex = /<link\s+[^>]*rel="stylesheet"\s+[^>]*href="([^"]+)"[^>]*>/gi;

const staticFiles = new Set(['index.html']);

let match;
while ((match = scriptRegex.exec(htmlContent)) !== null) {
  const src = match[1]?.replace(/^\//, '');
  if (src && fs.existsSync(path.join(DIST_DIR, src))) {
    staticFiles.add(src);
  }
}

while ((match = styleRegex.exec(htmlContent)) !== null) {
  const href = match[1]?.replace(/^\//, '');
  if (href && fs.existsSync(path.join(DIST_DIR, href))) {
    staticFiles.add(href);
  }
}

let totalRawBytes = 0;
let totalGzipBytes = 0;
let totalBrotliBytes = 0;

console.log('--- Cold Load Bundle Size Audit ---');
console.log('Resource'.padEnd(45), 'Raw'.padStart(10), 'Gzip'.padStart(10), 'Brotli'.padStart(10));
console.log('-'.repeat(80));

for (const relPath of staticFiles) {
  const fullPath = path.join(DIST_DIR, relPath);
  const buffer = fs.readFileSync(fullPath);
  const gzipBuf = zlib.gzipSync(buffer);
  const brotliBuf = zlib.brotliCompressSync(buffer);

  totalRawBytes += buffer.length;
  totalGzipBytes += gzipBuf.length;
  totalBrotliBytes += brotliBuf.length;

  console.log(
    relPath.padEnd(45),
    `${(buffer.length / 1024).toFixed(2)} KB`.padStart(10),
    `${(gzipBuf.length / 1024).toFixed(2)} KB`.padStart(10),
    `${(brotliBuf.length / 1024).toFixed(2)} KB`.padStart(10)
  );
}

console.log('-'.repeat(80));
console.log(
  'Total Cold Graph'.padEnd(45),
  `${(totalRawBytes / 1024).toFixed(2)} KB`.padStart(10),
  `${(totalGzipBytes / 1024).toFixed(2)} KB`.padStart(10),
  `${(totalBrotliBytes / 1024).toFixed(2)} KB`.padStart(10)
);
console.log(
  `Budget: < ${(MAX_GZIP_BUDGET_BYTES / 1024).toFixed(2)} KB gzip (${MAX_GZIP_BUDGET_BYTES} bytes)`
);

if (totalGzipBytes >= MAX_GZIP_BUDGET_BYTES) {
  console.error(
    `\n❌ FAILED: Total gzip size ${totalGzipBytes} bytes exceeds limit of ${MAX_GZIP_BUDGET_BYTES} bytes!`
  );
  process.exit(1);
} else {
  console.log(
    `\n✅ PASSED: Initial graph is ${totalGzipBytes} bytes (${((totalGzipBytes / MAX_GZIP_BUDGET_BYTES) * 100).toFixed(1)}% of budget).`
  );
}
