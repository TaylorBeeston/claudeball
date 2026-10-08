/**
 * Shared types of the audio layer. Nothing here depends on three.js, the sim or the Web Audio API, so the
 * event -> cue mapping (`cues.ts`) and the commentary (`commentary.ts`) run under plain node in vitest.
 */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * An event in the shape of the sim's own `GameEvent` (`{type, time, ...fields}`), loosely typed on purpose: the sim and
 * engine threads keep adding events and fields, and audio must tolerate whatever it does not know.
 */
export type RawEvent = { type: string; time?: number } & Record<string, unknown>;

/** Sound effects, all synthesised by `synth.ts`. */
export type SfxId =
  | 'bat_crack' // buckets 0..2: weak .. hard
  | 'bat_thud' // dull contact: topped / off the end
  | 'bat_tick' // foul tip
  | 'bunt_tap'
  | 'swing_whoosh'
  | 'pitch_whoosh'
  | 'mitt_pop' // buckets 0..2 by pitch speed
  | 'glove_pop' // buckets 0..1: soft / firm
  | 'ground_bounce' // grass
  | 'dirt_thud' // infield dirt / warning track
  | 'wall_thud'
  | 'fence_rattle'
  | 'seat_thump'
  | 'throw_whip'
  | 'tag_slap'
  | 'tag_miss' // the glove swishes through air (tagAvoided)
  | 'slide_scuff'
  | 'footstep'
  | 'base_thud'
  | 'body_thump'
  | 'firework'
  | 'replay_whoosh'
  | 'pa_click'
  | 'ump_yell' // fallback shout when there is no speech synthesis
  // broadcast stings (broadcastfx.ts): quiet, on their own bus with its own volume
  | 'bfx_whoosh' // a soft swish for a dissolve or a wipe
  | 'bfx_thunk' // a tiny low tick on a hard cut to a close-up
  | 'bfx_replay' // whoosh + a short rising sting into a replay
  | 'bfx_blip' // a graphic (lower third) appearing
  | 'bfx_thump'; // a low thump on a stadium aerial

/** One-shot crowd reactions (stereo, played on the crowd bus, not positional). */
export type CrowdId =
  | 'roar_big'
  | 'roar_med'
  | 'cheer_short'
  | 'applause'
  | 'applause_small'
  | 'groan'
  | 'gasp'
  | 'ooh'
  | 'boo'
  | 'swell'
  | 'whoop'
  // crowd life and finer reactions (crowd.ts)
  | 'clap_single' // one hand-clap, a handful of hands close together
  | 'clap_burst' // one beat of a rhythmic clap (many hands within ~90 ms)
  | 'whistle'
  | 'shout' // a lone "hey!"
  | 'shout2' // a lone "yeah!"
  | 'kid' // a child's squeal
  | 'vendor' // a far-off long call from the aisles (no words)
  | 'chatter' // a pocket of conversation
  | 'chant' // "let's go!" clap clap, three times
  | 'aww' // a soft disappointed "awww"
  | 'oh_relief' // "ohh" falling: the ball is caught
  | 'boo_few'; // a handful of boos

import type { OrganId } from './music';
export type { OrganId };

/** Speech roles: they pick the voice/pitch/rate and the queue priority. */
export type SpeakRole = 'pa' | 'ump' | 'pbp' | 'color';

/** 0 = ambient detail (footsteps, base touches), 1 = normal, 2 = key, 3 = critical. Used to thin cues out at 2x/4x. */
export type Importance = 0 | 1 | 2 | 3;

export type Cue =
  | { kind: 'sfx'; id: SfxId; pos?: Vec3; gain?: number; rate?: number; delay?: number; bucket?: number; imp: Importance }
  | { kind: 'crowd'; id: CrowdId; gain?: number; delay?: number; imp: Importance }
  /** raises the crowd's excitement (0..1) for `hold` seconds; it decays back to the situation's baseline */
  | { kind: 'excite'; amount: number; hold: number; delay?: number; imp: Importance }
  | { kind: 'organ'; id: OrganId; gain?: number; delay?: number; imp: Importance }
  /** `pos`: where the speaker stands (the umpire), used by the synthesised fallback shout */
  | { kind: 'speak'; role: SpeakRole; text: string; pri: number; ttl: number; delay?: number; imp: Importance; pos?: Vec3 };

/** What the mapper needs to know about the game at the moment of an event (built from the live snapshot). */
export interface MapCtx {
  /** position of a player by id (batter, fielder, runner ...) */
  pos(id: unknown): Vec3 | undefined;
  person(id: unknown): { name: string; number?: number; team?: number; role?: string } | undefined;
  inning: number;
  half: 'top' | 'bottom';
  outs: number;
  balls: number;
  strikes: number;
  score: { home: number; away: number };
  runners: [boolean, boolean, boolean];
  teams: { home: string; away: string };
  /** the ballpark's name and the time of day (for the PA's welcome), when known */
  venue?: string;
  tod?: 'day' | 'dusk' | 'night';
  /** catcher's mitt (glove pops for pitches) and the mound, when known */
  catcher?: Vec3;
  /** sim speed multiplier (1, 2, 4) */
  speed: number;
  /** live line of the batter / pitcher, if the sim exposes it */
  batterLine?(id: unknown): { ab: number; h: number; hr: number; rbi: number } | undefined;
  pitcherLine?(id: unknown): { outs: number; so: number; er: number; pitchCount: number } | undefined;
}
