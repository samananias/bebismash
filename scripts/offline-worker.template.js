/* This template is emitted with an exact build allowlist by the Vite plugin. */
/* global self, caches, fetch, URL, Response, AbortController, TransformStream, setTimeout, clearTimeout, __BUILD_FILES__, __BUILD_SHELL__ */
const VERSION = '__BUILD_VERSION__';
const FILES = __BUILD_FILES__;
const SHELL = __BUILD_SHELL__;
const CACHE = `bebismash-assets-${VERSION}`;
const READY = new URL('/__offline_ready__', self.location.origin).href;
let preparation;
self.addEventListener('install', () => {
  /* No automatic engine downloads or skipWaiting. */
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Activation waits until old controlled clients are gone; keep their caches before then.
      for (const key of await caches.keys()) {
        if (key.startsWith('bebismash-assets-') && key !== CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })()
  );
});
async function prepare() {
  const cache = await caches.open(CACHE);
  const previouslyReady = Boolean(await cache.match(READY));
  const deadline = Date.now() + 110000;
  try {
    // Admission is build bounded: <= 128 assets, 64 MiB total, sequential streams to disk.
    for (const file of FILES) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Offline preparation deadline exceeded');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.min(15000, remaining));
      try {
        const response = await fetch(file.url, {
          cache: 'reload',
          credentials: 'omit',
          signal: controller.signal,
        });
        const type = response.headers.get('content-type') || '';
        if (
          !response.ok ||
          response.redirected ||
          (file.url.endsWith('.wasm') && !type.includes('application/wasm')) ||
          (file.url.endsWith('.js') && !/javascript/.test(type)) ||
          (file.url === '/' && !type.includes('text/html'))
        )
          throw new Error('Offline asset unavailable');
        if (file.url === '/' && (await response.clone().text()) !== SHELL) {
          throw new Error('Application updated; reload before offline preparation');
        }
        if (!response.body) throw new Error('Offline asset has no body');
        let received = 0;
        const bounded = response.body.pipeThrough(
          new TransformStream({
            transform(chunk, sink) {
              received += chunk.byteLength;
              if (received > file.bytes) throw new Error('Offline asset exceeds admitted size');
              sink.enqueue(chunk);
            },
            flush() {
              if (received !== file.bytes) throw new Error('Incomplete offline asset');
            },
          })
        );
        await cache.put(
          file.url,
          new Response(bounded, { status: response.status, headers: response.headers })
        );
      } finally {
        clearTimeout(timeout);
      }
    }
    await cache.put(READY, new Response(VERSION));
  } catch (error) {
    // A failed refresh must not discard an already prepared version's navigation fallback.
    if (!previouslyReady) await cache.delete(READY);
    throw error;
  }
}
self.addEventListener('message', (event) => {
  if (
    event.data?.type !== 'PREPARE_OFFLINE' ||
    !event.ports[0] ||
    !event.source?.url ||
    new URL(event.source.url).origin !== self.location.origin
  )
    return;
  const port = event.ports[0];
  preparation ??= prepare().finally(() => {
    preparation = undefined;
  });
  event.waitUntil(
    preparation
      .then(
        () => port.postMessage({ ok: true }),
        () => port.postMessage({ ok: false })
      )
      .finally(() => port.close())
  );
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // Never intercept APIs, POSTs, user blobs, telemetry, arbitrary paths or cross-origin requests.
  if (
    request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.search ||
    url.pathname.startsWith('/api/')
  )
    return;
  if (request.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html')) {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          const cache = await caches.open(CACHE);
          if (await cache.match(READY)) {
            const shell = await cache.match('/');
            if (shell) return shell;
          }
          return Response.error();
        }
      })()
    );
  } else if (FILES.some((file) => file.url === url.pathname && file.url !== '/')) {
    event.respondWith(
      (async () =>
        // These exact public assets omit credentials. Ignore Vary: Origin introduced by
        // development/preview CORS; a module request may supply Origin unlike precaching.
        (await caches.open(CACHE))
          .match(request, { ignoreVary: true })
          .then((cached) => cached || fetch(request)))()
    );
  }
});
