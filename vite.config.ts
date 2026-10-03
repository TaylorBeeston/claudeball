import { defineConfig, type Plugin } from 'vite';
import crypto from 'node:crypto';
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
  // byte sizes of the shipped files, for the loading screen's progress bar (the same set the build copies, see `shipped` below)
  const shippedList = JSON.parse(fs.readFileSync(path.resolve('assets/shipped.json'), 'utf8')) as { players: string[]; players_1k: string[] };
  // what the deploy carries: the layout, and under optimized/ everything except the raw lod1 players and the player files the game never spawns from
  // (the role files that only carried default node sets are replaced by gear_defaults.json; see assets/shipped.json and scripts/derive-assets.mjs)
  const shippedFile = (src: string, f: string) => {
    const rel = path.relative(src, f).split(path.sep);
    if (rel[0] === 'field_layout.json') return true;
    if (rel[0] === 'shipped.json' || rel[0] !== 'optimized') return false;
    if (rel[1] === 'lod1') return false;
    if (rel[1] === 'players' && rel[2]?.endsWith('.glb')) return shippedList.players.includes(rel[2].replace(/\.glb$/, ''));
    if (rel[1] === 'players_1k') return shippedList.players_1k.includes((rel[2] ?? '').replace(/\.glb$/, ''));
    return true;
  };
  const sizes = () => {
    const src = dir();
    const out: Record<string, number> = {};
    const walk = (d: string) => {
      for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else if (shippedFile(src, f)) out[path.relative(src, f).split(path.sep).join('/')] = fs.statSync(f).size;
      }
    };
    walk(src);
    return out;
  };
  return {
    name: 'cb-assets',
    configureServer(server) {
      server.middlewares.use('/assets', (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '/').split('?')[0]);
        if (rel === '/asset_sizes.json') {
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-cache');
          return void res.end(JSON.stringify(sizes()));
        }
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
        const rel = path.relative(src, f).split(path.sep).join('/');
        if (fs.statSync(f).isDirectory()) return rel === '' || rel === 'optimized' || rel.startsWith('optimized/');
        return shippedFile(src, f);
      };
      // the derived assets (1k player textures, simplified geometry, gear defaults) must come from the current sources
      try {
        const d = JSON.parse(fs.readFileSync(path.join(src, 'derived.json'), 'utf8')) as { sources: Record<string, string> };
        const stale = Object.entries(d.sources).filter(([rel, sha]) => crypto.createHash('sha1').update(fs.readFileSync(path.join(src, rel))).digest('hex') !== sha).map(([rel]) => rel);
        if (stale.length) console.warn(`\n[cb-assets] WARNING: ${stale.length} source file(s) changed since the derived assets were built (${stale.slice(0, 3).join(', ')}): run \`npm run assets:derive\` (players_1k, lod geometry and gear defaults are out of date)\n`);
      } catch {
        console.warn('\n[cb-assets] WARNING: assets/derived.json is missing: run `npm run assets:derive`\n');
      }
      fs.cpSync(src, path.resolve('dist/assets'), { recursive: true, filter: shipped });
      fs.writeFileSync(path.resolve('dist/assets/asset_sizes.json'), JSON.stringify(sizes()));
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
