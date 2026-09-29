import { Engine } from './engine/engine';

const root = document.getElementById('app')!;
const params = new URLSearchParams(location.search);
const engine = new Engine(root, {
  seed: params.has('seed') ? Number(params.get('seed')) : undefined,
  quality: (params.get('quality') as never) ?? undefined,
  timeOfDay: (params.get('tod') as never) ?? undefined,
  forceMock: params.has('mock'),
});
(window as unknown as { engine: Engine }).engine = engine;
engine.start();
if (!params.has('noassets')) {
  engine.loadAssets().then(
    (a) => console.info('[assets]', a.missing.length ? `missing: ${a.missing.join(', ')}` : 'all loaded', a.mirrored ? '(mirrored: old +X convention)' : ''),
    (e) => console.warn('[assets] failed, using placeholders', e),
  );
}
