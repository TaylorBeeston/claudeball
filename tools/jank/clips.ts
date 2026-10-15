/** What the validator needs to know about a clip by name (shared by the Node sweeps and the in-page game probe). */
export const LOCOMOTION = new Set(['manager_walk', 'walk', 'trot', 'jog', 'run', 'run_sprint', 'run_turn', 'run_turn_sprint']);
export const AIRBORNE = /^(slide|dive|catch_jump|pop_up|celebrate|bench_sit|ballkid_sit|bench_cheer|coach_slide)/;
export const BALLISTIC = /^(pitch($|_)|windup|warmup_pitch|bullpen_throw|pickoff|throw|catch_throw|toss|swing|batter_practice_swing|ondeck_swing|roll_ball|ballkid_toss|pitcher_catch_toss)/;
/** clips played with a bat in the hands (on Bat_Grip) and which hands should be on it */
export const BAT_CLIPS: Record<string, { L: boolean; R: boolean }> = {
  batting_stance: { L: true, R: true },
  swing: { L: true, R: true },
  batter_practice_swing: { L: true, R: true },
  batter_adjust: { L: false, R: true },
  batter_step_in: { L: false, R: true },
  batter_step_out: { L: false, R: true },
  ondeck_ready: { L: false, R: true },
  ondeck_stretch: { L: false, R: true },
  ondeck_swing: { L: true, R: true },
};

export function clipFlags(name: string) {
  return { locomotion: LOCOMOTION.has(name), airborne: AIRBORNE.test(name), ballistic: BALLISTIC.test(name) };
}
