import { Engine } from './engine/engine';

const root = document.getElementById('app')!;
const engine = new Engine(root);
(window as unknown as { engine: Engine }).engine = engine;
engine.start();
