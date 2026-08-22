/**
 * Per-state motion, transcribed from `art/RIG.md` §3.
 *
 * Pure functions of time: no DOM, no state, no randomness. `renderer.ts` owns the clock, the
 * smoothing between states, and the stochastic layers (blinks, visemes) that must not be smoothed.
 *
 * Every function takes an `amp` multiplier applied to every oscillator. `amp = 1` is full motion;
 * `amp = 0` collapses each state to its *static hold* -- the pose without any continuous component
 * -- which is exactly what `prefers-reduced-motion: reduce` asks for.
 */

import type { AvatarState } from "./state";
import { NEUTRAL_POSE, type RigPose } from "./rig";

const TAU = Math.PI * 2;

/**
 * Resting blush.
 *
 * RIG.md §3 asks for blush "opacity up to 1.15x for 400 ms" on `error`, but SVG group opacity
 * clamps at 1, so a resting value of 1 has no headroom. Resting slightly under 1 buys the beat back
 * at the documented ratio. The gradient's own base alpha is 0.42, so this is 0.42a -> 0.37a at
 * rest: below the threshold of noticing on its own, and the error flush lands as specified.
 */
const BLUSH_REST = 0.87;
export const BLUSH_ERROR_PEAK = 1;

/** Builds the oscillator set for one frame. `period` is in seconds; `phase` is in turns. */
function oscillators(t: number, amp: number) {
  // The `amp === 0` short-circuit is not just a fast path: `0 * Math.sin(x)` is `-0` for half of
  // the cycle, and a pose full of negative zeroes is not equal to the same pose full of positive
  // ones. Reduced motion must produce one stable static pose, so normalize here.
  return (period: number, phase = 0) =>
    amp === 0 ? 0 : amp * Math.sin(TAU * (t / period + phase));
}

/**
 * The always-on ambient layer: breath, idle drift, micro hair sway.
 *
 * Periods are mutually coprime-ish (5.5 / 3.7 / 6 / 7.3 / 11.3 / 8.9 s) so the composite loop never
 * visibly repeats -- RIG.md §3 calls this out for the head specifically and it applies just as much
 * to the hair and the gaze.
 */
export function ambientPose(t: number, amp = 1): RigPose {
  const o = oscillators(t, amp);
  return {
    ...NEUTRAL_POSE,

    headRot: 1.5 * o(5.5),
    headDy: 2 * o(3.7),
    headDx: 0,

    // One phase, staggered: bangs lead the locks by ~80 ms, the back locks lag the front by
    // ~140 ms (RIG.md §2). That stagger is what reads as hair rather than as a rotating sprite.
    bangRot: 1.2 * o(5.5, 0.08 / 5.5),
    lockRot: 1.2 * o(5.5),
    backSwayRot: 1.05 * o(5.5, -0.14 / 5.5),

    // Phase-offset from the head so the loop trails rather than tracks.
    ahogeRot: 5 * o(6, 0.28),

    // The coat settling on the breath, in phase with the head so the whole bust rises together.
    collarDy: 0.9 * o(3.7),
    capeRot: 0.7 * o(7.3),

    // A barely-there gaze wander. Without it the eyes look painted on between blinks.
    globeDx: 1.2 * o(11.3),
    globeDy: 0.8 * o(8.9),

    blushOpacity: BLUSH_REST,
  };
}

/**
 * The full continuous target for a state.
 *
 * @param t   wall time in seconds, on an arbitrary but monotonic origin
 * @param tIn seconds since this state was entered, for motion that plays out from entry
 */
export function statePose(state: AvatarState, t: number, tIn: number, amp = 1): RigPose {
  const o = oscillators(t, amp);
  const base = ambientPose(t, amp);

  switch (state.kind) {
    case "idle":
      return base;

    case "listening":
      // Chin up, brows raised, eyes wide and angled slightly up: attending to the person, not to
      // the work. The ahoge perks and holds -- at small sizes it is the whole read.
      return {
        ...base,
        headRot: 2.5 + base.headRot * 0.6,
        headDy: base.headDy - 1,
        browDy: -2.5,
        browRot: -3,
        globeDy: -1.2 + base.globeDy * 0.5,
        globeDx: base.globeDx * 0.5,
        ahogeRot: 6 + base.ahogeRot * 0.5,
        ahogeScale: 1.04,
      };

    case "thinking": {
      // RIG.md §3: head -6 deg and down-left, half-lid at 14, inner brow ends lifted, and the
      // ahoge drawing a slow question-mark curl. The curl is the part that reads as *pondering*.
      const curl = amp === 0 ? 0.5 : (1 - Math.cos(TAU * (tIn / 2.5))) / 2;
      return {
        ...base,
        headRot: -6 + base.headRot * 0.35,
        headDy: 3 + base.headDy * 0.4,
        globeDx: -6,
        globeDy: -3,
        lidUpperL: 14,
        lidUpperR: 14,
        browRot: -6,
        browDy: -1,
        lockRot: base.lockRot * 0.5,
        bangRot: base.bangRot * 0.5,
        backSwayRot: base.backSwayRot * 0.5,
        ahogeRot: 4 + 10 * curl,
        ahogeScale: 0.96 + 0.04 * curl,
        mouth: "closed",
      };
    }

    case "talking":
      // RIG.md §3: +/-3 deg head with a translate on stressed syllables, brows up on emphasis, and
      // a ~2 Hz damped ahoge bounce "in sympathy with head accents". The two head oscillators beat
      // against each other so the rhythm never settles into a metronome.
      return {
        ...base,
        headRot: 3 * o(1.9) + 1.2 * o(0.77),
        headDy: base.headDy * 0.6 + 1.2 * o(0.63),
        browDy: -1.5 - 1.5 * Math.max(0, o(1.31)),
        lidUpperL: 0,
        lidUpperR: 0,
        lockRot: base.lockRot * 1.3,
        bangRot: base.bangRot * 1.3,
        backSwayRot: base.backSwayRot * 1.3,
        ahogeRot: 8 * o(0.5) * (0.6 + 0.4 * (amp === 0 ? 1 : Math.sin(TAU * t / 2.3))),
        // The viseme layer overrides this while animating; it is the static reduced-motion read.
        mouth: "half",
      };

    case "working":
      return workingPose(state.work, t, base, o, amp);

    case "error":
      // The held aftermath. The 260 ms shake and the ahoge zig that precede it are one-shots
      // (`applyOneShots`) -- they must not be smoothed, which is the whole point of the beat.
      return {
        ...base,
        headRot: -2,
        headDy: base.headDy * 0.3,
        browRot: 12,
        browDy: 5,
        lidUpperL: 8,
        lidUpperR: 8,
        pupilScale: 0.85,
        lockRot: base.lockRot * 0.4,
        bangRot: base.bangRot * 0.4,
        backSwayRot: base.backSwayRot * 0.4,
        ahogeRot: 10,
        ahogeScale: 0.93,
        mouth: "frown",
      };

    case "done":
      // RIG.md §3: lifted and settled, smile-eyes from the *lower* lid, brows up. The star pop and
      // the ahoge perk are one-shots on top.
      return {
        ...base,
        headRot: 4 + base.headRot * 0.5,
        headDy: -3 + base.headDy * 0.5,
        browDy: -4,
        browRot: -2,
        lidLowerL: -11,
        lidLowerR: -11,
        ahogeRot: -8,
        ahogeScale: 1.08,
        mouth: "smile",
      };

    case "paused":
      // The socket is dead and we know nothing. This has to be visibly *not idle*, or a frozen
      // stream reads as a calm one -- so it goes past RIG.md §2's "sleepy" lid at 10 to a clear
      // half-lid at 20, with the head down, the ahoge drooped and scaled in, and the ambient
      // dialled most of the way out. Dozing, waiting for the line to come back.
      return {
        ...base,
        headRot: -4 + base.headRot * 0.25,
        headDy: 5 + base.headDy * 0.25,
        lidUpperL: 20,
        lidUpperR: 20,
        globeDy: 2,
        globeDx: base.globeDx * 0.3,
        browDy: 2,
        browRot: -3,
        lockRot: base.lockRot * 0.3,
        bangRot: base.bangRot * 0.3,
        backSwayRot: base.backSwayRot * 0.3,
        ahogeRot: 15 + base.ahogeRot * 0.15,
        ahogeScale: 0.9,
        mouth: "closed",
      };
  }
}

type Osc = (period: number, phase?: number) => number;

/**
 * The four working poses.
 *
 * RIG.md §3 specifies one `working` pose -- focused squint, brows down, brisk ahoge metronome. The
 * per-kind variation on top is this module's, built from the same channels and the same safe
 * ranges, and chosen so the four are distinguishable at 96 px from the eyes alone: `read` tracks
 * left-to-right, `write` looks down, `browse` roams, `execute` narrows to a point and stops moving.
 */
function workingPose(
  work: "read" | "write" | "browse" | "execute",
  t: number,
  base: RigPose,
  o: Osc,
  amp: number,
): RigPose {
  const common: RigPose = {
    ...base,
    headRot: 1 * o(1.6),
    headDy: base.headDy * 0.5,
    lidUpperL: 10,
    lidUpperR: 10,
    lidLowerL: -8,
    lidLowerR: -8,
    browDy: 4,
    browRot: 6,
    lockRot: base.lockRot * 0.6,
    bangRot: base.bangRot * 0.6,
    backSwayRot: base.backSwayRot * 0.6,
    // "A small, brisk metronome -- +/-6 deg at ~0.9 Hz, constant amplitude. Reads as busy rather
    // than agitated."
    ahogeRot: 6 * o(1 / 0.9),
    mouth: "closed",
  };

  switch (work) {
    case "read": {
      // A reading saccade: sweep left-to-right, snap back. Linear-then-snap, not a sine -- a sine
      // reads as looking around, and this needs to read as scanning lines.
      const p = amp === 0 ? 0.5 : ((t / 1.6) % 1 + 1) % 1;
      const sweep = p < 0.85 ? -5 + 10 * (p / 0.85) : 5 - 10 * ((p - 0.85) / 0.15);
      return {
        ...common,
        globeDx: amp === 0 ? 0 : sweep,
        globeDy: 1 + 0.5 * o(5.3),
        headDy: 2 + base.headDy * 0.4,
        lidUpperL: 8,
        lidUpperR: 8,
      };
    }

    case "write":
      // Head and gaze down on the page; the ahoge picks up to a busier 1.2 Hz.
      return {
        ...common,
        headRot: -2 + 0.8 * o(1.4),
        headDy: 4 + base.headDy * 0.3,
        globeDx: 1.5 * o(0.9),
        globeDy: 4,
        browDy: 3,
        ahogeRot: 5 * o(1 / 1.2),
      };

    case "browse":
      // Eyes roaming a page at two unrelated rates, lids more open than the other kinds: taking
      // things in rather than bearing down on them.
      return {
        ...common,
        headRot: 2 * o(3.1),
        globeDx: 6 * o(2.3),
        globeDy: 1 + 3 * o(1.7),
        lidUpperL: 6,
        lidUpperR: 6,
        lidLowerL: -5,
        lidLowerR: -5,
        browDy: 2,
        browRot: 3,
        ahogeRot: 3 + 5 * o(1.4),
      };

    case "execute":
      // The hard stare: narrowest lids, gaze locked, ahoge at 1.4 Hz, and a faint pulse on the
      // chest star -- the one channel that says "something is running" without moving the face.
      return {
        ...common,
        headRot: 0.6 * o(2.2),
        globeDx: 0,
        globeDy: 0,
        lidUpperL: 12,
        lidUpperR: 12,
        lidLowerL: -10,
        lidLowerR: -10,
        browRot: 8,
        ahogeRot: 7 * o(1 / 1.4),
        starScale: 1 + 0.06 * Math.max(0, o(0.8)),
      };
  }
}

/** Piecewise-linear interpolation through `(time, value)` keyframes. Holds the last value. */
function keyframe(tIn: number, frames: readonly (readonly [number, number])[]): number {
  const last = frames[frames.length - 1]!;
  if (tIn >= last[0]) return last[1];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1]!;
    const b = frames[i]!;
    if (tIn < b[0]) {
      const span = b[0] - a[0];
      return span <= 0 ? b[1] : a[1] + (b[1] - a[1]) * ((tIn - a[0]) / span);
    }
  }
  return last[1];
}

/**
 * Sharp entry beats, applied to the *already smoothed* pose.
 *
 * These are the motions RIG.md §3 specifies in tens of milliseconds -- the error head-shake, the
 * ahoge zig, the `done` star pop. Running them through the renderer's smoothing filter would
 * flatten them into nothing, so they are written last and absolutely.
 *
 * Mutates `pose` in place; returns whether anything was written, so the renderer knows a state is
 * still mid-beat.
 */
export function applyOneShots(pose: RigPose, state: AvatarState, tIn: number): boolean {
  if (state.kind === "error") {
    // "A single sharp head rotate -7 -> +5 -> 0 over 260 ms, then hold at -2."
    if (tIn < 0.26) {
      pose.headRot = keyframe(tIn, [[0, -7], [0.09, 5], [0.18, 0], [0.26, -2]]);
    }
    // "A violent zig -- rotate -20 -> +18 -> -6 in 180 ms, then settle to a droop at +10."
    if (tIn < 0.3) {
      pose.ahogeRot = keyframe(tIn, [[0, -20], [0.06, 18], [0.12, -6], [0.3, 10]]);
      pose.ahogeScale = keyframe(tIn, [[0, 1.02], [0.18, 0.93]]);
    }
    // "Blush opacity up to 1.15x for 400 ms."
    if (tIn < 0.4) {
      pose.blushOpacity = keyframe(tIn, [[0, BLUSH_ERROR_PEAK], [0.28, BLUSH_ERROR_PEAK], [0.4, 0.87]]);
    }
    return tIn < 0.4;
  }

  if (state.kind === "done") {
    // "chest-star scale 1.0 -> 1.22 -> 1.0 over 400 ms and collar-clasp glint on the same beat."
    if (tIn < 0.45) {
      pose.starScale = keyframe(tIn, [[0, 1], [0.18, 1.22], [0.4, 1]]);
      pose.claspScale = keyframe(tIn, [[0, 1], [0.16, 1.3], [0.38, 1]]);
    }
    // "Perk -- scale 1.0 -> 1.10 with rotate 0 -> -15 in 200 ms, then a settling wobble of two
    // decaying oscillations."
    if (tIn < 1.3) {
      if (tIn < 0.2) {
        pose.ahogeRot = keyframe(tIn, [[0, 0], [0.2, -15]]);
        pose.ahogeScale = keyframe(tIn, [[0, 1], [0.2, 1.1]]);
      } else {
        const w = tIn - 0.2;
        pose.ahogeRot = -8 + -7 * Math.exp(-w * 3.2) * Math.cos(TAU * w * 1.6);
        pose.ahogeScale = 1.08 + 0.02 * Math.exp(-w * 3.2) * Math.cos(TAU * w * 1.6);
      }
    }
    return tIn < 1.3;
  }

  return false;
}
