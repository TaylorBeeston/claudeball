/** Tiny DOM helpers (no framework): `h('button', { class: 'x', onclick: fn }, 'Label')`. */
type Kid = Node | string | number | null | undefined | false;
type Attrs = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = String(v);
    else if (k === 'text') e.textContent = String(v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v as EventListener);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, String(v));
  }
  for (const kid of kids) if (kid !== null && kid !== undefined && kid !== false) e.append(kid instanceof Node ? kid : String(kid));
  return e;
}

/** Resolves on the next animation frame, or after 60 ms when frames are throttled (hidden tab). */
export const nextFrame = () =>
  new Promise<void>((r) => {
    let done = false;
    const fin = () => !done && ((done = true), r());
    requestAnimationFrame(fin);
    setTimeout(fin, 60);
  });

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** localStorage, or null when blocked (private windows, sandboxed iframes: the accessor itself can throw). */
export function safeStorage(): Storage | null {
  try {
    const s = window.localStorage;
    s.getItem('claudeball.probe');
    return s;
  } catch {
    return null;
  }
}

/** Elements inside `root` that can take focus, in tab order. */
export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((e) => !e.hasAttribute('disabled') && e.offsetParent !== null);
}
