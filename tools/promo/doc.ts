/**
 * The shot list and the cut list in docs/promo.md, generated from shots.ts and edit.ts (so the doc cannot drift from what is rendered):
 *
 *   npx tsx tools/promo/doc.ts            prints the tables
 *   npx tsx tools/promo/doc.ts --write    replaces the part of docs/promo.md between the <!-- promo:shots --> markers
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../perf/lib';
import type { CamKey, PointSpec } from '../../src/promo/cameraPath';
import { BEAT, BPM, CUTS, VOICE, cutTimes } from './edit';
import { SHOTS } from './shots';

const pt = (p: PointSpec): string => {
  if (Array.isArray(p)) return `(${p.join(', ')})`;
  if ('orbit' in p) return `orbit r ${p.r} h ${p.h} at ${p.deg} deg round ${pt(p.orbit)}`;
  return `${p.at}${p.off && p.off.some((v) => v) ? ` + (${p.off.join(', ')})` : ''}`;
};
const cam = (s: (typeof SHOTS)[number]): string => {
  if (s.camera.mode === 'director') return `the broadcast director${s.hud ? ' + HUD' : ''}${s.camera.replays ? ', replays' : ''}${s.camera.broll ? ', B-roll' : ''}`;
  const k = s.camera.keys as CamKey[];
  const a = k[0], b = k[k.length - 1];
  const lens = a.fov === b.fov ? `${a.fov} deg` : `${a.fov} -> ${b.fov} deg`;
  return `path (${s.camera.keysIn ?? 'out'} time): ${pt(a.pos)} -> ${pt(b.pos)}, looking at ${pt(a.look)}, ${lens}${a.aperture ? `, aperture ${a.aperture}` : ''}`;
};
const ramp = (s: (typeof SHOTS)[number]) => (s.ramp ? `min x${Math.min(...s.ramp.map((r) => r.speed))}${s.simDt ? `, sim at 1/${Math.round(1 / s.simDt)} s` : ''}` : '');

export function tables(): string {
  const used = new Set(CUTS.map((c) => c.shot));
  const shots = [
    '| shot | seed | tod | sim start | anchor | dur s | camera | slow motion | in the cut | note |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...SHOTS.map((s) => `| ${s.id} | ${s.seed} | ${s.tod} | ${s.start.toFixed(2)} | ${s.anchor.toFixed(2)} | ${s.dur} | ${cam(s)} | ${ramp(s)} | ${used.has(s.id) ? 'yes' : 'no'} | ${s.note ?? ''} |`),
  ];
  const { starts } = cutTimes();
  const cuts = [
    '| # | time s | beats | shot | from | park / booth dB |',
    '|---|---|---|---|---|---|',
    ...CUTS.map((c, i) => `| ${i + 1} | ${starts[i].toFixed(1)} | ${c.beats} | ${c.black ? `(card) ${c.shot}` : c.shot}${c.phone ? ' (in the phone)' : ''} | ${c.anchor ? `first \`${c.anchor.shot}\` + ${c.anchor.offset} s` : `${c.in} s`} | ${c.park ?? '-'} / ${c.booth ?? '-'} |`),
  ];
  const voice = VOICE.map((v) => `- ${v.shot}: the booth line ${v.line.startsWith('event:') ? `after the \`${v.line.slice(6)}\` event` : `"${v.line}"`} lands at ${v.at} s (${v.dur} s of the booth track)`);
  return [`Shots (\`tools/promo/shots.ts\`; the vertical cut re-shoots each as \`v-<id>\` in a portrait viewport with the lens opened up):`, '', ...shots, '', `Cuts (\`tools/promo/edit.ts\`, ${BPM} BPM grid, a beat = ${BEAT} s):`, '', ...cuts, '', 'Booth lines laid over several cuts:', '', ...voice].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const t = tables();
  if (process.argv.includes('--write')) {
    const f = path.join(ROOT, 'docs/promo.md');
    const s = fs.readFileSync(f, 'utf8');
    const a = s.indexOf('<!-- promo:shots -->'), b = s.indexOf('<!-- /promo:shots -->');
    if (a < 0 || b < 0) throw new Error('docs/promo.md has no <!-- promo:shots --> ... <!-- /promo:shots --> block');
    fs.writeFileSync(f, s.slice(0, a) + '<!-- promo:shots -->\n' + t + '\n' + s.slice(b));
    console.log('[doc] docs/promo.md shot list updated');
  } else console.log(t);
}
