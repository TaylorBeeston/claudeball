/** Delivery styles the user records in. `speaker` (see STYLE_SPEAKER) is the multi-speaker id the trained model uses for the style. */
export type Style = 'calm' | 'building' | 'excited' | 'peak' | 'deadpan' | 'crisp' | 'deflated';

export const STYLES: Style[] = ['calm', 'building', 'excited', 'peak', 'deadpan', 'crisp', 'deflated'];

/**
 * One multi-speaker model, three "characters" that share the voice but differ in energy:
 * 0 = play-by-play (calm / building / crisp PA+umpire / deflated), 1 = hype (excited / peak), 2 = color commentary (deadpan).
 */
export const STYLE_SPEAKER: Record<Style, number> = { calm: 0, building: 0, crisp: 0, deflated: 0, excited: 1, peak: 1, deadpan: 2 };
export const SPEAKER_NAMES = ['playbyplay', 'hype', 'color'];

/** Words per second, from broadcast pace (~150-170 wpm for calm, slower when vowels are stretched). Used for the duration estimate. */
export const STYLE_WPS: Record<Style, number> = { calm: 2.4, building: 2.5, excited: 2.2, peak: 1.8, deadpan: 2.3, crisp: 2.1, deflated: 2.0 };
/** Extra seconds per line (leading/trailing silence kept in the file, breaths, held vowels). */
export const LINE_PAD_S = 0.9;

export type Tier = 'pilot' | 'core' | 'extended';
export type Kind = 'umpire' | 'pa' | 'playbyplay' | 'situation' | 'color' | 'stat' | 'chatter' | 'sentence' | 'name' | 'number' | 'team';

export interface ScriptLine {
  id: string;
  /** What the game would write (digits and all). */
  text: string;
  /** What to say out loud and what the TTS model is trained on (`normalizeForSpeech(text)`). */
  normalized: string;
  style: Style;
  speaker: number;
  /** One-line cadence direction for the recording. */
  direction: string;
  /** Recording session id, e.g. `P1`, `C3`, `E2`. */
  session: string;
  /** 1 = pilot, 2 = core, 3 = extended. */
  priority: 1 | 2 | 3;
  tier: Tier;
  kind: Kind;
  /** Template id this line was expanded from (or the list it was drawn from). */
  source: string;
  /** Estimated spoken duration in seconds, including padding. */
  estSeconds: number;
}

/** Hand-written template. `n` = [pilot, core, extended] instance counts. `text` variants are cycled through, slots are `{pool}`. */
export interface Template {
  id: string;
  kind: Kind;
  style: Style;
  direction: string;
  n: [number, number, number];
  text: string | string[];
}
