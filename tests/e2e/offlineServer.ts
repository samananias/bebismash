import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
/** Real transport faults reach service workers on all browsers; routing does not. */
export async function offlineServer(stats: unknown, initiallyFailEngine = false) {
  const root = resolve('dist');
  let failEngine = initiallyFailEngine;
  const server = createServer(async (req, res) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end();
      return;
    }
    if (pathname === '/api/stats') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(stats));
      return;
    }
    if (failEngine && /oxipng.*\.wasm$/.test(pathname)) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('unavailable');
      return;
    }
    try {
      const path = resolve(
        root,
        pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '')
      );
      if (!path.startsWith(root + sep)) {
        res.writeHead(404);
        res.end();
        return;
      }
      const types: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.wasm': 'application/wasm',
        '.svg': 'image/svg+xml',
        '.ttf': 'font/ttf',
      };
      res.setHeader('Content-Type', types[extname(path)] ?? 'application/octet-stream');
      res.end(await readFile(path));
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((yes, no) => {
    server.once('error', no);
    server.listen(0, '127.0.0.1', () => yes());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Missing test server port');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    setFailEngine: (value: boolean) => {
      failEngine = value;
    },
    close: async () => {
      if (!server.listening) return;
      await new Promise<void>((yes, no) => {
        server.close((e) => (e ? no(e) : yes()));
        server.closeAllConnections();
      });
    },
  };
}
