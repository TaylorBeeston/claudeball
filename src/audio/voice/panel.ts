/** The "My voice (custom announcer)" block of the audio panel: URL box, local-file picker, status. Plain DOM, no dependencies. */
import type { VoiceState } from './controller';

export interface VoicePanelHandlers {
  url(url: string): void;
  files(files: File[]): void;
  off(): void;
  forget(): void;
}

export interface VoicePanel {
  set(s: { state: VoiceState; pct: number; message: string; name: string }): void;
  setUrl(url: string): void;
}

export function mountVoicePanel(parent: HTMLElement, h: VoicePanelHandlers, initialUrl = ''): VoicePanel {
  const box = document.createElement('div');
  box.className = 'hd cb-myvoice';
  const title = document.createElement('div');
  title.className = 'hdt';
  title.textContent = 'My voice (custom announcer)';
  const url = document.createElement('input');
  url.type = 'url';
  url.placeholder = 'https://huggingface.co/you/claudeball-voice/resolve/main/';
  url.value = initialUrl;
  url.style.cssText = 'width:100%;box-sizing:border-box;margin:.3vh 0;font:inherit;color:#fff;background:rgba(40,50,70,.9);border:1px solid rgba(255,255,255,.2);border-radius:.4vh;padding:.4vh .6vh';
  url.setAttribute('aria-label', 'Voice pack URL');
  const go = document.createElement('button');
  go.textContent = 'Load my voice pack';
  go.onclick = () => url.value.trim() && h.url(url.value.trim());
  const pick = document.createElement('button');
  pick.textContent = 'Choose files… (voice.json + model)';
  const file = document.createElement('input');
  file.type = 'file';
  file.multiple = true;
  file.accept = '.json,.onnx';
  file.hidden = true;
  file.onchange = () => {
    if (file.files?.length) h.files([...file.files]);
    file.value = '';
  };
  pick.onclick = () => file.click();
  const off = document.createElement('button');
  off.textContent = 'Switch off';
  off.onclick = () => h.off();
  const forget = document.createElement('button');
  forget.textContent = 'Remove saved voice';
  forget.onclick = () => h.forget();
  const note = document.createElement('div');
  note.className = 'hint';
  box.append(title, url, go, pick, file, off, forget, note);
  parent.append(box);
  const set: VoicePanel['set'] = ({ state, pct, message, name }) => {
    go.disabled = pick.disabled = state === 'loading';
    go.textContent = state === 'loading' ? `Loading… ${pct}%` : 'Load my voice pack';
    off.style.display = state === 'ready' ? '' : 'none';
    forget.style.display = state === 'ready' || state === 'error' ? '' : 'none';
    note.textContent =
      state === 'ready' ? `${name} is on. Lines it cannot say use the browser voice.` :
      state === 'error' ? `Could not start your voice (${message}). Using the browser voices.` :
      state === 'loading' ? 'Downloading your voice model (kept in this browser afterwards)…' :
      'Opt-in. Your own trained voice (npm run announcer:export). Nothing is uploaded; the model comes from the URL or the files you pick.';
  };
  set({ state: 'off', pct: 0, message: '', name: '' });
  return { set, setUrl: (u) => (url.value = u) };
}
