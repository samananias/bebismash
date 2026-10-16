import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  assetsInclude: ['**/*.wasm'],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    manifest: true,
    sourcemap: false,
    cssCodeSplit: true,
    modulePreload: { polyfill: false },
    minify: 'terser',
    terserOptions: {
      compress: {
        passes: 2,
        drop_console: false,
      },
      format: {
        comments: false,
      },
    },
  },
  optimizeDeps: {
    include: [
      '@jsquash/jpeg',
      '@jsquash/png',
      '@jsquash/oxipng',
      '@jsquash/webp',
      '@jsquash/avif',
      'fflate',
      'mediabunny',
      'pdf-lib',
    ],
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    headers: isolationHeaders,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8788',
        configure: (proxy) => {
          proxy.on('error', (_err, _req, res) => {
            if (res && 'writeHead' in res && !res.headersSent) {
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Backend server on port 8788 not running' }));
            }
          });
        },
      },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    headers: isolationHeaders,
  },
});
