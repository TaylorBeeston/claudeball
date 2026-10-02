import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { recorderApi } from './server/plugin';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The recorder is its own tiny Vite app, separate from the game: localhost only (127.0.0.1, never the LAN: it writes files and uses the mic),
 * and Vite's own Host-header check stays on (allowedHosts). Port with CB_RECORDER_PORT.
 */
export default defineConfig({
  root: here,
  clearScreen: false,
  plugins: [recorderApi()],
  server: { host: '127.0.0.1', port: Number(process.env.CB_RECORDER_PORT ?? 5199), strictPort: true, allowedHosts: ['localhost', '127.0.0.1'], open: false },
  build: { outDir: path.resolve(here, 'dist'), emptyOutDir: true, target: 'es2022' },
});
