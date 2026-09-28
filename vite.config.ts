import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Serves the repo's `assets/` folder (Blender/glTF output) at `/assets/*` in dev and
 * copies it into `dist/assets` on build. `CB_ASSETS_DIR` overrides the folder, which is
 * handy while the assets branch has not been merged yet.
 */
function cbAssets(): Plugin {
  const dir = () => path.resolve(process.env.CB_ASSETS_DIR ?? 'assets');
  const types: Record<string, string> = {
    '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.json': 'application/json',
    '.ktx2': 'image/ktx2', '.jpg': 'image/jpeg', '.png': 'image/png', '.bin': 'application/octet-stream',
  };
  return {
    name: 'cb-assets',
    configureServer(server) {
      server.middlewares.use('/assets', (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '/').split('?')[0]);
        const file = path.join(dir(), rel);
        if (!file.startsWith(dir()) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return next();
        res.setHeader('Content-Type', types[path.extname(file)] ?? 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-cache');
        fs.createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      const src = dir();
      if (!fs.existsSync(src)) return;
      fs.cpSync(src, path.resolve('dist/assets'), { recursive: true, filter: (f) => !f.includes(`${path.sep}src${path.sep}`) && !f.endsWith('.py') });
    },
  };
}

export default defineConfig({
  plugins: [cbAssets()],
  server: { port: 5173, host: true },
  build: {
    target: 'es2022',
    assetsDir: 'bundle',
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: { manualChunks: (id: string) => (id.includes('node_modules/three') ? 'three' : undefined) },
    },
  },
});
