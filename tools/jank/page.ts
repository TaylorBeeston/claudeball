/**
 * In-page side of the jank detector (bundled to an IIFE by run.ts and injected into the real game). It reaches into the engine's puppets at
 * runtime (private fields included: this is a harness, not game code):
 *
 * - `__jank.install()`: hooks `engine.tick` and every puppet's mixer. After each tick it validates each fully updated puppet's FINAL pose (after
 *   look-at, bat IK, reach IK, elbow clearance) and the pose the mixer alone produced that frame, and attributes each violation:
 *     clip      the mixer's pose with one clip playing already breaks it
 *     blend     the mixer's pose breaks it while two clips cross-fade
 *     override  only the final pose breaks it: a runtime override (look-at / IK) caused it
 *   Every clip switch is logged (from, to, from-time, to-time, fade) for the crossfade sweep.
 * - `__jank.run(frames)`: steps the game `frames` x 1/60 s without rendering (engine.tick(dt, false)).
 * - `__jank.studio(snapshot, view)`: poses a stand-in puppet from a snapshot in front of a near-orthographic camera for the contact sheets.
 */
import { B, BONES, NB, type PoseLocals, newLocals, fk } from '../../src/engine/pose/skeleton';
import { groundHeight } from '../../src/sim/field';
import { Agg, type Snapshot } from './agg';
import { BAT_CLIPS, batHandsBlend, clipFlags } from './clips';
import { gripBat, newTrack, rigInfo, validateFrame, type BatIn, type RigInfo, type Track, type Violation } from './validate';

/* eslint-disable @typescript-eslint/no-explicit-any */
const w = window as any;

interface PState {
  pu: any;
  info: RigInfo;
  L: PoseLocals;
  C: PoseLocals;
  trF: Track;
  trC: Track;
  hips: any;
  bones: any[];
  last: number;
  pos: [number, number, number];
  ring: Snapshot[];
  det: number;
  yaw: number;
}

const ground = (x: number, z: number) => groundHeight(x, z);

function restOf(tplScene: any, M: any, Q: any, V: any): { L: PoseLocals; batGrip: { q: number[]; t: number[] } } {
  const L = newLocals();
  tplScene.updateMatrixWorld(true);
  const inv = new M().copy(tplScene.matrixWorld).invert();
  let hips: any = null, grip: any = null;
  tplScene.traverse((o: any) => {
    if (o.isBone) {
      const i = (BONES as readonly string[]).indexOf(o.name.replace('mixamorig', '').replace(':', ''));
      if (i < 0) return;
      L.lq.set([o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w], i * 4);
      L.lp.set([o.position.x, o.position.y, o.position.z], i * 3);
      if (i === B.Hips) hips = o;
    }
    if (o.name === 'Bat_Grip') grip = o;
  });
  const m = new M().multiplyMatrices(inv, hips.parent.matrixWorld);
  const p = new V(), q = new Q(), s = new V();
  m.decompose(p, q, s);
  L.base.set([q.x, q.y, q.z, q.w, p.x, p.y, p.z, s.x]);
  return { L, batGrip: { q: [grip.quaternion.x, grip.quaternion.y, grip.quaternion.z, grip.quaternion.w], t: [grip.position.x, grip.position.y, grip.position.z] } };
}

function readLocals(bones: any[], L: PoseLocals) {
  for (let i = 0; i < NB; i++) {
    const b = bones[i];
    L.lq[i * 4] = b.quaternion.x;
    L.lq[i * 4 + 1] = b.quaternion.y;
    L.lq[i * 4 + 2] = b.quaternion.z;
    L.lq[i * 4 + 3] = b.quaternion.w;
    L.lp[i * 3] = b.position.x;
    L.lp[i * 3 + 1] = b.position.y;
    L.lp[i * 3 + 2] = b.position.z;
  }
}

const r5 = (x: number) => +x.toFixed(5);
function snapOf(L: PoseLocals, model: ArrayLike<number>, bat: BatIn | null, ctx: Record<string, unknown>): Snapshot {
  return { lq: Array.from(L.lq, r5), lp: Array.from(L.lp, (x) => +x.toFixed(4)), base: Array.from(L.base), model: Array.from(model, r5), bat: bat ? { knob: bat.knob.map(r5), tip: bat.tip.map(r5) } : null, ctx };
}

export function install(opts: { ring?: number; seed?: number } = {}) {
  const e = w.engine;
  const V = e.camera.position.constructor, Q = e.camera.quaternion.constructor, M = e.camera.matrixWorld.constructor;
  const agg = new Agg();
  const per = new Map<string, PState>();
  const restCache = new Map<any, { L: PoseLocals; batGrip: { q: number[]; t: number[] } }>();
  const transitions = new Map<string, { file: string; from: string; to: string; fromT: number; toT: number; fade: number; n: number }>();
  const stats = { fkMismatch: 0, frames: 0, puppetFrames: 0, visibleFrames: 0, ms: 0, attr: { clip: 0, blend: 0, override: 0 } as Record<string, number>, attrSev: { clip: 0, blend: 0, override: 0 } as Record<string, number> };
  const vF: Violation[] = [], vC: Violation[] = [];
  const tmpV = new V();
  const ringN = opts.ring ?? 0;

  const hookPuppet = (id: string, pu: any): PState | null => {
    if (!pu.bones?.Hips || !pu.mixer) return null;
    const tplScene = pu.tpl?.scene;
    let rest = restCache.get(tplScene);
    if (!rest) restCache.set(tplScene, (rest = restOf(tplScene, M, Q, V)));
    const info = rigInfo(rest.L, rest.batGrip);
    const st: PState = { pu, info, L: newLocals(), C: newLocals(), trF: newTrack(), trC: newTrack(), hips: pu.bones.Hips, bones: BONES.map((n) => pu.bones[n]), last: -1, pos: [0, 0, 0], ring: [], det: 0, yaw: 0 };
    st.L.base.set(rest.L.base);
    st.C.base.set(rest.L.base);
    // the mixer's own pose this frame (before look-at / IK)
    const mix = pu.mixer;
    const upd = mix.update.bind(mix);
    mix.update = (dt: number) => {
      const r = upd(dt);
      readLocals(st.bones, st.C);
      return r;
    };
    // every clip switch
    const play = pu.play.bind(pu);
    pu.play = (name: string, snap: any) => {
      const from = pu.currentName, fromT = pu.current?.time ?? 0;
      play(name, snap);
      if (!from || pu.currentName === from) return;
      pu.__jankFrom = from;
      const ip = pu.current?._weightInterpolant?.parameterPositions;
      const fade = ip ? +(ip[1] - ip[0]).toFixed(3) : 0;
      const key = `${tplScene.name || 'tpl'}|${from}|${pu.currentName}`;
      const t = transitions.get(key);
      if (t) t.n++;
      else transitions.set(key, { file: pu.tpl?.name ?? '', from, to: pu.currentName, fromT: +fromT.toFixed(3), toT: +(pu.current?.time ?? 0).toFixed(3), fade, n: 1 });
    };
    return st;
  };

  // the hands on the bat: the clip's, and while it fades in from another clip only those both hold it with
  const handsNow = (pu: any) => (mixerFading(pu.mixer) ? batHandsBlend(pu.__jankFrom, pu.currentName) : BAT_CLIPS[pu.currentName]);
  const batFor = (snap: any, pu: any): BatIn | null => {
    const bat = e.bat;
    const pt = (o: any, y: number) => {
      tmpV.set(0, y, 0);
      o.updateWorldMatrix(true, false);
      return o.localToWorld(tmpV.clone());
    };
    const mk = (o: any, state: BatIn['state'], hands: { L: boolean; R: boolean }): BatIn => {
      const k = pt(o, 0), t = pt(o, 0.86);
      return { state, knob: [k.x, k.y, k.z], tip: [t.x, t.y, t.z], hands };
    };
    if (snap.role === 'batter') {
      if (bat.held && bat.obj.parent === pu.batGrip) return mk(bat.obj, 'held', handsNow(pu) ?? { L: false, R: true });
      // the one-handed finish: the top hand has let go
      if (bat.visible) return mk(bat.obj, 'sim', { L: true, R: !(pu.topRelease > 0.5) });
      return null;
    }
    if (snap.role === 'ondeck' && pu.prop?.visible) return mk(pu.prop, 'ondeck', handsNow(pu) ?? { L: false, R: true });
    return null;
  };

  const probe = (dt: number) => {
    const t0 = performance.now();
    stats.frames++;
    const st = e.liveState;
    const animDt = e.sim.paused ? 0 : dt * Math.min(e.sim.speed, 3);
    const frame = stats.frames;
    for (const p of st.players) {
      const pu = e.players.puppets.get(p.id);
      if (!pu || !pu.root?.visible) continue;
      let s = per.get(p.id);
      // the manager rebuilds a player's puppet now and then (a new template for a new role, a reset): hook the new one
      if (s && s.pu !== pu) {
        per.delete(p.id);
        s = undefined;
      }
      if (!s) {
        const h = hookPuppet(p.id, pu);
        if (!h) continue;
        per.set(p.id, (s = h));
        continue; // hooks take effect from the next frame
      }
      if (pu.offscreen || pu.lod1) {
        s.last = -1;
        continue;
      }
      stats.puppetFrames++;
      readLocals(s.bones, s.L);
      const model = pu.model.matrixWorld.elements;
      const moved = Math.hypot(p.pos.x - s.pos[0], p.pos.z - s.pos[2]);
      const contiguous = s.last === frame - 1;
      // engine-level pops (no clip or IK involved): the body mirrored between frames (left / right-hander switch), the root jumping or spinning
      const det = Math.sign(model[0] * (model[5] * model[10] - model[6] * model[9]) - model[4] * (model[1] * model[10] - model[2] * model[9]) + model[8] * (model[1] * model[6] - model[2] * model[5]));
      const yaw = pu.root.rotation.y as number;
      const pops: Violation[] = [];
      if (contiguous && moved < 1.5) {
        if (det !== s.det) pops.push({ kind: 'pop:mirror', excess: 1, sev: 3 });
        if (moved > 0.25) pops.push({ kind: 'pop:root-jump', excess: moved, sev: Math.min(3, moved / 0.25) });
        let dy = yaw - s.yaw;
        dy -= 2 * Math.PI * Math.round(dy / (2 * Math.PI));
        if (Math.abs(dy) > 0.3) pops.push({ kind: 'pop:root-spin', excess: (Math.abs(dy) * 180) / Math.PI, sev: Math.min(3, Math.abs(dy) / 0.3) });
      }
      s.det = det;
      s.yaw = yaw;
      const cut = !contiguous || moved > 0.25 || pops.length > 0;
      s.last = frame;
      s.pos = [p.pos.x, p.pos.y, p.pos.z];
      const clip = pu.currentName as string;
      // the batter's swing clip held in its finish after the sim's swing ended (the swing clip, but not the swing): its own key, so the swing
      // counts stay comparable with sweeps from before the finish hold
      // (and the stride the batter now takes on every pitch, the swing clip's first part with the bat still in his hands: swing:stride)
      const tag = p.role === 'batter' && clip === 'swing' && p.anim !== 'swing' ? (e.bat.visible ? 'swing:finish' : 'swing:stride') : clip;
      const fl = clipFlags(clip);
      const vel = { x: p.vel.x, z: p.vel.z };
      const bat = batFor(p, pu);
      // feet: the ground under the player (the dugout floor / a seat is where the sim puts him)
      const g0 = groundHeight(p.pos.x, p.pos.z);
      const gnd = Math.abs(p.pos.y - g0) > 0.05 ? (x: number, z: number) => p.pos.y + groundHeight(x, z) - g0 : ground;
      s.info.torso = pu.torso ?? s.info.torso;
      const frameIn = { model, ground: gnd, dt: animDt, cut, vel, ...fl, airborne: fl.airborne || p.anim === 'catch_jump' || /slide|dive/.test(p.anim) };
      const fw = validateFrame({ ...frameIn, L: s.L, bat }, s.info, s.trF, vF);
      vF.push(...pops);
      // integrity: the validator's pose must be the rendered one (the right hand from FK vs the bone's world matrix)
      {
        const h = B.RightHand * 3, me = model, x = fw.wp[h], y = fw.wp[h + 1], z = fw.wp[h + 2], hw = pu.bones.RightHand.matrixWorld.elements;
        if (Math.hypot(me[0] * x + me[4] * y + me[8] * z + me[12] - hw[12], me[1] * x + me[5] * y + me[9] * z + me[13] - hw[13], me[2] * x + me[6] * y + me[10] * z + me[14] - hw[14]) > 0.01) stats.fkMismatch++;
      }
      if (w.__jank.traceId === p.id || w.__jank.traceId === p.role) w.__jank.trace.push({ pe: (() => { pu.rig.refresh(); const V = e.camera.position.constructor; return [pu.rig.pos(pu.bones.LeftForeArm, new V()).toArray().map((x: number) => +x.toFixed(3)), pu.rig.pos(pu.bones.Spine2, new V()).toArray().map((x: number) => +x.toFixed(3))]; })(), fe: [Array.from(fw.wp.subarray(B.LeftForeArm * 3, B.LeftForeArm * 3 + 3)).map((x) => +x.toFixed(3)), Array.from(fw.wp.subarray(B.Spine2 * 3, B.Spine2 * 3 + 3)).map((x) => +x.toFixed(3))], sw: JSON.parse(JSON.stringify(pu.swivelDbg)), ec: pu.elbowClear, fkErr: (() => { const fw = fk(s!.L); const h = B.RightHand * 3; const me = model; const x = fw.wp[h], y = fw.wp[h + 1], z = fw.wp[h + 2]; const wx = me[0] * x + me[4] * y + me[8] * z + me[12], wy = me[1] * x + me[5] * y + me[9] * z + me[13], wz = me[2] * x + me[6] * y + me[10] * z + me[14]; const hw = pu.bones.RightHand.matrixWorld.elements; return +Math.hypot(wx - hw[12], wy - hw[13], wz - hw[14]).toFixed(3); })(), hipsLp: [pu.bones.Hips.position.x, pu.bones.Hips.position.y, pu.bones.Hips.position.z].map((x: number) => +x.toFixed(3)), hipsParent: pu.bones.Hips.parent?.name, id: p.id, kh: bat ? +Math.hypot(bat.knob[0] - pu.bones.RightHand.matrixWorld.elements[12], bat.knob[1] - pu.bones.RightHand.matrixWorld.elements[13], bat.knob[2] - pu.bones.RightHand.matrixWorld.elements[14]).toFixed(3) : null, held: e.bat.held, batParent: e.bat.obj.parent?.name, gripW: pu.batGrip ? Array.from(pu.batGrip.matrixWorld.elements.slice(12, 15) as number[]).map((x: number) => +x.toFixed(3)) : null, knobW: bat?.knob.map((x: number) => +x.toFixed(3)), t: +st.time.toFixed(3), clip, hint: p.anim, pos: [p.pos.x, p.pos.y, p.pos.z].map((x: number) => +x.toFixed(3)), yaw: +pu.root.rotation.y.toFixed(3), hand: p.hand, mscale: pu.model.scale.x, mir: pu.mirrored, det: Math.sign(model[0] * (model[5] * model[10] - model[6] * model[9]) - model[4] * (model[1] * model[10] - model[2] * model[9]) + model[8] * (model[1] * model[6] - model[2] * model[5])), root: [pu.root.position.x, pu.root.position.y, pu.root.position.z].map((x: number) => +x.toFixed(3)), feet: s.trF.foot.map((c) => [+c.x.toFixed(3), +c.z.toFixed(3), c.planted]), cut, fading: mixerFading(pu.mixer), v: vF.map((x) => `${x.kind}:${x.excess.toFixed(2)}`) });
      // the mixer's pose with the bat where it would be: in the hand (on Bat_Grip) when the hand holds it, else where the sim has it
      const batC = bat && (bat.state === 'held' || bat.state === 'ondeck') ? { ...gripBat(s.C, s.info, Array.from(model), bat.hands), state: bat.state } : bat;
      validateFrame({ ...frameIn, L: s.C, bat: batC }, s.info, s.trC, vC);
      agg.add('frames', p.role, tag, [], animDt || dt);
      // visible: inside the camera's frustum
      const f = e.players.frustum;
      const vis = !f || f.intersectsSphere({ center: tmpV.set(p.pos.x, p.pos.y + 1, p.pos.z), radius: 1.3 });
      if (vis) stats.visibleFrames++;
      if (!vF.length) {
        agg.add(vis ? 'game' : 'game-off', p.role, tag, vF, animDt || dt);
        continue;
      }
      const fading = mixerFading(pu.mixer) || !!pu.inertia?.active;
      const clipEx = new Map<string, number>();
      for (const x of vC) clipEx.set(x.kind, Math.max(clipEx.get(x.kind) ?? 0, x.excess));
      const byAttr: Record<string, Violation[]> = { clip: [], blend: [], override: [] };
      for (const x of vF) {
        const c = clipEx.get(x.kind) ?? 0;
        const a = c >= x.excess * 0.8 - 1e-6 ? (fading ? 'blend' : 'clip') : 'override';
        byAttr[a].push(x);
        stats.attr[a]++;
        stats.attrSev[a] += x.sev * (animDt || dt);
      }
      const ctx = { seed: opts.seed, t: +st.time.toFixed(3), id: p.id, role: p.role, hint: p.anim, clip, hand: p.hand, vis, fading, ikW: +(pu.ikW ?? 0).toFixed(2), gloveW: +(pu.gloveW ?? 0).toFixed(2), look: [+(pu.headLook?.yaw ?? 0).toFixed(3), +(pu.headLook?.pitch ?? 0).toFixed(3)], speed: +Math.hypot(p.vel.x, p.vel.z).toFixed(2), bat: bat?.state ?? null };
      for (const a of ['clip', 'blend', 'override']) {
        if (!byAttr[a].length) continue;
        agg.add(`${vis ? 'game' : 'game-off'}:${a}`, p.role, tag, byAttr[a], animDt || dt, () => snapOf(s!.L, model, bat, { ...ctx, attr: a, clipPose: snapOf(s!.C, model, null, {}) }));
      }
    }
    const db = e.droppedBat;
    if (db?.visible) {
      db.updateWorldMatrix(true, false);
      const k = db.localToWorld(new V(0, 0, 0)), t = db.localToWorld(new V(0, 0.86, 0));
      const v: Violation[] = [];
      for (const P of [k, t]) {
        const h = P.y - groundHeight(P.x, P.z);
        const ex = Math.max(-h - 0.01, h - 0.08);
        if (ex > 0) v.push({ kind: 'bat:lying', excess: ex, sev: Math.min(3, ex / 0.05) });
      }
      agg.add('game', 'bat', 'dropped', v, animDt || dt);
    }
    stats.ms += performance.now() - t0;
  };

  const tick = e.tick.bind(e);
  e.tick = (dt: number, render?: boolean) => {
    tick(dt, render);
    if (!e.sim.paused) probe(dt);
  };
  w.__jank.state = { agg, stats, transitions, per };
  return true;
}

function mixerFading(mixer: any): boolean {
  const acts = mixer._actions.slice(0, mixer._nActiveActions);
  let n = 0;
  for (const a of acts) {
    const wgt = a.getEffectiveWeight();
    if (wgt > 0.01) n++;
  }
  return n > 1;
}

/** step the game without rendering; returns the sim time and whether the game is over */
export function run(frames: number) {
  const e = w.engine;
  for (let i = 0; i < frames; i++) {
    e.tick(1 / 60, false);
    if (e.liveState.over || e.liveState.gameOver) break;
  }
  return { t: e.liveState.time as number, over: !!(e.liveState.over || e.liveState.gameOver), inning: e.liveState.inning, half: e.liveState.half };
}

/** take what has been collected (and reset it) */
export function drain() {
  const s = w.__jank.state;
  const out = { entries: s.agg.list(), stats: { ...s.stats }, transitions: [...s.transitions.values()] };
  s.agg.entries.clear();
  return out;
}

// ---- studio --------------------------------------------------------------------------------------------------------------------------

let studio: { pu: any; bones: any[]; batObj: any } | null = null;

/**
 * Pose a stand-in puppet from a snapshot at the studio spot (behind the backstop, out of everyone's way) and aim the bench camera at it
 * from the front or the side (near-orthographic: 30 m away, a narrow lens). Returns the screen positions of the joints for the overlay.
 */
/**
 * Pose the studio puppet from a snapshot and aim the camera. `joints`: the joints the violation is about; the close-up looks at the one nearest
 * the spine (a hand or elbow inside the trunk is that one, whichever side). `xray`: the body drawn see-through in the close-up, so a joint
 * inside the trunk shows (it was hidden behind the jersey).
 */
export function studioPose(sn: Snapshot, view: 'front' | 'side' | 'detail', role = 'fielder', joints: string[] | string = '', xray = false) {
  const e = w.engine;
  const V = e.camera.position.constructor;
  if (!studio || studio.pu.__role !== role) {
    if (studio) {
      studio.pu.root.removeFromParent();
      studio.batObj.removeFromParent();
    }
    const src = e.liveState.players.find((p: any) => p.role === role) ?? e.liveState.players.find((p: any) => p.role !== 'umpire');
    const snap = { ...src, id: `jank-studio-${role}`, role, anim: 'idle', pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: 0, hasBall: false };
    const pu = e.players.makePuppet(snap);
    pu.__role = role;
    pu.update(snap, 0.016, { ball: null, batGrip: null, time: 0, ballSpeed: 0, mound: new V(0, 1.5, 18.4) });
    e.scene.add(pu.root);
    const batObj = e.bat.makeHandBat(false);
    e.scene.add(batObj);
    studio = { pu, bones: BONES.map((n) => pu.bones[n]), batObj };
  }
  const { pu, bones, batObj } = studio;
  for (const p of e.players.puppets.values()) if (p !== pu) p.root.visible = false;
  // the game's own bats (the batter's, a dropped one) stay out of the picture
  if (e.bat?.obj) e.bat.obj.visible = false;
  if (e.droppedBat) e.droppedBat.visible = false;
  pu.root.visible = true;
  for (let i = 0; i < NB; i++) {
    bones[i].quaternion.set(sn.lq[i * 4], sn.lq[i * 4 + 1], sn.lq[i * 4 + 2], sn.lq[i * 4 + 3]);
    bones[i].position.set(sn.lp[i * 3], sn.lp[i * 3 + 1], sn.lp[i * 3 + 2]);
  }
  // keep the snapshot's height scale and mirror, but face +Z at the studio spot
  const m = sn.model;
  const sc = Math.hypot(m[0], m[1], m[2]);
  const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
  const SPOT = new V(0, 0, 45); // shallow centre field: open grass, nothing between the camera and him
  pu.root.position.copy(SPOT);
  pu.root.rotation.set(0, 0, 0);
  pu.model.scale.set(det < 0 ? -sc : sc, sc, sc);
  // the puppet keeps its own matrices (root.matrixWorldAutoUpdate is off): compose them like its update does
  pu.refreshMatrices();
  // the bat: snapshot world -> the snapshot's rig space -> the studio's world
  batObj.visible = !!sn.bat;
  if (sn.bat) {
    const M = e.camera.matrixWorld.constructor;
    const inv = new M().fromArray(sn.model).invert();
    const k = new V(...sn.bat.knob).applyMatrix4(inv).applyMatrix4(pu.model.matrixWorld);
    const t = new V(...sn.bat.tip).applyMatrix4(inv).applyMatrix4(pu.model.matrixWorld);
    batObj.position.copy(k);
    batObj.quaternion.setFromUnitVectors(new V(0, 1, 0), t.clone().sub(k).normalize());
    batObj.scale.setScalar(1);
  }
  let tgt = SPOT.clone().add(new V(0, 0.95, 0));
  let dir = view === 'front' ? new V(0, 0, 1) : new V(det < 0 ? -1 : 1, 0, 0);
  let span = 2.6;
  const cand = (Array.isArray(joints) ? joints : [joints]).filter((j) => j && pu.bones[j]);
  let joint = cand[0] ?? '';
  if (cand.length > 1 && pu.bones.Spine1) {
    const sp = pu.bones.Spine1.getWorldPosition(new V());
    const dh = (j: string) => { const p = pu.bones[j].getWorldPosition(new V()); return Math.hypot(p.x - sp.x, p.z - sp.z); };
    joint = cand.reduce((a, b) => (dh(b) < dh(a) ? b : a));
  }
  setXray(pu, view === 'detail' && xray);
  if (view === 'detail') {
    // close-up of the joint the violation is about, from the front and a little to its side and above
    const b = joint && pu.bones[joint];
    if (b) tgt = b.getWorldPosition(new V());
    dir = new V(joint.startsWith('Left') === det > 0 ? 0.5 : -0.5, 0.35, 1).normalize();
    span = 0.7;
  }
  const dist = 30;
  e.director.bench = { pos: tgt.clone().addScaledVector(dir, dist), tgt, fov: (2 * Math.atan(span / 2 / dist) * 180) / Math.PI, aperture: 0 };
  return true;
}

/** the puppet's meshes see-through (their own material copies, restored when switched off) */
function setXray(pu: any, on: boolean) {
  pu.model.traverse((o: any) => {
    if (!o.isMesh) return;
    if (on && !o.__xrayOrig) {
      o.__xrayOrig = o.material;
      const cl = (m: any) => Object.assign(m.clone(), { transparent: true, opacity: 0.3, depthWrite: false });
      o.material = Array.isArray(o.material) ? o.material.map(cl) : cl(o.material);
    } else if (!on && o.__xrayOrig) {
      o.material = o.__xrayOrig;
      o.__xrayOrig = undefined;
    }
  });
}

/** screen positions (CSS px) of every joint, the head top and the bat ends, after the camera has moved (call after a rendered frame) */
export function studioJoints() {
  const e = w.engine;
  const V = e.camera.position.constructor;
  const cv = e.renderer.domElement.getBoundingClientRect();
  const proj = (p: any) => {
    const v = p.clone().project(e.camera);
    return [+((v.x * 0.5 + 0.5) * cv.width).toFixed(1), +((-v.y * 0.5 + 0.5) * cv.height).toFixed(1)];
  };
  const out: Record<string, number[]> = {};
  for (let i = 0; i < NB; i++) out[BONES[i]] = proj(studio!.bones[i].getWorldPosition(new V()));
  if (studio!.batObj.visible) {
    out.batKnob = proj(studio!.batObj.localToWorld(new V(0, 0, 0)));
    out.batTip = proj(studio!.batObj.localToWorld(new V(0, 0.86, 0)));
  }
  return out;
}

export function studioEnd() {
  const e = w.engine;
  if (studio) {
    studio.pu.root.removeFromParent();
    studio.batObj.removeFromParent();
    studio = null;
  }
  for (const p of e.players.puppets.values()) p.root.visible = true;
  e.director.bench = null;
}

w.__jank = { install, run, drain, studioPose, studioJoints, studioEnd, state: null, traceId: '', trace: [] as unknown[] };
