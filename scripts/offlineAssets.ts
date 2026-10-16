import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
/** Final disk output includes Vite's preload rewrites, so byte admission uses writeBundle. */
export function offlineAssets(): Plugin {
  return {
    name: 'bebismash-offline-assets',
    apply: 'build',
    enforce: 'post',
    writeBundle(options, bundle) {
      const directory = resolve(options.dir ?? 'dist');
      const files: { url: string; bytes: number }[] = [];
      const shell = readFileSync(resolve(directory, 'index.html'), 'utf8');
      const publicHashes = createHash('sha256');
      for (const name of Object.keys(bundle)) {
        if (name === 'index.html') files.push({ url: '/', bytes: Buffer.byteLength(shell) });
        else if (name.startsWith('assets/') && /\.(js|css|wasm)$/.test(name))
          files.push({ url: `/${name}`, bytes: statSync(resolve(directory, name)).size });
      }
      for (const name of readdirSync(resolve(directory, 'fonts')).sort()) {
        if (/\.(ttf|woff2?)$/.test(name)) {
          publicHashes.update(readFileSync(resolve(directory, 'fonts', name)));
          files.push({
            url: `/fonts/${name}`,
            bytes: statSync(resolve(directory, 'fonts', name)).size,
          });
        }
      }
      publicHashes.update(readFileSync(resolve(directory, 'favicon.svg')));
      files.push({ url: '/favicon.svg', bytes: statSync(resolve(directory, 'favicon.svg')).size });
      if (
        !files.some((f) => f.url === '/') ||
        files.length > 128 ||
        files.reduce((n, f) => n + f.bytes, 0) > 64 * 1024 * 1024
      )
        this.error('Offline asset graph exceeds its admission budget');
      files.sort((a, b) => a.url.localeCompare(b.url));
      const template = readFileSync('scripts/offline-worker.template.js', 'utf8');
      const version = createHash('sha256')
        .update(JSON.stringify(files))
        .update(shell)
        .update(publicHashes.digest('hex'))
        .update(template)
        .digest('hex')
        .slice(0, 20);
      const source = template
        .replace('__BUILD_VERSION__', version)
        .replace('const FILES = __BUILD_FILES__', `const FILES = ${JSON.stringify(files)}`)
        .replace('const SHELL = __BUILD_SHELL__', `const SHELL = ${JSON.stringify(shell)}`);
      writeFileSync(resolve(directory, 'offline-worker.js'), source);
    },
  };
}
