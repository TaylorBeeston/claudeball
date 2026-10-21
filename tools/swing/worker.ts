/**
 * One shard of tools/swing/run.ts: games [from, to) of a `npm run sim -- N seed` set (the same teams and game seeds as scripts/simulate.ts), the
 * league counters simulate.ts prints, and every swing's bat replayed from its plan (BatSwing draws no random numbers, so the copy leaves the
 * game untouched) and measured: world angles, the swing plane at contact, and whether two hands can hold it on the drawn body (hold.ts).
 *   npx tsx tools/swing/worker.ts --root <tree> --seed 7 --from 0 --to 10 --out shard.json [--every 1]
 */
import fs from 'node:fs';
import path from 'node:path';
import { Holder, type V3 } from './hold';
import { swingFrames } from './frames';
import { Hist, type Phase, splitKeys } from './agg';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const ROOT = path.resolve(opt('root', '.'));
const SEED = opt('seed', '7');
const FROM = +opt('from', '0'), TO = +opt('to', '1'), EVERY = +opt('every', '1');
const HERE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

const phaseOf = (u: number): Phase => (u < 0.4 ? 'launch' : u < 0.85 ? 'mid' : u <= 1.15 ? 'contact' : 'follow');
const DEG = 180 / Math.PI;
const wEl = (k: V3, t: V3) => Math.asin(Math.max(-1, Math.min(1, (t.y - k.y) / Math.hypot(t.x - k.x, t.y - k.y, t.z - k.z)))) * DEG;
const wAz = (k: V3, t: V3, sg: number) => Math.atan2(sg * (t.x - k.x), t.z - k.z) * DEG; // mirrored for lefties: one convention for both sides

interface SwingRec {
  g: number;
  stance: 'L' | 'R';
  h: number;
  px: number;
  py: number;
  plan: any;
  res?: string;
  contact?: { tau: number; ev: number; la: number; spray: number; ballY: number };
}

async function main() {
  const { createGame } = await import(path.join(ROOT, 'src/sim/game.ts'));
  const { generateTeam } = await import(path.join(ROOT, 'src/sim/roster.ts'));
  const { BatSwing, SWING } = await import(path.join(ROOT, 'src/sim/batting.ts'));
  // --swing '{"timeErr": 1.3}': try a variant of the swing's shape (src/sim/batting.ts SWING) without editing it
  const deep = (o: any, v: any) => { for (const k of Object.keys(v)) if (v[k] && typeof v[k] === 'object') deep(o[k], v[k]); else o[k] = v[k]; };
  if (opt('swing', '')) deep(SWING, JSON.parse(opt('swing', '{}')));
  const holder = new Holder();
  await holder.init(HERE);

  const bat: Record<string, number> = { pa: 0, ab: 0, h: 0, doubles: 0, triples: 0, hr: 0, bb: 0, so: 0, hbp: 0, rbi: 0, r: 0, sb: 0, cs: 0, sf: 0, sh: 0 };
  const pit: Record<string, number> = { outs: 0, bf: 0, h: 0, r: 0, er: 0, bb: 0, so: 0, hr: 0, hbp: 0, pitches: 0, strikes: 0, wp: 0 };
  const L = { runs: 0, innings: 0, extra: 0, games: 0, swings: 0, fairFB: 0, fairFBhr: 0, zoneP: 0, oP: 0, zSw: 0, oSw: 0, sbAtt: 0 };
  const calls: Record<string, number> = {};
  const contacts: { ev: number; la: number; spray: number; spin: number; res?: string }[] = [];
  const recs: SwingRec[] = [];

  for (let i = FROM; i < TO; i++) {
    const home = generateTeam(`${SEED}-h${i}`, { side: 'home' });
    const away = generateTeam(`${SEED}-a${i}`, { side: 'away' });
    const g = createGame({ seed: `${SEED}-g${i}`, homeTeam: home, awayTeam: away, pace: 0, tempo: 'quick' });
    const w = g._world;
    let cur: { z: boolean } | null = null;
    let lastLA = 0, hadContact = false;
    let lastContact: (typeof contacts)[number] | null = null;
    let sw: SwingRec | null = null;
    g.on('pitchReleased', () => {
      cur = { z: w.pitch!.inZone };
      if (cur.z) L.zoneP++;
      else L.oP++;
      hadContact = false;
      sw = null;
    });
    g.on('swing', () => {
      L.swings++;
      if (cur) {
        if (cur.z) L.zSw++;
        else L.oSw++;
      }
      const plan = w.swingPlan;
      if (!plan || plan.bunt) return;
      sw = { g: i, stance: w.batStance, h: w.batter.info.height ?? 1.85, px: w.pitch.plateX, py: w.pitch.plateY, plan: JSON.parse(JSON.stringify(plan)) };
      recs.push(sw);
    });
    g.on('contact', (e: any) => {
      lastContact = { ev: e.exitMph, la: e.launchDeg, spray: e.sprayDeg, spin: e.spinRpm };
      contacts.push(lastContact);
      lastLA = e.launchDeg;
      hadContact = true;
      if (sw && w.swing) sw.contact = { tau: w.swing.tau, ev: e.exitMph, la: e.launchDeg, spray: e.sprayDeg, ballY: e.pos.y };
    });
    g.on('call', (e: any) => {
      calls[e.call.kind] = (calls[e.call.kind] ?? 0) + 1;
      if (sw && e.call.kind === 'strikeSwinging') sw.res = 'whiff';
      if (sw && e.call.kind === 'foul') sw.res = 'foul';
    });
    g.on('plateAppearanceEnd', (e: any) => {
      if (hadContact && lastLA >= 20 && lastLA <= 50 && !['strikeout', 'walk'].includes(e.result)) {
        L.fairFB++;
        if (e.result === 'home run') L.fairFBhr++;
      }
      if (hadContact && lastContact) lastContact.res = e.result;
      hadContact = false;
    });
    g.on('steal', () => L.sbAtt++);
    g.simulateToEnd(6 * 3600);
    const box = g.getBoxScore();
    L.runs += box.home.runs + box.away.runs;
    L.innings += w.inning;
    if (w.inning > 9) L.extra++;
    L.games++;
    for (const t of [box.home, box.away]) {
      for (const b of t.batters) for (const k of Object.keys(bat)) bat[k] += b.line[k];
      for (const p of t.pitchers) for (const k of Object.keys(pit)) pit[k] += p.line[k];
    }
  }

  // ---- the swings: replay each plan with the game's sub-step, sample at 60 Hz (the frames) + the marks + the contact instant
  const H = new Hist();
  const DT = 1 / 1920;
  const atContact: Record<string, number>[] = [];
  let ri = 0;
  for (const r of recs) {
    if (ri++ % EVERY) continue;
    const plan = r.plan;
    const tauC: number = plan.tauC;
    const sg = r.stance === 'R' ? 1 : -1;
    const bs = new BatSwing(plan);
    const split = splitKeys(r.stance, r.py, r.h);
    const tEnd = tauC * 2.1;
    const markT: Record<string, number> = { t0: 0, half: tauC / 2, 'c-60ms': tauC - 0.06, contact: tauC, '1.5c': 1.5 * tauC, '2.1c': tEnd };
    const want = Object.entries(markT).sort((a, b) => a[1] - b[1]);
    for (const [m, tm] of want) {
      while (bs.tau < tm - 1e-9 && !bs.done) bs.advance(Math.min(DT, tm - bs.tau));
      const pose = bs.pose();
      const el = wEl(pose.knob, pose.tip), az = wAz(pose.knob, pose.tip, sg);
      H.add(`mark:${m}:wel`, el);
      H.add(`mark:${m}:waz`, az);
      H.add(`mark:${m}:tipY`, pose.tip.y * 100);
      H.add(`mark:${m}:knobY`, pose.knob.y * 100);
      if (m === 'contact') {
        const vs = pose.velAt(0.66);
        const vk = pose.velAt(0);
        const d = pose.dir;
        // swing plane: the bat line and the sweet spot's velocity
        const nx = d.y * vs.z - d.z * vs.y, ny = d.z * vs.x - d.x * vs.z, nz = d.x * vs.y - d.y * vs.x;
        const tilt = Math.acos(Math.min(1, Math.abs(ny) / Math.hypot(nx, ny, nz))) * DEG;
        const sp = Math.hypot(vs.x, vs.y, vs.z);
        atContact.push({ vba: el, attack: Math.asin(vs.y / sp) * DEG, tilt, sweet: sp, hands: Math.hypot(vk.x, vk.y, vk.z), knobY: pose.knob.y, py: r.py, px: sg * r.px, hit: r.contact ? 1 : 0, ev: r.contact?.ev ?? NaN, la: r.contact?.la ?? NaN });
      }
    }
    swingFrames(holder, new BatSwing(plan), r.stance, r.h, (f) => {
      const ph: Phase = f.finish ? 'finish' : phaseOf(f.tau / tauC);
      H.phase(ph, split, f.s, wEl(f.knob, f.tip), wAz(f.knob, f.tip, sg), f.tip.y, { g: r.g, tau: +f.tau.toFixed(4), stance: r.stance, px: +r.px.toFixed(3), py: +r.py.toFixed(3), h: r.h, t: +f.t.toFixed(3) });
    });
  }
  fs.writeFileSync(opt('out', 'shard.json'), JSON.stringify({ bat, pit, L, calls, contacts, hist: H.toJSON(), atContact, nSwings: recs.length }));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
