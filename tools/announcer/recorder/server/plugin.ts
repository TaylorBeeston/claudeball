import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { createApi, defaultVoiceDir } from './api';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Mounts the recorder API on the Vite dev server (so `npm run announcer:record` is one process). */
export function recorderApi(): Plugin {
  return {
    name: 'announcer-recorder-api',
    configureServer(server) {
      const scriptPath = process.env.CB_SCRIPT ?? path.resolve(here, '../../script/data/all.jsonl');
      const api = createApi({ scriptPath });
      server.middlewares.use((req, res, next) => void api(req, res, next));
      server.httpServer?.once('listening', () => {
        // eslint-disable-next-line no-console
        console.log(`\n  Recordings are saved to ${defaultVoiceDir()} (private, never committed). Change it with CB_VOICE_DIR.\n`);
      });
    },
  };
}
