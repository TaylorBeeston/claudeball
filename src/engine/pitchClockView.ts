/**
 * What a pitch-clock display shows (the HUD graphic beside the scorebug and the clocks in the park), from the sim's `pitchClock` snapshot: the seconds, a
 * colour level, the disengagement pips, a label, and whether a violation is being flashed. Pure (no DOM / three.js): the HUD and the stadium displays
 * redraw only when `key` changes, which is at most once a second (plus the level and flash changes).
 */
import type { GameState, PitchClockView } from './types';

export interface ClockDisplay {
  visible: boolean;
  /** the digits ("15", "8", "0"; "2:05" for the long clocks) */
  text: string;
  /** normal; amber under 10 s; red under 5 s (pitch / between batters only) */
  level: 'normal' | 'amber' | 'red';
  label: 'PITCH' | 'BATTER' | 'BREAK' | 'CHANGE' | 'TIME';
  /** disengagements left as two pips (only with a runner on base) */
  pips: [boolean, boolean] | null;
  /** a violation was just called: flash the clock */
  flash: boolean;
  /** changes whenever anything above changes: redraw only then */
  key: string;
}

/** How long a violation flashes (s of game time). */
export const VIOLATION_FLASH = 3;

const LABEL: Record<PitchClockView['kind'], ClockDisplay['label']> = { pitch: 'PITCH', betweenBatters: 'BATTER', break: 'BREAK', pitchingChange: 'CHANGE', timeout: 'TIME' };

/** Seconds the way a stadium clock shows them: whole seconds, rounded up (it reads 1 until it hits 0); m:ss from a minute up. */
export function clockText(sec: number): string {
  const s = Math.max(0, Math.ceil(sec - 1e-6));
  if (s < 60) return String(s);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function clockDisplay(s: Pick<GameState, 'pitchClock' | 'phase' | 'time' | 'runners'>): ClockDisplay {
  const c = s.pitchClock;
  if (!c) return { visible: false, text: '', level: 'normal', label: 'PITCH', pips: null, flash: false, key: 'off' };
  const pitchKind = c.kind === 'pitch' || c.kind === 'betweenBatters';
  const flash = !!c.violation && s.time - c.violation.time >= 0 && s.time - c.violation.time < VIOLATION_FLASH;
  // shown while it counts, while it is paused for time, and between pitches; hidden while the ball is live
  const live = s.phase === 'windup' || s.phase === 'pitch' || s.phase === 'inPlay';
  const visible = flash || (!live && (c.running || c.kind === 'timeout' || s.phase === 'prePitch'));
  const rem = c.remainingSec;
  const level: ClockDisplay['level'] = !pitchKind ? 'normal' : rem <= 5 ? 'red' : rem <= 10 ? 'amber' : 'normal';
  const text = flash ? '0' : c.kind === 'timeout' ? clockText(c.limitSec) : clockText(rem);
  const runnersOn = s.runners.some(Boolean);
  const pips: ClockDisplay['pips'] = c.kind === 'pitch' && runnersOn ? [c.disengagementsLeft >= 1, c.disengagementsLeft >= 2] : null;
  const label = LABEL[c.kind];
  const key = `${visible ? 1 : 0}|${text}|${level}|${label}|${pips ? pips.join(',') : '-'}|${flash ? 1 : 0}`;
  return { visible, text, level, label, pips, flash, key };
}

/** The caption the HUD shows for a violation. */
export function violationCaption(v: NonNullable<PitchClockView['violation']>): string {
  return v.on === 'pitcher' ? 'PITCH CLOCK VIOLATION · AUTOMATIC BALL' : 'PITCH CLOCK VIOLATION · AUTOMATIC STRIKE';
}
