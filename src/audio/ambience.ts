/**
 * The continuous crowd bed, by section of the stands. Each zone (`venue/mics.ts`: behind home, the home side, the third-base line, the
 * visitors' first-base side, the bleachers, the upper deck) has its own murmur and roar loops (the shared loop buffers started at
 * different offsets, so the sections are decorrelated) and, in the infield sections, the applause loop; its level follows the crowd
 * model's level for that zone (`crowd.ts`: home and visiting fans react to different things) and its brightness the model's cut-off.
 * Each zone is wired once to the two mics that hear its seats best (a delay and a gain each): the section's own crowd mic close and early,
 * another further away, later and darker. Phones get four zones.
 *
 * Nothing here runs per frame except `apply` (~10 times a second: a handful of gain and filter targets).
 */
import type { Mixer } from './mixer';
import type { CrowdBed } from './crowd';
import { LOW_FOLD, LOW_ZONES, ZONES, type Zone, type ZoneId } from './venue/mics';

interface ZoneBed {
  zone: Zone;
  murmur: GainNode;
  roar: GainNode;
  clap: GainNode | null;
  lp: BiquadFilterNode;
  out: GainNode;
  /** the full zones folded into this one (phones) */
  covers: ZoneId[];
}

/** zones that carry the applause loop (the infield sections, where the clapping is loudest) */
const CLAP_ZONES = new Set<ZoneId>(['backstop', 'home_side', 'line_3b']);

export class Ambience {
  private sources: AudioBufferSourceNode[] = [];
  private beds: ZoneBed[] = [];
  private nodes: AudioNode[] = [];
  started = false;
  /** last applied gains (debug): the bowl's, and per zone */
  gains = { murmur: 0, roar: 0, clap: 0 };
  zoneGains: Partial<Record<ZoneId, number>> = {};

  constructor(private mixer: Mixer) {}

  /** Start the loops once their buffers exist. Safe to call repeatedly. */
  start(): boolean {
    const ctx = this.mixer.ctx;
    const graph = this.mixer.graph;
    if (this.started || !ctx || !graph || !this.mixer.ready || ctx.state !== 'running') return this.started;
    const bm = this.mixer.buffers.get('loop:murmur')?.[0];
    const br = this.mixer.buffers.get('loop:roar')?.[0];
    const bc = this.mixer.buffers.get('loop:claps')?.[0];
    if (!bm || !br) return false;
    const low = this.mixer.lowPower;
    const ids = low ? LOW_ZONES : ZONES.map((z) => z.id);
    const total = Math.sqrt(ids.reduce((a, id) => a + Math.pow(ZONES.find((z) => z.id === id)!.size, 2), 0));
    ids.forEach((id, i) => {
      const zone = ZONES.find((z) => z.id === id)!;
      const loop = (buf: AudioBuffer, offset: number, dest: AudioNode) => {
        const g = ctx.createGain();
        g.gain.value = 0;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        src.connect(g).connect(dest);
        src.start(0, offset % Math.max(0.1, buf.duration)); // decorrelate the sections
        this.sources.push(src);
        this.nodes.push(g);
        return g;
      };
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2400;
      lp.channelCount = 1;
      lp.channelCountMode = 'explicit';
      const out = ctx.createGain();
      out.gain.value = 0;
      lp.connect(out);
      const murmur = loop(bm, 0.37 + i * 1.91, lp);
      const roar = loop(br, 2.5 + i * 1.33, lp);
      const clap = bc && (CLAP_ZONES.has(id) || (low && id === 'home_side')) ? loop(bc, 1.7 + i * 0.77, lp) : null;
      graph.wireContinuous(out, zone.pos, zone.size / total, low ? 1 : 2);
      this.nodes.push(lp, out);
      const covers = low ? ZONES.filter((z) => (z.id === id ? true : LOW_FOLD[z.id] === id)).map((z) => z.id) : [id];
      this.beds.push({ zone, murmur, roar, clap, lp, out, covers });
    });
    this.started = true;
    return true;
  }

  /** apply the model's bed (call ~10 times a second) */
  apply(bed: CrowdBed) {
    const ctx = this.mixer.ctx;
    if (!this.started || !ctx) return;
    const t = ctx.currentTime;
    this.gains = { murmur: bed.murmur, roar: bed.roar, clap: bed.clap };
    const level = this.mixer.crowdLevel();
    for (const b of this.beds) {
      // the zone's own level against the bowl's: its roar follows its fans, the murmur is everybody
      const zl = b.covers.reduce((a, id) => a + (bed.zones?.[id] ?? bed.level), 0) / b.covers.length;
      const roar = Math.pow(zl, 1.6) * 1.25;
      this.zoneGains[b.zone.id] = +roar.toFixed(3);
      b.murmur.gain.setTargetAtTime(bed.murmur, t, 0.35);
      b.roar.gain.setTargetAtTime(roar, t, 0.3);
      b.clap?.gain.setTargetAtTime(bed.clap * (b.clap && this.mixer.lowPower ? 1.6 : 1), t, 0.3);
      b.lp.frequency.setTargetAtTime(bed.cutoff * (0.75 + 0.25 * Math.min(1, zl / Math.max(0.05, bed.level))), t, 0.4);
      b.out.gain.setTargetAtTime(level, t, 0.25);
    }
  }

  stop() {
    for (const s of this.sources) {
      try {
        s.stop();
        s.disconnect();
      } catch {
        /* ignore */
      }
    }
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.sources = [];
    this.nodes = [];
    this.beds = [];
    this.started = false;
  }
}

