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
        res.setHeader('Last-Modified', fs.statSync(file).mtime.toUTCString());
        fs.createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      const src = dir();
      if (!fs.existsSync(src)) return;
      // ship only what the runtime loads: field_layout.json and the optimized/ builds (not the raw exports, Blender sources or unused lod1/)
      const shipped = (f: string) => {
        const rel = path.relative(src, f).split(path.sep);
        return rel[0] === '' || rel[0] === 'field_layout.json' || (rel[0] === 'optimized' && rel[1] !== 'lod1');
      };
      fs.cpSync(src, path.resolve('dist/assets'), { recursive: true, filter: shipped });
    },
  };
}

/**
 * `public/hdri/*.hdr` is not committed (`npm run hdri` downloads it). The engine asks `/hdri/index.json` which sky files exist
 * instead of requesting files that may be absent (a 404 would show up as a console error); the manifest is generated on the
 * fly in dev and written to `dist/hdri/index.json` on build.
 */
function cbHdriManifest(): Plugin {
  const list = () => {
    const dir = path.resolve('public/hdri');
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^sky_\w+\.hdr$/.test(f)).sort() : [];
  };
  return {
    name: 'cb-hdri-manifest',
    configureServer(server) {
      server.middlewares.use('/hdri/index.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(JSON.stringify(list()));
      });
    },
    closeBundle() {
      fs.mkdirSync(path.resolve('dist/hdri'), { recursive: true });
      fs.writeFileSync(path.resolve('dist/hdri/index.json'), JSON.stringify(list()));
    },
  };
}

export default defineConfig({
  // GitHub Pages serves the site from /<repo>/, so CI builds with CB_BASE=/claudeball/; every runtime URL goes through import.meta.env.BASE_URL
  base: process.env.CB_BASE ?? '/',
  plugins: [cbAssets(), cbHdriManifest()],
  // the optional HD-voice worker imports its library from a CDN at run time (see src/audio/neuralWorker.ts), so it needs ES-module output
  worker: { format: 'es' },
  // host: true listens on every interface (LAN + tailscale); allowedHosts lets it be opened by machine name (e.g. http://frenchfry:5173)
  server: { port: 5173, host: true, allowedHosts: true },
  preview: { port: 4173, host: true, allowedHosts: true, strictPort: true },
  build: {
    target: 'es2022',
    assetsDir: 'bundle',
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: { manualChunks: (id: string) => (id.includes('node_modules/three') ? 'three' : undefined) },
    },
  },
});
