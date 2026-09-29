/**
 * Pure helpers behind the HUD's ratings bars, stat lines and box score (no DOM), so they can be unit-tested.
 * Ratings are on the 20-80 scouting scale (50 = average, 80 = elite); fastball velocity is in mph and is mapped onto the same scale.
 */
import type { StatsBat, StatsEntry, StatsPit, TeamStatsView } from './types';

export interface RatingBar {
  label: string;
  /** 20..80 */
  grade: number;
  /** 0..1 fill */
  fill: number;
  /** optional raw display, e.g. "96 mph" */
  text?: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export const gradeFill = (g: number) => clamp((g - 20) / 60, 0, 1);

/** 84 mph → 20, 100 mph → 80 (linear, clamped). */
export const velocityGrade = (mph: number) => clamp(20 + ((mph - 84) / 16) * 60, 20, 80);

export function gradeColor(g: number): string {
  if (g >= 70) return '#39d98a';
  if (g >= 60) return '#8ddc5a';
  if (g >= 50) return '#e6d34a';
  if (g >= 40) return '#f0a03c';
  return '#e8584a';
}

export function batterBars(r: Record<string, number> | undefined): RatingBar[] {
  if (!r) return [];
  const bar = (label: string, key: string): RatingBar => ({ label, grade: Math.round(r[key] ?? 50), fill: gradeFill(r[key] ?? 50) });
  return [bar('POWER', 'power'), bar('CONTACT', 'contact'), bar('SPEED', 'speed'), bar('EYE', 'eye')];
}

export function pitcherBars(r: Record<string, number> | undefined): RatingBar[] {
  if (!r) return [];
  const v = r.velocity ?? 90;
  const bar = (label: string, key: string): RatingBar => ({ label, grade: Math.round(r[key] ?? 50), fill: gradeFill(r[key] ?? 50) });
  return [
    { label: 'VELOCITY', grade: Math.round(velocityGrade(v)), fill: gradeFill(velocityGrade(v)), text: `${Math.round(v)}` },
    bar('CONTROL', 'control'),
    bar('MOVEMENT', 'movement'),
    bar('STAMINA', 'stamina'),
  ];
}

const PITCH_SHORT: Record<string, string> = { FF: '4-SEAM', FT: '2-SEAM', SI: 'SINKER', FC: 'CUTTER', SL: 'SLIDER', SW: 'SWEEPER', CU: 'CURVE', CH: 'CHANGE', FS: 'SPLIT' };
export const pitchShort = (t: string) => PITCH_SHORT[t] ?? t;

/** "4-SEAM 96 · SLIDER 87 · CHANGE 88" */
export function arsenalText(a: { type: string; mph: number }[] | undefined): string {
  return (a ?? []).map((p) => `${pitchShort(p.type)} ${Math.round(p.mph)}`).join('  ·  ');
}

export function batLine(b: StatsBat | undefined): string {
  if (!b) return '';
  const parts = [`${b.h}-${b.ab}`];
  if (b.hr) parts.push(`${b.hr} HR`);
  if (b.rbi) parts.push(`${b.rbi} RBI`);
  if (b.bb) parts.push(`${b.bb} BB`);
  if (b.so) parts.push(`${b.so} K`);
  return parts.join('  ');
}

export function pitLine(p: StatsPit | null | undefined): string {
  if (!p) return '';
  return `${p.ip} IP  ${p.so} K  ${p.bb} BB  ${p.er} ER  ${p.pitches} P`;
}

export const rate = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? '---' : v >= 1 ? v.toFixed(3) : v.toFixed(3).replace(/^0/, ''));

export interface BoxBatterRow { num: number; name: string; pos: string; ab: number; r: number; h: number; rbi: number; bb: number; so: number; hr: number; avg: string; inGame: boolean }
export interface BoxPitcherRow { num: number; name: string; ip: string; h: number; r: number; er: number; bb: number; so: number; hr: number; pitches: number; era: string }

export function boxBatters(t: TeamStatsView | undefined): BoxBatterRow[] {
  return (t?.batters ?? []).map((e: StatsEntry) => {
    const g = e.game.batting;
    return { num: e.jersey, name: e.name, pos: e.position, ab: g.ab, r: g.r, h: g.h, rbi: g.rbi, bb: g.bb, so: g.so, hr: g.hr, avg: rate(e.season.batting.ab ? e.season.batting.avg : undefined), inGame: e.inGame };
  });
}

export function boxPitchers(t: TeamStatsView | undefined): BoxPitcherRow[] {
  return (t?.pitchers ?? [])
    .filter((e) => e.game.pitching)
    .map((e) => {
      const p = e.game.pitching!;
      const s = e.season.pitching;
      return { num: e.jersey, name: e.name, ip: p.ip, h: p.h, r: p.r, er: p.er, bb: p.bb, so: p.so, hr: p.hr, pitches: p.pitches, era: s && Number.isFinite(s.era) ? s.era.toFixed(2) : '--' };
    });
}

export function batterTotals(rows: BoxBatterRow[]) {
  return rows.reduce((a, r) => ({ ab: a.ab + r.ab, r: a.r + r.r, h: a.h + r.h, rbi: a.rbi + r.rbi, bb: a.bb + r.bb, so: a.so + r.so, hr: a.hr + r.hr }), { ab: 0, r: 0, h: 0, rbi: 0, bb: 0, so: 0, hr: 0 });
}

export function pitcherTotals(rows: BoxPitcherRow[]) {
  let outs = 0;
  for (const r of rows) {
    const [w, f] = r.ip.split('.');
    outs += Number(w) * 3 + Number(f ?? 0);
  }
  const t = rows.reduce((a, r) => ({ h: a.h + r.h, r: a.r + r.r, er: a.er + r.er, bb: a.bb + r.bb, so: a.so + r.so, hr: a.hr + r.hr, pitches: a.pitches + r.pitches }), { h: 0, r: 0, er: 0, bb: 0, so: 0, hr: 0, pitches: 0 });
  return { ...t, ip: `${Math.floor(outs / 3)}.${outs % 3}` };
}
