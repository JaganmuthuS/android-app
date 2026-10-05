import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// The dev server needs inline scripts for hot reload, so the strict CSP only ships in builds.
const devCsp = (): Plugin => ({
  name: 'jarvis-dev-csp',
  apply: 'serve',
  transformIndexHtml: (html) => html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\n?/, ''),
});

export default defineConfig({
  plugins: [react(), devCsp()],
  base: './',
  server: { port: 5173, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
