import { MPS_TO_MPH, M_TO_FT, DIM } from './dims';
import type { GameEvent, GameState, PersonInfo, TeamStatsView } from './types';
import { arsenalText, batLine, batterBars, batterTotals, boxBatters, boxPitchers, gradeColor, pitcherBars, pitcherTotals, pitLine, type RatingBar } from './hudStats';

const CSS = /* css */ `
.cb-hud{position:absolute;inset:0;pointer-events:none;font-family:"Segoe UI","Helvetica Neue",Arial,sans-serif;color:#fff;--u:1vh;text-shadow:0 1px 2px rgba(0,0,0,.6);user-select:none}
.cb-hud *{box-sizing:border-box}
.cb-bug{position:absolute;left:3.2vw;bottom:5.2vh;display:flex;align-items:stretch;height:calc(var(--u)*7.4);background:linear-gradient(180deg,rgba(18,22,30,.94),rgba(8,10,16,.94));border-radius:calc(var(--u)*.7);box-shadow:0 calc(var(--u)*.6) calc(var(--u)*2) rgba(0,0,0,.5),inset 0 0 0 1px rgba(255,255,255,.08);overflow:hidden;font-weight:700;letter-spacing:.03em}
.cb-teams{height:100%;display:flex;flex-direction:column;justify-content:center;min-width:calc(var(--u)*19)}
.cb-row{display:flex;align-items:center;height:50%;line-height:1;padding:0 calc(var(--u)*1.2) 0 0}
.cb-row .bar{width:calc(var(--u)*.9);height:100%;margin-right:calc(var(--u)*1)}
.cb-row .abbr{display:flex;align-items:center;white-space:nowrap;font-size:calc(var(--u)*2.9);width:calc(var(--u)*7.6);letter-spacing:.08em}
.cb-row .sc{margin-left:auto;font-size:calc(var(--u)*3.4);font-variant-numeric:tabular-nums;min-width:calc(var(--u)*4);text-align:right;background:rgba(255,255,255,.08);padding:0 calc(var(--u)*.9);height:100%;display:flex;align-items:center;justify-content:flex-end}
.cb-row.bat .abbr::after{content:"";display:inline-block;width:0;height:0;margin-left:calc(var(--u)*.7);border-left:calc(var(--u)*.7) solid #ffcf4a;border-top:calc(var(--u)*.45) solid transparent;border-bottom:calc(var(--u)*.45) solid transparent}
.cb-mid{display:flex;align-items:center;gap:calc(var(--u)*1.6);padding:0 calc(var(--u)*1.6);border-left:1px solid rgba(255,255,255,.1)}
.cb-inn{font-size:calc(var(--u)*3);display:flex;align-items:center;gap:calc(var(--u)*.5);min-width:calc(var(--u)*5.2)}
.cb-inn i{font-style:normal;font-size:calc(var(--u)*1.7);color:#ffcf4a}
.cb-dia{position:relative;width:calc(var(--u)*5.6);height:calc(var(--u)*5.6)}
.cb-dia b{position:absolute;width:calc(var(--u)*1.7);height:calc(var(--u)*1.7);background:rgba(255,255,255,.18);transform:rotate(45deg);border:1px solid rgba(255,255,255,.4);transition:background .2s}
.cb-dia b.on{background:#ffcf4a;border-color:#fff}
.cb-dia b:nth-child(1){right:0;top:50%;margin-top:calc(var(--u)*-.85)}
.cb-dia b:nth-child(2){left:50%;top:0;margin-left:calc(var(--u)*-.85)}
.cb-dia b:nth-child(3){left:0;top:50%;margin-top:calc(var(--u)*-.85)}
.cb-cnt{display:flex;flex-direction:column;gap:calc(var(--u)*.5);font-size:calc(var(--u)*1.9);min-width:calc(var(--u)*8.2)}
.cb-cnt div{display:flex;align-items:center;gap:calc(var(--u)*.7)}
.cb-cnt span.l{width:calc(var(--u)*1.3);opacity:.8}
.cb-dots{display:flex;gap:calc(var(--u)*.45)}
.cb-dots u{width:calc(var(--u)*1.25);height:calc(var(--u)*1.25);border-radius:50%;background:rgba(255,255,255,.16);text-decoration:none}
.cb-dots.b u.on{background:#4dd26a}.cb-dots.s u.on{background:#ff6a4d}.cb-dots.o u.on{background:#ffcf4a}
.cb-call{position:absolute;left:3.2vw;bottom:calc(5.2vh + var(--u)*8.2);padding:calc(var(--u)*.6) calc(var(--u)*1.6);font-weight:800;font-size:calc(var(--u)*2.6);letter-spacing:.14em;background:rgba(10,12,18,.9);border-radius:calc(var(--u)*.5);border-left:calc(var(--u)*.6) solid #ffcf4a;opacity:0;transform:translateY(calc(var(--u)*1));transition:opacity .2s,transform .2s}
.cb-call.show{opacity:1;transform:none}
.cb-pt{position:absolute;right:3vw;bottom:5.2vh;width:calc(var(--u)*19);background:linear-gradient(180deg,rgba(18,22,30,.94),rgba(8,10,16,.94));border-radius:calc(var(--u)*.7);padding:calc(var(--u)*1.2);box-shadow:0 calc(var(--u)*.6) calc(var(--u)*2) rgba(0,0,0,.5),inset 0 0 0 1px rgba(255,255,255,.08);transition:opacity .4s}
.cb-pt .hd{display:flex;justify-content:space-between;align-items:baseline;font-weight:800}
.cb-pt .spd{font-size:calc(var(--u)*4.4);line-height:1}.cb-pt .spd small{font-size:calc(var(--u)*1.6);opacity:.7;margin-left:.2em}
.cb-pt .typ{font-size:calc(var(--u)*1.35);letter-spacing:.08em;color:#ffcf4a;text-align:right;line-height:1.2;max-width:45%}
.cb-pt canvas{display:block;width:100%;margin-top:calc(var(--u)*.8)}
.cb-card{position:absolute;left:3.2vw;bottom:calc(5.2vh + var(--u)*11);min-width:calc(var(--u)*46);display:flex;transform:translateX(-120%);transition:transform .5s cubic-bezier(.2,.8,.2,1);filter:drop-shadow(0 calc(var(--u)*.6) calc(var(--u)*1.4) rgba(0,0,0,.6))}
.cb-card.show{transform:none}
.cb-card .num{background:var(--c,#333);width:calc(var(--u)*7.6);display:flex;align-items:center;justify-content:center;font-size:calc(var(--u)*3.8);font-weight:800}
.cb-card .txt{background:linear-gradient(180deg,rgba(18,22,30,.96),rgba(8,10,16,.96));padding:calc(var(--u)*.9) calc(var(--u)*2.2) calc(var(--u)*1) calc(var(--u)*1.6);flex:1}
.cb-card .role{font-size:calc(var(--u)*1.4);letter-spacing:.2em;color:#ffcf4a;font-weight:700}
.cb-card .nm{font-size:calc(var(--u)*3.4);font-weight:800;letter-spacing:.03em;text-transform:uppercase;white-space:nowrap}
.cb-card .st{font-size:calc(var(--u)*1.7);opacity:.82;font-weight:600;letter-spacing:.05em}
.cb-hit{position:absolute;left:50%;top:9vh;transform:translate(-50%,calc(var(--u)*-3));opacity:0;transition:opacity .35s,transform .35s;display:flex;background:linear-gradient(180deg,rgba(18,22,30,.94),rgba(8,10,16,.94));border-radius:calc(var(--u)*.7);box-shadow:inset 0 0 0 1px rgba(255,255,255,.1)}
.cb-hit.show{opacity:1;transform:translate(-50%,0)}
.cb-hit div{padding:calc(var(--u)*1) calc(var(--u)*2.4);text-align:center;border-right:1px solid rgba(255,255,255,.1)}.cb-hit div:last-child{border:0}
.cb-hit b{display:block;font-size:calc(var(--u)*3.6);font-variant-numeric:tabular-nums;line-height:1.05}.cb-hit small{font-size:calc(var(--u)*1.25);letter-spacing:.2em;opacity:.7}
.cb-tick{position:absolute;left:0;right:0;bottom:0;height:calc(var(--u)*3.6);display:flex;align-items:center;padding:0 3.2vw;background:linear-gradient(0deg,rgba(0,0,0,.8),rgba(0,0,0,0));font-size:calc(var(--u)*1.85);font-weight:600;letter-spacing:.02em}
.cb-tick span{opacity:.6;margin-right:2em;white-space:nowrap}.cb-tick span:last-child{opacity:1;color:#fff}
.cb-rep{position:absolute;left:3.2vw;top:4.5vh;font-weight:900;font-size:calc(var(--u)*3);letter-spacing:.3em;padding:calc(var(--u)*.6) calc(var(--u)*1.8);background:#ffcf4a;color:#111;text-shadow:none;transform:skewX(-10deg);opacity:0;transition:opacity .2s}
.cb-rep.show{opacity:1}
.cb-wipe{position:absolute;inset:0;background:linear-gradient(100deg,transparent 0%,transparent 40%,var(--w1,#ffcf4a) 40%,var(--w1,#ffcf4a) 46%,#0a0c12 46%,#0a0c12 100%);transform:translateX(-110%);pointer-events:none}
.cb-wipe.go{animation:cbwipe .7s cubic-bezier(.6,0,.3,1)}
@keyframes cbwipe{0%{transform:translateX(-110%)}45%{transform:translateX(0)}55%{transform:translateX(0)}100%{transform:translateX(110%)}}
.cb-ctl{position:absolute;top:2.2vh;right:2vw;display:flex;gap:calc(var(--u)*.7);align-items:center;pointer-events:auto;opacity:.0;transition:opacity .25s;font-size:calc(var(--u)*1.6)}
.cb-hud:hover .cb-ctl,.cb-ctl:focus-within{opacity:1}
.cb-ctl button,.cb-ctl select{font:inherit;font-weight:700;color:#fff;background:rgba(14,18,26,.85);border:1px solid rgba(255,255,255,.18);border-radius:calc(var(--u)*.5);padding:calc(var(--u)*.6) calc(var(--u)*1.1);cursor:pointer}
.cb-ctl button:hover,.cb-ctl select:hover{background:rgba(40,50,70,.95)}.cb-ctl button.on{background:#ffcf4a;color:#111;text-shadow:none}
.cb-fps{font-variant-numeric:tabular-nums;opacity:.85;min-width:6em;text-align:right;text-shadow:0 1px 2px #000}
.cb-card{min-width:calc(var(--u)*50)}
.cb-card .txt{padding-bottom:calc(var(--u)*1.1)}
.cb-card .sub{font-size:calc(var(--u)*1.55);opacity:.9;font-weight:600;letter-spacing:.04em;margin-top:calc(var(--u)*.15);display:flex;gap:calc(var(--u)*1.4);flex-wrap:wrap}
.cb-card .sub b{color:#ffcf4a;font-weight:800}
.cb-bars{display:grid;grid-template-columns:1fr 1fr;gap:calc(var(--u)*.5) calc(var(--u)*1.8);margin-top:calc(var(--u)*.9)}
.cb-bar{display:flex;align-items:center;gap:calc(var(--u)*.7);font-size:calc(var(--u)*1.25);letter-spacing:.12em;font-weight:700}
.cb-bar span.l{width:calc(var(--u)*9.4);opacity:.75}
.cb-bar .tr{flex:1;height:calc(var(--u)*.85);background:rgba(255,255,255,.12);border-radius:calc(var(--u)*.5);overflow:hidden}
.cb-bar .tr i{display:block;height:100%;border-radius:calc(var(--u)*.5)}
.cb-bar span.v{width:calc(var(--u)*2.4);text-align:right;font-variant-numeric:tabular-nums}
.cb-ars{margin-top:calc(var(--u)*.8);font-size:calc(var(--u)*1.35);letter-spacing:.08em;color:#ffcf4a;font-weight:700;white-space:nowrap}
.cb-box{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(96vw,calc(var(--u)*170));max-height:88vh;overflow:auto;background:linear-gradient(180deg,rgba(14,18,26,.97),rgba(6,8,12,.97));border-radius:calc(var(--u)*1);box-shadow:0 calc(var(--u)*1) calc(var(--u)*4) rgba(0,0,0,.7),inset 0 0 0 1px rgba(255,255,255,.1);padding:calc(var(--u)*1.6) calc(var(--u)*2);display:none;pointer-events:auto;font-size:calc(var(--u)*1.55)}
.cb-box.show{display:block}
.cb-box h3{margin:0 0 calc(var(--u)*.8);font-size:calc(var(--u)*2.1);letter-spacing:.12em;display:flex;justify-content:space-between;align-items:baseline}
.cb-box h3 small{font-size:calc(var(--u)*1.2);opacity:.6;letter-spacing:.1em;font-weight:600}
.cb-box .cols{display:grid;grid-template-columns:1fr 1fr;gap:calc(var(--u)*2.4)}
@media (max-width:900px){.cb-box .cols{grid-template-columns:1fr}}
.cb-box table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;margin-bottom:calc(var(--u)*1.2)}
.cb-box th{font-size:calc(var(--u)*1.15);letter-spacing:.1em;opacity:.6;text-align:right;font-weight:700;padding:calc(var(--u)*.25) calc(var(--u)*.6);border-bottom:1px solid rgba(255,255,255,.15)}
.cb-box td{text-align:right;padding:calc(var(--u)*.3) calc(var(--u)*.6);border-bottom:1px solid rgba(255,255,255,.06)}
.cb-box th:first-child,.cb-box td:first-child,.cb-box th:nth-child(2),.cb-box td:nth-child(2){text-align:left}
.cb-box td:first-child{opacity:.55;width:2.2em}
.cb-box tr.tot td{font-weight:800;border-top:1px solid rgba(255,255,255,.25);opacity:1}
.cb-box tr.out td{opacity:.5}
.cb-box .foot{opacity:.55;font-size:calc(var(--u)*1.2);margin-top:calc(var(--u)*.4)}
.cb-final{position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(4,6,10,.55);font-size:calc(var(--u)*8);font-weight:900;letter-spacing:.1em}
`;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
};

export interface HudActions {
  togglePause(): boolean;
  setSpeed(x: number): void;
  skipHalf(): void;
  setAuto(auto: boolean): void;
  setQuality(q: string): void;
  setTimeOfDay(t: string): void;
  setReplays(on: boolean): void;
}

export class Hud {
  readonly root = el('div', 'cb-hud');
  private bug = el('div', 'cb-bug');
  private teamRows: HTMLElement[] = [];
  private abbr: HTMLElement[] = [];
  private score: HTMLElement[] = [];
  private bars: HTMLElement[] = [];
  private inn = el('div', 'cb-inn');
  private bases: HTMLElement[] = [];
  private dotsB = el('div', 'cb-dots b');
  private dotsS = el('div', 'cb-dots s');
  private dotsO = el('div', 'cb-dots o');
  private call = el('div', 'cb-call');
  private pt = el('div', 'cb-pt');
  private ptCanvas = document.createElement('canvas');
  private ptSpeed = el('div', 'spd');
  private ptType = el('div', 'typ');
  private card = el('div', 'cb-card');
  private hit = el('div', 'cb-hit');
  private tick = el('div', 'cb-tick');
  private rep = el('div', 'cb-rep', 'REPLAY');
  private wipe = el('div', 'cb-wipe');
  private fps = el('span', 'cb-fps');
  private final = el('div', 'cb-final');
  private pitches: { x: number; y: number; k: 'b' | 's' | 'x' }[] = [];
  private lastPitch: { type: string; speed: number } | null = null;
  private lines: string[] = [];
  private lastKey = '';
  private cardTimer = 0;
  private hitTimer = 0;
  private callTimer = 0;
  private lastBatter = '';
  private lastPitcher = '';
  private lastHalf = '';
  private lastCallSeq = 0;
  private ptTimer = 0;
  private replayShown = false;
  private box = el('div', 'cb-box');
  private boxOpen = false;
  private boxTimer = 0;
  private lastState: GameState | null = null;

  constructor(parent: HTMLElement, private act: HudActions) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const teams = el('div', 'cb-teams');
    for (let i = 0; i < 2; i++) {
      const row = el('div', 'cb-row');
      const bar = el('div', 'bar');
      const ab = el('div', 'abbr');
      const sc = el('div', 'sc', '0');
      row.append(bar, ab, sc);
      teams.appendChild(row);
      this.teamRows.push(row);
      this.abbr.push(ab);
      this.score.push(sc);
      this.bars.push(bar);
    }
    const mid = el('div', 'cb-mid');
    const dia = el('div', 'cb-dia');
    for (let i = 0; i < 3; i++) {
      const b = el('b');
      dia.appendChild(b);
      this.bases.push(b);
    }
    const cnt = el('div', 'cb-cnt');
    const mk = (label: string, dots: HTMLElement, n: number) => {
      const r = el('div');
      r.append(el('span', 'l', label), dots);
      for (let i = 0; i < n; i++) dots.appendChild(el('u'));
      return r;
    };
    const bs = el('div');
    bs.style.cssText = 'display:flex;gap:1.2vh';
    cnt.append(mk('B', this.dotsB, 3), mk('S', this.dotsS, 2), mk('O', this.dotsO, 2));
    // rearrange: count row shows B S together
    mid.append(this.inn, dia, cnt);
    this.bug.append(teams, mid);

    this.ptCanvas.width = 360;
    this.ptCanvas.height = 400;
    const hd = el('div', 'hd');
    hd.append(this.ptSpeed, this.ptType);
    this.pt.append(hd, this.ptCanvas);
    this.pt.style.opacity = '0';

    this.card.innerHTML = '<div class="num"></div><div class="txt"><div class="role"></div><div class="nm"></div><div class="st"></div><div class="sub"></div><div class="cb-bars"></div><div class="cb-ars"></div></div>';
    this.hit.innerHTML = '<div><b class="ev">--</b><small>EXIT VELO MPH</small></div><div><b class="la">--</b><small>LAUNCH ANGLE</small></div><div><b class="dist">--</b><small>DISTANCE FT</small></div>';

    parent.appendChild(this.root);
    this.root.append(this.bug, this.call, this.pt, this.card, this.hit, this.tick, this.rep, this.wipe, this.box, this.buildControls(), this.final);
  }

  private buildControls(): HTMLElement {
    const c = el('div', 'cb-ctl');
    const btn = (label: string, fn: (b: HTMLButtonElement) => void) => {
      const b = el('button', '', label);
      b.onclick = () => fn(b);
      c.appendChild(b);
      return b;
    };
    btn('❚❚ Pause', (b) => {
      const p = this.act.togglePause();
      b.textContent = p ? '▶ Play' : '❚❚ Pause';
    });
    const speeds: HTMLButtonElement[] = [];
    for (const s of [1, 2, 4]) {
      const b = btn(`${s}x`, () => {
        this.act.setSpeed(s);
        speeds.forEach((x) => x.classList.toggle('on', x === b));
      });
      speeds.push(b);
      if (s === 1) b.classList.add('on');
    }
    btn('⏭ Next half', () => this.act.skipHalf());
    btn('Box score (B)', () => this.toggleBox());
    const cam = btn('Camera: Auto', (b) => {
      const auto = !b.classList.contains('on');
      b.classList.toggle('on', auto);
      b.textContent = auto ? 'Camera: Auto' : 'Camera: Free';
      this.act.setAuto(auto);
    });
    cam.classList.add('on');
    const rp = btn('Replays', (b) => {
      b.classList.toggle('on');
      this.act.setReplays(b.classList.contains('on'));
    });
    rp.classList.add('on');
    const sel = (opts: string[], val: string, fn: (v: string) => void) => {
      const s = el('select');
      for (const o of opts) s.appendChild(new Option(o, o, false, o === val));
      s.onchange = () => fn(s.value);
      c.appendChild(s);
    };
    sel(['low', 'medium', 'high', 'ultra'], 'high', (v) => this.act.setQuality(v));
    sel(['day', 'dusk', 'night'], 'day', (v) => this.act.setTimeOfDay(v));
    c.appendChild(this.fps);
    return c;
  }

  setFps(fps: number, scale: number) {
    this.fps.textContent = `${Math.round(fps)} FPS · ${Math.round(scale * 100)}%`;
  }

  onEvent(e: GameEvent, state: GameState) {
    switch (e.type) {
      case 'pitch':
        this.lastPitch = { type: pitchName(e.pitchType), speed: e.speed * MPS_TO_MPH };
        this.ptSpeed.innerHTML = `${Math.round(this.lastPitch.speed)}<small>MPH</small>`;
        this.ptType.textContent = this.lastPitch.type;
        this.pt.style.opacity = '1';
        this.ptTimer = 6;
        this.hitTimer = Math.min(this.hitTimer, 0.01);
        break;
      case 'contact': {
        const q = (s: string) => this.hit.querySelector(s) as HTMLElement;
        q('.ev').textContent = String(Math.round(e.exitVelo * MPS_TO_MPH));
        q('.la').textContent = `${Math.round(e.launchAngle)}°`;
        q('.dist').textContent = '--';
        this.hit.classList.add('show');
        this.hitTimer = 9;
        this.pitches.length && (this.pitches[this.pitches.length - 1].k = 'x');
        this.drawZone();
        break;
      }
      case 'ball':
      case 'strike':
      case 'foul':
        this.flashCall(e.type.toUpperCase());
        break;
      case 'out':
        this.flashCall('OUT');
        break;
      case 'safe':
        this.flashCall('SAFE');
        break;
      case 'umpire_call': {
        // the caption appears with the umpire's gesture
        const cap = CALL_CAPTIONS[e.kind];
        if (cap) this.flashCall(cap);
        break;
      }
      case 'half_inning':
        this.push(`${e.half === 'top' ? 'Top' : 'Bottom'} of inning ${e.inning}`);
        break;
      case 'game_end':
        this.push('Game over');
        this.final.style.display = 'flex';
        this.final.textContent = `FINAL  ${state.teams.away.abbr} ${state.score.away} – ${state.teams.home.abbr} ${state.score.home}`;
        break;
    }
    const text = describe(e, state);
    if (text) this.push(text);
  }

  /** Batted-ball distance once it lands. */
  setDistance(m: number) {
    (this.hit.querySelector('.dist') as HTMLElement).textContent = String(Math.round(m * M_TO_FT));
  }

  pitchCrossed(x: number, y: number, call: 'b' | 's') {
    this.pitches.push({ x: -x, y, k: call }); // +X is third base = catcher's left
    if (this.pitches.length > 7) this.pitches.shift();
    this.drawZone();
  }

  private push(t: string) {
    this.lines.push(t);
    if (this.lines.length > 3) this.lines.shift();
    this.tick.innerHTML = this.lines.map((l) => `<span>${escapeHtml(l)}</span>`).join('');
  }

  private flashCall(t: string) {
    this.call.textContent = t;
    this.call.classList.add('show');
    this.callTimer = 1.6;
  }

  showReplay(on: boolean, teamColor?: string, caption?: string | null) {
    this.rep.classList.toggle('show', on);
    if (on && caption && this.rep.textContent !== caption) this.rep.textContent = caption;
    if (on !== this.replayShown) {
      this.replayShown = on;
      if (teamColor) this.wipe.style.setProperty('--w1', teamColor);
      this.wipe.classList.remove('go');
      void this.wipe.offsetWidth;
      this.wipe.classList.add('go');
    }
  }

  private showCard(role: string, p: PersonInfo, color: string, s: GameState, kind: 'bat' | 'pit') {
    const q = (sel: string) => this.card.querySelector(sel) as HTMLElement;
    this.card.style.setProperty('--c', color);
    q('.num').textContent = String(p.number);
    q('.role').textContent = role;
    q('.nm').textContent = p.name;
    q('.st').textContent = `${p.hand === 'L' ? 'LEFT' : 'RIGHT'}-HANDED${p.position ? '  ·  ' + p.position : ''}  ·  ${p.stats ?? ''}`;
    // live game line from the sim's box-score stats
    const teamSide = kind === 'bat' ? (s.half === 'top' ? 'away' : 'home') : s.half === 'top' ? 'home' : 'away';
    const entry = (kind === 'bat' ? s.stats?.[teamSide].batters : s.stats?.[teamSide].pitchers)?.find((e) => e.playerId === p.id);
    const line = kind === 'bat' ? batLine(entry?.game.batting) : pitLine(entry?.game.pitching);
    q('.sub').innerHTML = line ? `<span>TODAY</span><b>${escapeHtml(line)}</b>` : '';
    const bars: RatingBar[] = kind === 'bat' ? batterBars(p.ratings) : pitcherBars(p.ratings);
    q('.cb-bars').innerHTML = bars
      .map((b) => `<div class="cb-bar"><span class="l">${b.label}</span><span class="tr"><i style="width:${Math.round(b.fill * 100)}%;background:${gradeColor(b.grade)}"></i></span><span class="v">${b.text ?? b.grade}</span></div>`)
      .join('');
    q('.cb-ars').textContent = kind === 'pit' ? arsenalText(p.arsenal) : '';
    this.card.classList.add('show');
    this.cardTimer = 7;
  }

  /** Box-score panel (key B). */
  toggleBox() {
    this.boxOpen = !this.boxOpen;
    this.box.classList.toggle('show', this.boxOpen);
    if (this.boxOpen) this.renderBox(this.lastState);
  }

  private renderBox(s: GameState | null) {
    if (!s) return;
    const side = (t: TeamStatsView | undefined, name: string, abbr: string, runs: number) => {
      const bt = boxBatters(t), pt = boxPitchers(t);
      const btot = batterTotals(bt), ptot = pitcherTotals(pt);
      const brow = bt.map((r) => `<tr class="${r.inGame ? '' : 'out'}"><td>${r.num}</td><td>${escapeHtml(r.name)} <span style="opacity:.5">${r.pos}</span></td><td>${r.ab}</td><td>${r.r}</td><td>${r.h}</td><td>${r.rbi}</td><td>${r.hr}</td><td>${r.bb}</td><td>${r.so}</td><td>${r.avg}</td></tr>`).join('');
      const prow = pt.map((r) => `<tr><td>${r.num}</td><td>${escapeHtml(r.name)}</td><td>${r.ip}</td><td>${r.h}</td><td>${r.r}</td><td>${r.er}</td><td>${r.bb}</td><td>${r.so}</td><td>${r.hr}</td><td>${r.pitches}</td><td>${r.era}</td></tr>`).join('');
      return `<div><h3><span>${escapeHtml(name)} <small>${abbr}</small></span><span>${runs}</span></h3>
        <table><tr><th></th><th>BATTING</th><th>AB</th><th>R</th><th>H</th><th>RBI</th><th>HR</th><th>BB</th><th>SO</th><th>AVG</th></tr>${brow}
        <tr class="tot"><td></td><td>TOTALS</td><td>${btot.ab}</td><td>${btot.r}</td><td>${btot.h}</td><td>${btot.rbi}</td><td>${btot.hr}</td><td>${btot.bb}</td><td>${btot.so}</td><td></td></tr></table>
        <table><tr><th></th><th>PITCHING</th><th>IP</th><th>H</th><th>R</th><th>ER</th><th>BB</th><th>SO</th><th>HR</th><th>P</th><th>ERA</th></tr>${prow}
        <tr class="tot"><td></td><td>TOTALS</td><td>${ptot.ip}</td><td>${ptot.h}</td><td>${ptot.r}</td><td>${ptot.er}</td><td>${ptot.bb}</td><td>${ptot.so}</td><td>${ptot.hr}</td><td>${ptot.pitches}</td><td></td></tr></table>
        <div class="foot">${t ? `Runs ${t.totals.runs}  ·  Hits ${t.totals.hits}  ·  Errors ${t.totals.errors}  ·  LOB ${t.totals.lob}` : ''}</div></div>`;
    };
    if (!s.stats) {
      this.box.innerHTML = '<h3><span>BOX SCORE</span></h3><div class="foot">No stats from this sim.</div>';
      return;
    }
    this.box.innerHTML =
      `<h3><span>BOX SCORE</span><small>${s.half === 'top' ? 'TOP' : 'BOTTOM'} ${s.inning}  ·  PRESS B TO CLOSE</small></h3><div class="cols">` +
      side(s.stats.away, s.teams.away.name, s.teams.away.abbr, s.score.away) +
      side(s.stats.home, s.teams.home.name, s.teams.home.abbr, s.score.home) +
      '</div>';
  }

  update(s: GameState, dt: number) {
    this.lastState = s;
    if (this.boxOpen && (this.boxTimer -= dt) < 0) {
      this.boxTimer = 0.5;
      this.renderBox(s);
    }
    const key = `${s.score.away}|${s.score.home}|${s.inning}${s.half}|${s.outs}|${s.count.balls}${s.count.strikes}|${s.runners.join()}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      const t = [s.teams.away, s.teams.home];
      for (let i = 0; i < 2; i++) {
        this.abbr[i].textContent = t[i].abbr;
        this.bars[i].style.background = t[i].color === '#f4f4f0' ? t[i].trim : t[i].color;
        this.score[i].textContent = String(i === 0 ? s.score.away : s.score.home);
        this.teamRows[i].classList.toggle('bat', (i === 0) === (s.half === 'top'));
      }
      this.inn.innerHTML = `<i>${s.half === 'top' ? '▲' : '▼'}</i>${s.inning}`;
      s.runners.forEach((r, i) => this.bases[i].classList.toggle('on', r));
      const setDots = (d: HTMLElement, n: number) => Array.from(d.children).forEach((u, i) => u.classList.toggle('on', i < n));
      setDots(this.dotsB, s.count.balls);
      setDots(this.dotsS, s.count.strikes);
      setDots(this.dotsO, s.outs);
    }
    // cards
    const b = s.batter, p = s.pitcher;
    const half = s.inning + s.half;
    if (p && (p.id !== this.lastPitcher || half !== this.lastHalf) && s.half) {
      this.lastPitcher = p.id;
      this.lastHalf = half;
      this.showCard('PITCHING', p, s.half === 'top' ? s.teams.home.color : s.teams.away.color, s, 'pit');
    } else if (b && b.id !== this.lastBatter) {
      this.lastBatter = b.id;
      this.showCard('AT BAT', b, s.half === 'top' ? s.teams.away.color : s.teams.home.color, s, 'bat');
      this.pitches = [];
      this.drawZone();
    }
    if (s.umpireCall.seq !== this.lastCallSeq) {
      this.lastCallSeq = s.umpireCall.seq;
      if (s.umpireCall.kind === 'safe') this.flashCall('SAFE');
      if (s.umpireCall.kind === 'homerun') this.flashCall('HOME RUN');
    }
    if ((this.cardTimer -= dt) < 0) this.card.classList.remove('show');
    if ((this.hitTimer -= dt) < 0) this.hit.classList.remove('show');
    if ((this.callTimer -= dt) < 0) this.call.classList.remove('show');
    if ((this.ptTimer -= dt) < 0 && this.pt.style.opacity !== '0') this.pt.style.opacity = '0';
  }

  private drawZone() {
    const c = this.ptCanvas, g = c.getContext('2d')!;
    const W = c.width, H = c.height;
    g.clearRect(0, 0, W, H);
    const x0 = -0.55, x1 = 0.55, y0 = 0.05, y1 = 1.55;
    const px = (x: number) => ((x - x0) / (x1 - x0)) * W;
    const py = (y: number) => H - ((y - y0) / (y1 - y0)) * H;
    g.fillStyle = 'rgba(255,255,255,0.05)';
    g.fillRect(0, 0, W, H);
    const zl = px(-DIM.plateWidth / 2), zr = px(DIM.plateWidth / 2), zt = py(DIM.zoneTop), zb = py(DIM.zoneBottom);
    g.strokeStyle = 'rgba(255,255,255,0.85)';
    g.lineWidth = 3;
    g.strokeRect(zl, zt, zr - zl, zb - zt);
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(255,255,255,0.3)';
    for (let i = 1; i < 3; i++) {
      g.beginPath();
      g.moveTo(zl + ((zr - zl) * i) / 3, zt);
      g.lineTo(zl + ((zr - zl) * i) / 3, zb);
      g.moveTo(zl, zt + ((zb - zt) * i) / 3);
      g.lineTo(zr, zt + ((zb - zt) * i) / 3);
      g.stroke();
    }
    // plate
    g.fillStyle = 'rgba(255,255,255,0.75)';
    g.beginPath();
    g.moveTo(zl, H - 8); g.lineTo(zr, H - 8); g.lineTo(zr, H - 22); g.lineTo((zl + zr) / 2, H - 34); g.lineTo(zl, H - 22);
    g.fill();
    this.pitches.forEach((p, i) => {
      g.beginPath();
      g.arc(px(p.x), py(p.y), i === this.pitches.length - 1 ? 17 : 12, 0, Math.PI * 2);
      g.fillStyle = p.k === 'b' ? '#4dd26a' : p.k === 's' ? '#ff6a4d' : '#7ac0ff';
      g.fill();
      g.lineWidth = 2;
      g.strokeStyle = 'rgba(0,0,0,0.6)';
      g.stroke();
      g.fillStyle = '#fff';
      g.font = 'bold 15px Arial';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(i + 1), px(p.x), py(p.y) + 1);
    });
  }
}

/** what the umpires' calls are called on screen (sim call kinds → caption) */
export const CALL_CAPTIONS: Record<string, string> = {
  ball: 'BALL', ball_four: 'BALL FOUR', strike_called: 'STRIKE', strikeLooking: 'STRIKE', strike_swinging: 'STRIKE', strikeSwinging: 'STRIKE', strike: 'STRIKE',
  strikeout: 'STRIKEOUT', foul: 'FOUL', foul_tip: 'FOUL TIP', foulTip: 'FOUL TIP', fair: 'FAIR', safe: 'SAFE', out: 'OUT', homerun: 'HOME RUN', homeRun: 'HOME RUN', time: 'TIME',
};

function escapeHtml(s: string) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
}

const PITCH_NAMES: Record<string, string> = { FF: 'FOUR-SEAM FASTBALL', SI: 'SINKER', SL: 'SLIDER', CU: 'CURVEBALL', CH: 'CHANGEUP', FC: 'CUTTER', KC: 'KNUCKLE CURVE', FS: 'SPLITTER' };
const pitchName = (t: string) => PITCH_NAMES[t.toUpperCase()] ?? t.toUpperCase();

function describe(e: GameEvent, s: GameState): string {
  switch (e.type) {
    case 'pitch':
      return `${s.pitcher?.name ?? 'Pitcher'} delivers a ${pitchName(e.pitchType).toLowerCase()}, ${Math.round(e.speed * MPS_TO_MPH)} mph.`;
    case 'contact':
      return `${s.batter?.name ?? 'Batter'} puts it in play — ${Math.round(e.exitVelo * MPS_TO_MPH)} mph off the bat.`;
    case 'ball':
      return 'Ball.';
    case 'strike':
      return 'Strike.';
    case 'foul':
      return 'Foul ball.';
    case 'out':
    case 'run':
      return e.text ?? (e.type === 'out' ? 'Out.' : 'Run scores.');
    case 'play':
      return e.text;
    case 'throw':
      return 'Throw!';
    default:
      return '';
  }
}
