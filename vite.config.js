import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// Sicherheits-Header (dieselben wie im Hosting, siehe vercel.json):
// Cross-Origin-Isolation erlaubt WebAssembly mit mehreren Threads (schnellere KI-Modelle),
// die Content-Security-Policy beschränkt, mit welchen Servern die Seite sprechen darf.
const security = JSON.parse(readFileSync(new URL('./security-headers.json', import.meta.url), 'utf8'));
const isolation = {
  'Cross-Origin-Opener-Policy': security['Cross-Origin-Opener-Policy'],
  'Cross-Origin-Embedder-Policy': security['Cross-Origin-Embedder-Policy'],
};

export default defineConfig({
  // Entwicklung ohne CSP (Vite fügt dort eigene Inline-Skripte ein), Vorschau mit allen Headern wie online
  server: { port: 5173, headers: isolation },
  preview: { port: 4173, headers: security },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@huggingface/transformers', 'onnxruntime-web', 'mupdf'] },
  build: { target: 'es2022' },
});
