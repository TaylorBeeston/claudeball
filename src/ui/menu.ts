/**
 * Menu screens: title, game setup and settings. They only read and write through `AppCtx` (see app.ts), so the same settings screen
 * serves the main menu and the pause menu.
 */
import { h } from './dom';
import { button, field, segmented, slider, toggle, type Control } from './widgets';
import { CLUBS, clubColors, randomClubs, seedTeams, type Club } from './clubs';
import { GAME_LENGTHS, inningsLabel, seedFromText, type Tempo, type Chatter, type GameSettings, type MatchSetup, type QualityChoice, type TimeOfDay } from './settings';
import { QUALITY_BLURB, type DeviceInfo } from './device';
import type { QualityName } from '../engine/quality';
import type { Settings as AudioSettings } from '../audio/mixer';

/** Optional HD (neural) voices: opt-in download, state changes are pushed to the menu. */
export interface HdStatus {
  state: 'off' | 'loading' | 'ready' | 'error' | 'unavailable';
  pct?: number;
  text?: string;
  /** the model is already downloaded */
  cached?: boolean;
  /** size of the download for this device, MB */
  mb?: number;
  previewing?: boolean;
}

/** "My voice (custom announcer)": the owner's own trained voice, opt-in, from a URL or local files (see docs/announcer-voice.md). */
export interface VoiceMenuStatus {
  state: 'off' | 'loading' | 'ready' | 'error';
  pct: number;
  message: string;
  name: string;
  /** last pack URL used */
  url: string;
  /** a sample is playing */
  previewing?: boolean;
  /** kept for older callers: the voice no longer needs a running game */
  available: boolean;
}

export interface AudioBridge {
  get(): AudioSettings;
  set(patch: Partial<AudioSettings>): void;
  /** back to the audio defaults */
  reset(): void;
  /** HD voices (the audio layer is only attached once a game has started) */
  hd?: {
    status(): HdStatus;
    subscribe(cb: (s: HdStatus) => void): () => void;
    toggle(): void;
    remove(): void;
    preview(): void;
  };
  /** My voice (custom announcer) */
  voice?: {
    status(): VoiceMenuStatus;
    subscribe(cb: (s: VoiceMenuStatus) => void): () => void;
    loadUrl(url: string): void;
    loadFiles(files: File[]): void;
    off(): void;
    forget(): void;
    preview(): void;
  };
}

export interface AppCtx {
  settings: GameSettings;
  match: MatchSetup;
  device: DeviceInfo;
  /** what "Auto" resolves to on this device */
  autoQuality: QualityName;
  /** URL parameters that were set by the link (shown as a note) */
  fromUrl: Set<string>;
  /** asset files that failed to load */
  missing: string[];
  audio: AudioBridge;
  update(patch: Partial<GameSettings>): void;
  updateMatch(patch: Partial<MatchSetup>): void;
  resetDefaults(): void;
  start(): void;
  link(): string;
  toast(msg: string): void;
}

const TOD_ITEMS = [
  { value: 'day' as TimeOfDay, label: '☀ Day' },
  { value: 'dusk' as TimeOfDay, label: '🌇 Dusk' },
  { value: 'night' as TimeOfDay, label: '🌙 Night' },
];

const TEMPO_ITEMS = [
  { value: 'broadcast' as Tempo, label: 'Broadcast', hint: 'Slower and more TV-like: full wind-ups, walk-ups and pauses between pitches, as on a broadcast.' },
  { value: 'standard' as Tempo, label: 'Standard', hint: 'A natural pace between pitches and plays.' },
  { value: 'quick' as Tempo, label: 'Quick', hint: 'Little dead time: the game moves along fast.' },
];
const TEMPO_NOTE = 'Applies to the next game you start. 2× and 4× speed still work with any tempo, and Next batter (.) skips ahead.';

const LENGTH_ITEMS = GAME_LENGTHS.map((n) => ({ value: n, label: n === 9 ? '9 · Full' : n === 3 ? '3 · Short' : '1 · Demo', hint: n === 9 ? 'A regulation game, about 20 minutes at normal speed.' : n === 3 ? 'Three innings: a quick game.' : 'One inning: a quick look at everything.' }));

function qualityItems(ctx: AppCtx) {
  const auto = ctx.autoQuality;
  return [
    { value: 'auto' as QualityChoice, label: 'Auto', hint: `Picks a preset for this device (${auto[0].toUpperCase() + auto.slice(1)}) and lowers the resolution when frames get slow.` },
    ...(['low', 'medium', 'high', 'ultra'] as QualityName[]).map((q) => ({ value: q as QualityChoice, label: q[0].toUpperCase() + q.slice(1), hint: QUALITY_BLURB[q] })),
  ];
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/** All settings controls: Graphics, Sound, Camera and game. `sync()` repaints them from the current values (after a reset). */
export function settingsView(ctx: AppCtx): { el: HTMLElement; sync(): void } {
  const syncs: (() => void)[] = [];
  const reg = <C extends Control<never>>(c: C, read: () => Parameters<C['set']>[0]): C => {
    syncs.push(() => c.set(read()));
    return c;
  };
  const section = (title: string, ...kids: (HTMLElement | null)[]) => h('section', { class: 'cb-section' }, h('h3', { class: 'cb-h3' }, title), ...kids);

  const quality = reg(
    segmented<QualityChoice>('Graphics quality', qualityItems(ctx), ctx.settings.quality, (v) => ctx.update({ quality: v })),
    () => ctx.settings.quality,
  );
  const tod = reg(segmented<TimeOfDay>('Time of day', TOD_ITEMS, ctx.settings.tod, (v) => ctx.update({ tod: v })), () => ctx.settings.tod);

  const a = () => ctx.audio.get();
  const vol = (label: string, key: 'master' | 'sfx' | 'crowd' | 'organVolume' | 'announcer' | 'paVolume' | 'fxVolume' | 'musicVolume', hint?: string) => {
    const s = reg(slider(label, a()[key], (v) => ctx.audio.set({ [key]: v })), () => a()[key]);
    return field(label, s.el, hint);
  };
  const sw = (label: string, key: 'pa' | 'commentary' | 'organ' | 'music', hint?: string) => {
    const t = reg(toggle(label, a()[key], (v) => ctx.audio.set({ [key]: v })), () => a()[key]);
    const f = field(label, t.el, hint);
    f.classList.add('inline');
    return f;
  };
  const chatter = reg(
    segmented<Chatter>(
      'Commentary chatter',
      [
        { value: 'low', label: 'Low', hint: 'Only the big plays: scoring plays, hard-hit balls, home runs. No colour commentary or filler.' },
        { value: 'normal', label: 'Normal', hint: 'Play-by-play with colour commentary: roughly a line every 6-15 seconds.' },
        { value: 'high', label: 'High', hint: 'The booth never stops: narrates most pitches, banters, and fills every quiet moment.' },
      ],
      a().chatter,
      (v) => ctx.audio.set({ chatter: v }),
    ),
    () => a().chatter,
  );
  // optional neural voices: nothing is downloaded until the button is pressed
  const hdNote = h('div', { class: 'cb-hint' });
  const hdBtn = button('', () => ctx.audio.hd?.toggle(), 'ghost');
  const hdPreview = button('Preview voices', () => ctx.audio.hd?.preview(), 'ghost');
  const hdRemove = button('Remove download', () => ctx.audio.hd?.remove(), 'quiet');
  const paintHd = (st: HdStatus) => {
    hdBtn.disabled = st.state === 'loading' || st.state === 'unavailable';
    hdBtn.textContent = st.state === 'unavailable' ? 'HD voices unavailable' : st.state === 'ready' ? 'HD voices: on (switch off)' : st.state === 'loading' ? `Downloading… ${st.pct ?? 0}%` : st.cached ? 'Use HD voices' : `Download HD voices (~${st.mb ?? 90} MB)`;
    hdNote.textContent = st.text ?? (st.state === 'unavailable' ? 'HD voices are not available here.' : 'Optional neural voices (Kokoro, Apache-2.0) that run in your browser. One-time download from Hugging Face; without WebGPU they are slower than real time, so the booth talks less.');
    hdRemove.style.display = st.cached || st.state === 'ready' ? '' : 'none';
    hdPreview.style.display = st.state === 'ready' ? '' : 'none';
    hdPreview.disabled = !!st.previewing;
  };
  paintHd(ctx.audio.hd?.status() ?? { state: 'unavailable' });
  ctx.audio.hd?.subscribe(paintHd);
  syncs.push(() => paintHd(ctx.audio.hd?.status() ?? { state: 'unavailable' }));
  const hdBox = h('div', { class: 'cb-stack' }, hdBtn, hdPreview, hdNote, hdRemove);

  // My voice (custom announcer): nothing is loaded until the owner gives a URL or files
  const myUrl = h('input', { type: 'url', class: 'cb-input', 'aria-label': 'Voice pack URL', placeholder: 'https://huggingface.co/you/claudeball-voice/resolve/main/', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const myLoad = button('Load my voice pack', () => myUrl.value.trim() && ctx.audio.voice?.loadUrl(myUrl.value.trim()), 'ghost');
  const myFile = h('input', { type: 'file', multiple: true, accept: '.json,.onnx', hidden: true }) as HTMLInputElement;
  myFile.addEventListener('change', () => {
    if (myFile.files?.length) ctx.audio.voice?.loadFiles([...myFile.files]);
    myFile.value = '';
  });
  const myPick = button('Choose files… (voice.json + model)', () => myFile.click(), 'ghost');
  const myPreview = button('Preview my voice', () => ctx.audio.voice?.preview(), 'ghost');
  const myOff = button('Switch off', () => ctx.audio.voice?.off(), 'quiet');
  const myForget = button('Remove saved voice', () => ctx.audio.voice?.forget(), 'quiet');
  const myNote = h('div', { class: 'cb-hint' });
  const paintVoice = (st: VoiceMenuStatus) => {
    const busy = st.state === 'loading' || !st.available;
    myLoad.disabled = myPick.disabled = busy;
    myLoad.textContent = st.state === 'loading' ? `Loading… ${st.pct}%` : 'Load my voice pack';
    if (st.url && !myUrl.value) myUrl.value = st.url;
    myPreview.style.display = myOff.style.display = st.state === 'ready' ? '' : 'none';
    myPreview.disabled = !!st.previewing;
    myPreview.textContent = st.previewing ? 'Playing…' : 'Preview my voice';
    myForget.style.display = st.state === 'ready' || st.state === 'error' ? '' : 'none';
    myNote.textContent =
      st.state === 'ready' ? `${st.name} is on. Lines it cannot say use the browser voice.` :
      st.state === 'error' ? `Could not start your voice (${st.message}). Using the browser voices.` :
      st.state === 'loading' ? 'Downloading your voice model (kept in this browser afterwards)…' :
      'Your own trained voice (npm run announcer:export, see docs/announcer-voice.md). Nothing is uploaded: the model comes from the URL or the files you pick.';
  };
  const voiceStatus = () => ctx.audio.voice?.status() ?? { state: 'off' as const, pct: 0, message: '', name: '', url: '', available: false };
  paintVoice(voiceStatus());
  const myBox = h('div', { class: 'cb-stack' }, myUrl, myLoad, myPick, myFile, myPreview, myOff, myForget, myNote);

  // one Voices area: which voice is speaking, and the three choices
  const activeNote = h('div', { class: 'cb-hint' });
  const paintActive = () => {
    const v = voiceStatus().state === 'ready' ? 'My voice' : ctx.audio.hd?.status().state === 'ready' ? 'HD voices (Kokoro)' : 'Browser voices';
    activeNote.textContent = `Speaking now: ${v}. Turning one on turns the others off.`;
  };
  paintActive();
  ctx.audio.voice?.subscribe((st) => {
    paintVoice(st);
    paintActive();
  });
  ctx.audio.hd?.subscribe(() => paintActive());
  syncs.push(() => {
    paintVoice(voiceStatus());
    paintActive();
  });
  const voicesBox = h(
    'div',
    { class: 'cb-stack' },
    activeNote,
    h('div', { class: 'cb-hint' }, h('b', {}, 'Browser voices'), ': your browser\'s speech synthesis. Always available, used whenever a neural voice cannot say a line.'),
    h('div', { class: 'cb-hint' }, h('b', {}, 'HD voices (Kokoro, WebGPU only)')),
    hdBox,
    h('div', { class: 'cb-hint' }, h('b', {}, 'My voice (custom announcer)')),
    myBox,
  );
  const mute = reg(toggle('Sound off', a().muted, (v) => ctx.audio.set({ muted: v })), () => a().muted);
  const muteField = field('Mute everything', mute.el);
  muteField.classList.add('inline');

  const tempo = reg(segmented<Tempo>('Pace of play', TEMPO_ITEMS, ctx.settings.tempo, (v) => ctx.update({ tempo: v })), () => ctx.settings.tempo);
  const camera = reg(
    segmented<'auto' | 'free'>('Camera', [
      { value: 'auto', label: 'Broadcast', hint: 'A director cuts between TV-style shots and replays.' },
      { value: 'free', label: 'Free', hint: 'Drag (or one finger) to orbit, scroll (or pinch) to zoom.' },
    ], ctx.settings.camera, (v) => ctx.update({ camera: v })),
    () => ctx.settings.camera,
  );
  const replays = reg(toggle('Replays', ctx.settings.replays, (v) => ctx.update({ replays: v })), () => ctx.settings.replays);
  const speed = reg(
    segmented<number>('Game speed', [
      { value: 1, label: '1×', hint: 'Real time: pitch by pitch, with commentary.' },
      { value: 2, label: '2×' },
      { value: 4, label: '4×', hint: 'Fast: commentary and crowd stay quiet.' },
    ], ctx.settings.speed, (v) => ctx.update({ speed: v as 1 | 2 | 4 })),
    () => ctx.settings.speed,
  );
  const hud = reg(toggle('Broadcast graphics', ctx.settings.hud, (v) => ctx.update({ hud: v })), () => ctx.settings.hud);
  const box = reg(toggle('Box score', ctx.settings.box, (v) => ctx.update({ box: v })), () => ctx.settings.box);

  const inl = (label: string, c: HTMLElement, hint?: string) => {
    const f = field(label, c, hint);
    f.classList.add('inline');
    return f;
  };

  let armed = 0;
  const resetBtn = button('Reset to defaults', () => {
    if (!armed) {
      resetBtn.textContent = 'Tap again to reset everything';
      armed = window.setTimeout(() => {
        armed = 0;
        resetBtn.textContent = 'Reset to defaults';
      }, 3000);
      return;
    }
    clearTimeout(armed);
    armed = 0;
    resetBtn.textContent = 'Reset to defaults';
    ctx.resetDefaults();
    syncs.forEach((s) => s());
    ctx.toast('Settings reset');
  }, 'danger');

  const el = h(
    'div',
    { class: 'cb-stack' },
    section('Graphics', field('Quality', quality.el, undefined), quality.hintEl, field('Time of day', tod.el)),
    section('Sound', vol('Master volume', 'master'), vol('Effects', 'sfx', 'Bat, ball and glove.'), vol('Crowd', 'crowd'), vol('Organ volume', 'organVolume'), vol('Announcers', 'announcer', 'Commentary and PA voices.'), vol('PA announcer', 'paVolume', 'The stadium announcer and umpire calls, on top of Announcers.'), sw('PA announcer & umpire', 'pa'), sw('Commentary', 'commentary'), field('Chatter', chatter.el), chatter.hintEl, sw('Stadium organ', 'organ'), vol('Park music volume', 'musicVolume', 'Stadium music after runs and home runs, walk-ups and between innings.'), sw('Play park music', 'music'), vol('Broadcast effects', 'fxVolume', 'Soft whooshes and stings for replays, dissolves and graphics.'), field('Voices', voicesBox), muteField),
    section('Camera & game', field('Camera', camera.el), camera.hintEl, inl('Replays', replays.el), field('Pace of play', tempo.el, TEMPO_NOTE), tempo.hintEl, field('Game speed', speed.el), speed.hintEl, inl('Broadcast graphics', hud.el, 'Scorebug, name cards, pitch tracker, ticker.'), inl('Box score at start', box.el)),
    h('hr', { class: 'cb-sep' }),
    resetBtn,
  );
  return { el, sync: () => syncs.forEach((s) => s()) };
}

/** Name, abbreviation and colour of the club in a slot: the seed's own team when the slot is on auto. */
function clubFor(ctx: AppCtx, side: 'away' | 'home'): Club {
  const i = ctx.match[side];
  return i >= 0 ? CLUBS[i] : seedTeams(ctx.match.seed)[side];
}

export function matchSummary(ctx: AppCtx): HTMLElement {
  const a = clubFor(ctx, 'away'), hm = clubFor(ctx, 'home');
  const dot = (c: Club, side: 'away' | 'home') => h('i', { class: 'cb-dot', style: `--tc:${clubColors(c, side).color === '#f4f4f0' ? clubColors(c, side).trim : clubColors(c, side).color}` });
  return h('div', { class: 'cb-match' }, dot(a, 'away'), h('span', {}, a.name), h('span', { class: 'cb-hint' }, 'at'), dot(hm, 'home'), h('span', {}, hm.name));
}

export function titleScreen(ctx: AppCtx, go: (s: 'setup' | 'settings') => void): HTMLElement {
  const startBtn = button('Start Game', () => ctx.start(), 'primary', { 'data-testid': 'start' });
  const chips = h(
    'div',
    { class: 'cb-btnrow' },
    h('span', { class: 'cb-chip' }, h('b', {}, inningsLabel(ctx.settings.innings))),
    h('span', { class: 'cb-chip' }, h('b', {}, cap(ctx.settings.tod))),
    h('span', { class: 'cb-chip' }, 'Seed ', h('b', {}, String(ctx.match.seed))),
  );
  const notes: HTMLElement[] = [];
  if (ctx.missing.length) notes.push(h('div', { class: 'cb-note' }, 'Some 3D assets did not load, so simple stand-ins are used.'));
  if (ctx.fromUrl.size) notes.push(h('div', { class: 'cb-hint' }, 'Some settings come from the link you opened.'));
  return h(
    'div',
    { class: 'cb-main cb-title-screen' },
    h(
      'div',
      { class: 'cb-col' },
      h('div', { class: 'cb-eyebrow' }, 'Real baseball simulation'),
      h('h1', { class: 'cb-title' }, 'Claude', h('b', {}, 'ball')),
      h('p', { class: 'cb-tag' }, 'Two AI managers play a full game, pitch by pitch. Nothing is scripted: physics, ratings and decisions decide every play.'),
      matchSummary(ctx),
      chips,
      h('div', { class: 'cb-menu' }, startBtn, button('Game Setup', () => go('setup')), button('Settings', () => go('settings'))),
      h('div', { class: 'cb-foot' }, ...notes),
    ),
  );
}

export function setupScreen(ctx: AppCtx, back: () => void): HTMLElement {
  const teamsEl = h('div', { class: 'cb-teams-pick' });
  const summaryEl = h('div');
  const seedInput = h('input', { type: 'text', class: 'cb-input', inputmode: 'numeric', 'aria-label': 'Game seed', value: String(ctx.match.seed), maxlength: 15, autocomplete: 'off', spellcheck: 'false' });

  const clubOptions = (select: HTMLSelectElement, side: 'away' | 'home') => {
    const auto = seedTeams(ctx.match.seed)[side];
    select.append(h('option', { value: '-1' }, `Auto: ${auto.name}`));
    const grp = h('optgroup', { label: 'League' });
    for (const c of CLUBS) grp.append(h('option', { value: String(c.index) }, `${c.abbr} · ${c.name}`));
    select.append(grp);
    select.value = String(ctx.match[side]);
  };

  const paintTeams = () => {
    teamsEl.replaceChildren();
    for (const side of ['away', 'home'] as const) {
      const c = clubFor(ctx, side);
      const col = clubColors(c, side);
      const sel = h('select', { class: 'cb-select', 'aria-label': `${cap(side)} team` });
      clubOptions(sel, side);
      sel.addEventListener('change', () => {
        const v = Number(sel.value);
        const other = side === 'away' ? 'home' : 'away';
        const patch: Partial<MatchSetup> = { [side]: v };
        if (v >= 0 && ctx.match[other] === v) patch[other] = ctx.match[side]; // same club on both sides: swap
        ctx.updateMatch(patch);
        paint();
      });
      teamsEl.append(
        h('div', { class: 'cb-teampick', style: `--tc:${col.color === '#f4f4f0' ? col.trim : col.color}` }, h('div', { class: 'side' }, side === 'away' ? 'AWAY' : 'HOME'), h('div', { class: 'abbr' }, c.abbr), h('div', { class: 'nm' }, c.name), sel),
      );
    }
  };
  const paint = () => {
    paintTeams();
    summaryEl.replaceChildren(matchSummary(ctx));
    seedInput.value = String(ctx.match.seed);
  };
  const commitSeed = () => {
    const t = seedInput.value.trim();
    if (!t) return void paint();
    const seed = seedFromText(t);
    if (seed !== ctx.match.seed) ctx.updateMatch({ seed });
    paint();
  };
  seedInput.addEventListener('change', commitSeed);
  seedInput.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') {
      e.preventDefault();
      commitSeed();
      seedInput.blur();
    }
  });

  const length = segmented<number>('Game length', LENGTH_ITEMS, ctx.settings.innings, (v) => ctx.update({ innings: v }));
  const tod = segmented<TimeOfDay>('Time of day', TOD_ITEMS, ctx.settings.tod, (v) => ctx.update({ tod: v }));
  const tempo = segmented<Tempo>('Pace of play', TEMPO_ITEMS, ctx.settings.tempo, (v) => ctx.update({ tempo: v }));

  const randomTeams = button('🎲 Randomize teams', () => {
    ctx.updateMatch(randomClubs());
    paint();
  });
  const randomSeed = button('🎲', () => {
    ctx.updateMatch({ seed: 1 + Math.floor(Math.random() * 999_999) });
    paint();
  }, 'ghost', { 'aria-label': 'Random seed', title: 'Random seed' });
  randomSeed.classList.add('icon');
  const copy = button('Copy link', async () => {
    const url = ctx.link();
    try {
      await navigator.clipboard.writeText(url);
      ctx.toast('Link copied: it reproduces this game');
    } catch {
      seedInput.value = url;
      seedInput.select();
      ctx.toast('Copy the link from the box');
    }
  }, 'ghost', { title: 'A link that starts this exact game' });

  paint();
  return h(
    'div',
    { class: 'cb-main' },
    h(
      'div',
      { class: 'cb-col' },
      h('div', { class: 'cb-panel', style: 'padding:var(--cb-pad);display:flex;flex-direction:column;gap:var(--cb-gap)' },
        h('div', { class: 'cb-head' }, button('←', back, 'quiet', { 'aria-label': 'Back' }), h('h2', { class: 'cb-h2' }, 'Game Setup')),
        summaryEl,
        teamsEl,
        h('div', { class: 'cb-btnrow' }, randomTeams),
        field('Seed', h('div', { class: 'cb-seedrow' }, seedInput, randomSeed, copy), 'The same seed and teams always play the same game. Share the link to replay it.'),
        field('Game length', length.el, undefined),
        length.hintEl,
        field('Pace of play', tempo.el, TEMPO_NOTE),
        tempo.hintEl,
        field('Time of day', tod.el),
        button('Start Game', () => ctx.start(), 'primary'),
      ),
    ),
  );
}

export function settingsScreen(ctx: AppCtx, back: () => void, modal = false): HTMLElement {
  const view = settingsView(ctx);
  const head = h('div', { class: 'cb-head' }, button('←', back, 'quiet', { 'aria-label': 'Back' }), h('h2', { class: 'cb-h2' }, 'Settings'));
  if (modal) return h('div', { class: 'cb-panel', style: 'width:min(560px,94vw)' }, head, view.el);
  return h('div', { class: 'cb-main' }, h('div', { class: 'cb-col' }, h('div', { class: 'cb-panel', style: 'padding:var(--cb-pad);display:flex;flex-direction:column;gap:var(--cb-gap)' }, head, view.el)));
}
