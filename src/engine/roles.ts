import type { PlayerRole } from './types';

/** the nine on the field plus the batter's and runners' side: roles that take part in the play */
const FIELD_ROLES = new Set<PlayerRole>(['pitcher', 'catcher', 'first', 'second', 'third', 'short', 'left', 'center', 'right']);

export const isFielderRole = (r: PlayerRole | string): boolean => FIELD_ROLES.has(r as PlayerRole);

/** people around the field who are not in the play (benches, on deck, coaches, ball kids, the bat boy): never a camera subject for a play */
const SIDE_ROLES = new Set<string>(['bench', 'manager', 'pitchcoach', 'ondeck', 'coach', 'coach1b', 'coach3b', 'ballkid', 'batboy']);
export const isSideRole = (r: PlayerRole | string): boolean => SIDE_ROLES.has(r);
