/**
 * On-screen sound controls: a 🔊/🔇 button, a settings panel (volumes + announcer/commentary toggles) and the
 * "Click to enable sound" prompt shown until the browser lets the AudioContext run. Own fixed-position DOM, so it does not
 * touch the engine HUD. Settings persist in localStorage (every access wrapped: it can throw or be empty).
 */
import { DEFAULT_SETTINGS, type Settings } from './mixer';
import { HD_MODES, hdSupported, pickMode } from './hdInfo';
import { mountVoicePanel, type VoicePanel, type VoicePanelHandlers } from './voice/panel';

const KEY = 'claudeball.audio.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const o = JSON.parse(raw) as Partial<Settings>;
    const num = (v: unknown, d: number) => (typeof v === 'number' && v >= 0 && v <= 1 ? v : d);
    const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
    return {
      master: num(o.master, DEFAULT_SETTINGS.master),
      sfx: num(o.sfx, DEFAULT_SETTINGS.sfx),
      crowd: num(o.crowd, DEFAULT_SETTINGS.crowd),
            announcer: num(o.announcer, DEFAULT_SETTINGS.announcer),
      paVolume: num(o.paVolume, DEFAULT_SETTINGS.paVolume),
      muted: bool(o.muted, false),
      pa: bool(o.pa, true),
      commentary: bool(o.commentary, true),
      organ: bool(o.organ, true),
      organVolume: num(o.organVolume, DEFAULT_SETTINGS.organVolume),
      chatter: o.chatter === 'low' || o.chatter === 'high' ? o.chatter : 'normal',
      hd: o.hd === true,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode / blocked storage: settings just do not persist */
  }
}

const CSS = `
.cb-snd{position:fixed;top:7.4vh;right:2vw;z-index:20;font-family:"Segoe UI","Helvetica Neue",Arial,sans-serif;color:#fff;font-size:1.6vh;user-select:none}
.cb-snd button{font:inherit;color:#fff;background:rgba(14,18,26,.85);border:1px solid rgba(255,255,255,.18);border-radius:.5vh;padding:.6vh 1.1vh;cursor:pointer;opacity:.55;transition:opacity .2s,background .2s}
.cb-snd:hover button,.cb-snd button:focus-visible,.cb-snd.open button{opacity:1}
.cb-snd button:hover{background:rgba(40,50,70,.95)}
.cb-snd .row{display:flex;gap:.6vh;justify-content:flex-end}
.cb-snd .panel{display:none;margin-top:.8vh;padding:1.2vh 1.4vh;width:26vh;background:rgba(14,18,26,.94);border:1px solid rgba(255,255,255,.14);border-radius:.7vh;text-shadow:0 1px 2px rgba(0,0,0,.6)}
.cb-snd.open .panel{display:block}
.cb-snd label{display:flex;align-items:center;justify-content:space-between;gap:1vh;margin:.5vh 0}
.cb-snd input[type=range]{width:14vh}
.cb-snd select{font:inherit;color:#fff;background:rgba(40,50,70,.9);border:1px solid rgba(255,255,255,.2);border-radius:.4vh;padding:.3vh .6vh}
.cb-snd .hd{margin-top:1vh;padding-top:.8vh;border-top:1px solid rgba(255,255,255,.12)}
.cb-snd .hdt{font-weight:700;margin-bottom:.5vh}
.cb-snd .hd button{width:100%;margin:.3vh 0;opacity:1}
.cb-snd .hint{opacity:.6;font-size:1.3vh;margin-top:.6vh}
.cb-snd-prompt{position:fixed;left:50%;bottom:9.5vh;transform:translateX(-50%);z-index:21;padding:1vh 2.2vh;border-radius:5vh;background:rgba(255,207,74,.96);color:#111;font:700 1.9vh "Segoe UI",Arial,sans-serif;letter-spacing:.02em;box-shadow:0 .6vh 2vh rgba(0,0,0,.5);cursor:pointer;transition:opacity .4s;animation:cbsndp 1.6s ease-in-out infinite}
@keyframes cbsndp{0%,100%{transform:translateX(-50%) scale(1)}50%{transform:translateX(-50%) scale(1.04)}}
`;

export interface UiHandlers {
  toggleMute(): void;
  changed(): void;
  /** the user touched a control that does not decide mute state: just try to start audio */
  gesture(): void;
  /** the user asked for sound (the prompt): unlock and unmute */
  enable(): void;
  /** HD voices: download + switch on / switch off */
  hdToggle(): void;
  /** HD voices: forget the downloaded model */
  hdRemove(): void;
  /** HD voices: play a short sample (PA, play-by-play, colour) */
  hdPreview(): void;
  /** "My voice (custom announcer)": optional, the audio controller wires it */
  voice?: VoicePanelHandlers & { initialUrl?: string };
}

export class AudioUi {
  private root: HTMLElement;
  private btn: HTMLButtonElement;
  private prompt: HTMLElement;
  private inputs: Record<string, HTMLInputElement> = {};
  private locked = true;
  private hdBtn!: HTMLButtonElement;
  private hdNote!: HTMLElement;
  private hdRemove!: HTMLButtonElement;
  private hdPreview!: HTMLButtonElement;
  voicePanel: VoicePanel | null = null;

  constructor(host: HTMLElement, private s: Settings, private h: UiHandlers) {
    const st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);
    this.root = document.createElement('div');
    this.root.className = 'cb-snd';
    const row = document.createElement('div');
    row.className = 'row';
    this.btn = document.createElement('button');
    this.btn.title = 'Sound on/off (M)';
    this.btn.setAttribute('aria-label', 'Toggle sound');
    this.btn.onclick = () => h.toggleMute();
    const gear = document.createElement('button');
    gear.textContent = '⚙';
    gear.title = 'Sound settings';
    gear.setAttribute('aria-label', 'Sound settings');
    gear.onclick = () => {
      this.root.classList.toggle('open');
      h.gesture();
    };
    row.append(this.btn, gear);
    const panel = document.createElement('div');
    panel.className = 'panel';
    const slider = (key: 'master' | 'sfx' | 'crowd' | 'organVolume' | 'announcer' | 'paVolume', text: string) => {
      const l = document.createElement('label');
      l.append(text);
      const i = document.createElement('input');
      i.type = 'range';
      i.min = '0';
      i.max = '1';
      i.step = '0.05';
      i.value = String(s[key]);
      i.oninput = () => {
        s[key] = Number(i.value);
        h.changed();
      };
      l.append(i);
      panel.append(l);
      this.inputs[key] = i;
    };
    const check = (key: 'pa' | 'commentary', text: string) => {
      const l = document.createElement('label');
      l.append(text);
      const i = document.createElement('input');
      i.type = 'checkbox';
      i.checked = s[key];
      i.onchange = () => {
        s[key] = i.checked;
        h.changed();
      };
      l.append(i);
      panel.append(l);
      this.inputs[key] = i;
    };
    slider('master', 'Master');
    slider('sfx', 'Effects');
    slider('crowd', 'Crowd');
    slider('organVolume', 'Organ');
    slider('announcer', 'Voices');
    slider('paVolume', 'PA announcer');
    check('pa', 'PA announcer & umpire');
    check('commentary', 'Commentary');
    {
      const l = document.createElement('label');
      l.append('Chatter');
      const sel = document.createElement('select');
      for (const v of ['low', 'normal', 'high'] as const) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = v[0].toUpperCase() + v.slice(1);
        sel.append(o);
      }
      sel.value = s.chatter;
      sel.onchange = () => {
        s.chatter = sel.value as Settings['chatter'];
        h.changed();
      };
      l.append(sel);
      panel.append(l);
    }
    {
      // optional neural voices: strictly opt-in, nothing is downloaded until this button is pressed
      const box = document.createElement('div');
      box.className = 'hd';
      const title = document.createElement('div');
      title.className = 'hdt';
      title.textContent = 'HD voices (optional)';
      this.hdBtn = document.createElement('button');
      this.hdBtn.onclick = () => h.hdToggle();
      this.hdNote = document.createElement('div');
      this.hdNote.className = 'hint';
      this.hdRemove = document.createElement('button');
      this.hdRemove.textContent = 'Remove download';
      this.hdRemove.style.display = 'none';
      this.hdRemove.onclick = () => h.hdRemove();
      this.hdPreview = document.createElement('button');
      this.hdPreview.textContent = 'Preview voices';
      this.hdPreview.style.display = 'none';
      this.hdPreview.onclick = () => h.hdPreview();
      box.append(title, this.hdBtn, this.hdPreview, this.hdNote, this.hdRemove);
      panel.append(box);
      this.setHd({ state: 'off' });
    }
    if (h.voice) this.voicePanel = mountVoicePanel(panel, h.voice, h.voice.initialUrl);
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'M mutes. Voices use your browser’s speech synthesis.';
    panel.append(hint);
    this.root.append(row, panel);
    this.prompt = document.createElement('div');
    this.prompt.className = 'cb-snd-prompt';
    this.prompt.textContent = '🔊 Click to enable sound';
    this.prompt.onclick = () => h.enable();
    host.append(this.root, this.prompt);
    this.refresh();
  }

  /** HD voices status: off (not downloaded / switched off), loading (with progress), ready, error */
  setHd(o: { state: 'off' | 'loading' | 'ready' | 'error'; pct?: number; text?: string; cached?: boolean; previewing?: boolean }) {
    const m = HD_MODES[pickMode()];
    const supported = hdSupported();
    this.hdBtn.disabled = o.state === 'loading' || !supported;
    this.hdBtn.textContent = o.state === 'ready' ? 'HD voices: on (switch off)' : o.state === 'loading' ? `Downloading… ${o.pct ?? 0}%` : o.cached ? 'Use HD voices' : `Download HD voices (~${m.mb} MB)`;
    this.hdNote.textContent =
      o.text ??
      (!supported
        ? 'HD voices need WebGPU, which this browser does not offer (the CPU version is slower than real time, so it is not offered).'
        : o.state === 'off'
        ? pickMode() === 'gpu'
          ? 'Neural voices (Kokoro, Apache-2.0) run in your browser on the GPU. One-time download from Hugging Face, kept in the browser cache.'
          : 'Neural voices (Kokoro, Apache-2.0) run in your browser. No WebGPU here, so they are slower than real time on the CPU and the booth will talk less. One-time download.'
        : '');
    this.hdRemove.style.display = o.cached || o.state === 'ready' ? '' : 'none';
    this.hdPreview.style.display = o.state === 'ready' ? '' : 'none';
    this.hdPreview.disabled = !!o.previewing;
  }

  refresh() {
    const silent = this.s.muted || this.locked;
    this.btn.textContent = silent ? '🔇' : '🔊';
    this.btn.title = this.locked ? 'Enable sound (M)' : silent ? 'Sound off (M)' : 'Sound on (M)';
    this.btn.classList.toggle('on', !silent);
  }

  /** show or hide the "click to enable" prompt */
  setLocked(locked: boolean) {
    this.locked = locked;
    this.refresh();
    this.prompt.style.opacity = locked ? '1' : '0';
    this.prompt.style.pointerEvents = locked ? 'auto' : 'none';
    if (!locked) setTimeout(() => (this.prompt.style.display = 'none'), 500);
    else this.prompt.style.display = '';
  }

  dispose() {
    this.root.remove();
    this.prompt.remove();
  }
}
