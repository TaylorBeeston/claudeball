/** Form controls for the menus: segmented choice, slider, switch, button. Each returns its element and a `set()` to re-sync it. */
import { h } from './dom';

export interface Control<T> {
  el: HTMLElement;
  set(v: T): void;
}

let uid = 0;
const nextId = (p: string) => `${p}-${++uid}`;

export function button(label: string, onClick: (e: MouseEvent) => void, variant: 'primary' | 'ghost' | 'danger' | 'quiet' = 'ghost', extra: Record<string, unknown> = {}): HTMLButtonElement {
  return h('button', { type: 'button', class: `cb-btn ${variant}`, onclick: onClick, ...extra }, label);
}

/** A labelled row: label (and optional hint) on the left/top, the control on the right/below. */
export function field(label: string, control: HTMLElement, hint?: string, controlId?: string): HTMLElement {
  const lab = h('label', { class: 'cb-lab', for: controlId }, label);
  return h('div', { class: 'cb-field' }, h('div', { class: 'cb-fieldtext' }, lab, hint ? h('div', { class: 'cb-hint' }, hint) : null), h('div', { class: 'cb-fctl' }, control));
}

export interface Choice<T> {
  value: T;
  label: string;
  /** shown under the group while this choice is selected */
  hint?: string;
}

/** Radio group of buttons; arrow keys move the selection. */
export function segmented<T extends string | number>(label: string, items: Choice<T>[], value: T, onChange: (v: T) => void): Control<T> & { hintEl: HTMLElement } {
  const group = h('div', { class: 'cb-seg', role: 'radiogroup', 'aria-label': label });
  const hintEl = h('div', { class: 'cb-hint seg-hint', 'aria-live': 'polite' });
  const btns = items.map((it) =>
    h('button', {
      type: 'button',
      role: 'radio',
      class: 'cb-segbtn',
      'data-v': String(it.value),
      onclick: () => choose(it.value, true),
      onkeydown: (e: Event) => {
        const k = (e as KeyboardEvent).key;
        const i = items.findIndex((x) => x.value === cur);
        const step = k === 'ArrowRight' || k === 'ArrowDown' ? 1 : k === 'ArrowLeft' || k === 'ArrowUp' ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        const n = items[(i + step + items.length) % items.length];
        choose(n.value, true);
        btns[items.indexOf(n)].focus();
      },
    }, it.label),
  );
  group.append(...btns);
  let cur = value;
  const paint = () => {
    items.forEach((it, i) => {
      const on = it.value === cur;
      btns[i].setAttribute('aria-checked', String(on));
      btns[i].tabIndex = on ? 0 : -1;
      btns[i].classList.toggle('on', on);
    });
    hintEl.textContent = items.find((x) => x.value === cur)?.hint ?? '';
  };
  const choose = (v: T, notify: boolean) => {
    cur = v;
    paint();
    if (notify) onChange(v);
  };
  paint();
  return { el: group, hintEl, set: (v) => choose(v, false) };
}

export function slider(label: string, value: number, onChange: (v: number) => void, opts: { min?: number; max?: number; step?: number; format?: (v: number) => string } = {}): Control<number> {
  const { min = 0, max = 1, step = 0.05, format = (v: number) => `${Math.round(v * 100)}%` } = opts;
  const id = nextId('cb-rng');
  const out = h('output', { class: 'cb-val', for: id });
  const input = h('input', { type: 'range', id, class: 'cb-range', min, max, step, value, 'aria-label': label });
  const paint = () => {
    out.textContent = format(Number(input.value));
    input.style.setProperty('--fill', `${((Number(input.value) - min) / (max - min)) * 100}%`);
  };
  input.addEventListener('input', () => {
    paint();
    onChange(Number(input.value));
  });
  paint();
  return {
    el: h('div', { class: 'cb-sliderwrap' }, input, out),
    set: (v) => {
      input.value = String(v);
      paint();
    },
  };
}

/** On/off switch (`role=switch`). */
export function toggle(label: string, value: boolean, onChange: (v: boolean) => void): Control<boolean> {
  let on = value;
  const b = h('button', { type: 'button', role: 'switch', class: 'cb-switch', 'aria-label': label }, h('i'));
  const paint = () => {
    b.setAttribute('aria-checked', String(on));
    b.classList.toggle('on', on);
  };
  b.addEventListener('click', () => {
    on = !on;
    paint();
    onChange(on);
  });
  paint();
  return {
    el: b,
    set: (v) => {
      on = v;
      paint();
    },
  };
}
