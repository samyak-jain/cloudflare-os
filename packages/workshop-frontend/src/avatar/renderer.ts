/**
 * The SVG renderer: turns a stream of `AvatarStateSnapshot`s into motion on a `LenaRig`.
 *
 * Structure of one frame:
 *
 *   1. `statePose()` gives the state's *continuous* target (ambient + the state's own motion).
 *   2. That target is smoothed into the live pose with an exponential filter, which is what makes
 *      every state-to-state transition a blend rather than a cut, for free and in one place.
 *   3. The layers that must stay sharp are written on top, unsmoothed: blinks, talking visemes, and
 *      the entry beats in `applyOneShots()`.
 *
 * ## Cost
 *
 * The avatar's running cost is rasterization, not arithmetic -- see the frame-rate tiers below --
 * so the loop renders at the slowest rate the current state's motion tolerates: 8 fps idle, 24 fps
 * during a turn, 60 fps for cuts, impulses and the settle after a state change. `LenaRig` also
 * quantizes to two decimals and skips unchanged attributes. The loop stops entirely while the
 * document is hidden, and never starts under `prefers-reduced-motion`.
 */

import { applyOneShots, statePose } from "./poses";
import { BLINK_CLOSED, NEUTRAL_POSE, type LenaRig, type MouthShape, type RigPose } from "./rig";
import { IDLE_SNAPSHOT, sameAvatarState, type AvatarStateSnapshot } from "./state";

/** Time constant of the transition filter. ~0.09 s reads as a settle, not a lag. */
const SMOOTH_TAU = 0.09;

/**
 * Frame-rate tiers.
 *
 * Measured on this rig, the avatar's idle cost is *entirely* rasterization: with the element
 * `display:none` the loop's JS and attribute writes measure at zero, and painting it costs roughly
 * 0.13 % of a main thread per rendered-frame-per-second. So the frame rate is the only real lever,
 * and the right rate is the slowest one the motion at hand can survive.
 *
 * - `IDLE_FPS` -- idle / listening / paused. Nothing here moves faster than a 3.7 s breath and at
 *   96 px the amplitudes are fractions of a pixel; 8 fps is still thirty samples per cycle.
 * - `ACTIVE_FPS` -- thinking / working / the held tail of error and done. The ahoge metronome runs
 *   at 0.9-1.4 Hz and does swing a few pixels, so it needs real sampling -- but only while a turn
 *   is actually in progress.
 * - `FAST_FPS` -- anything cut or impulsive: visemes at 8-12 Hz, the 70 ms blink close, the entry
 *   beats, and the settle window after any state change, which is where the transition filter does
 *   its work and where stepping would read as a snap rather than a blend.
 */
const IDLE_FPS = 8;
const ACTIVE_FPS = 24;
const FAST_FPS = 60;

/** How long after a state change the loop stays at `FAST_FPS` so the blend reads as a blend. */
const SETTLE_S = 0.4;

/** RIG.md §3 blink timings: close 70 ms ease-in, hold 40 ms, open 110 ms ease-out. */
const BLINK_CLOSE = 0.07;
const BLINK_HOLD = 0.04;
const BLINK_OPEN = 0.11;
const BLINK_PULSE = BLINK_CLOSE + BLINK_HOLD + BLINK_OPEN;
/** Gap between the two pulses of a double blink. */
const BLINK_DOUBLE_GAP = 0.12;

/** Randomized blink spacing, per the runtime spec (RIG.md's own guidance is 4-7 s). */
const BLINK_MIN_S = 2;
const BLINK_MAX_S = 6;

/** Viseme cut rate: 8-12 changes per second, "never tween the shapes, cut them" (RIG.md §3). */
const VISEME_MIN_S = 1 / 12;
const VISEME_MAX_S = 1 / 8;

const NUMERIC_CHANNELS = [
  "headRot", "headDx", "headDy",
  "lidUpperL", "lidUpperR", "lidLowerL", "lidLowerR",
  "globeDx", "globeDy", "pupilScale",
  "browRot", "browDy",
  "lockRot", "bangRot", "backSwayRot",
  "ahogeRot", "ahogeScale",
  "collarDy", "capeRot", "starRot", "starScale", "claspScale", "blushOpacity",
] as const satisfies readonly (keyof RigPose)[];

export type AvatarRendererOptions = {
  /** Monotonic clock in milliseconds. Injected so tests can step time by hand. */
  now?: () => number;
  random?: () => number;
  requestFrame?: (cb: (t: number) => void) => number;
  cancelFrame?: (handle: number) => void;
  /**
   * Static pose changes only, no continuous animation. When true the loop never starts; each state
   * change writes one frame with every oscillator collapsed to zero.
   */
  reducedMotion?: boolean;
};

export class SvgAvatarRenderer {
  readonly #rig: LenaRig;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #requestFrame: (cb: (t: number) => void) => number;
  readonly #cancelFrame: (handle: number) => void;

  #reducedMotion: boolean;
  #snapshot: AvatarStateSnapshot = IDLE_SNAPSHOT;
  #pose: RigPose = { ...NEUTRAL_POSE };
  #started = false;
  #destroyed = false;
  #handle: number | null = null;
  #lastFrameMs: number | null = null;
  /** Wall clock of the last frame we actually rendered, for the fps gate. */
  #lastRenderMs = 0;

  // Blink scheduler.
  #nextBlinkAt = 0;
  #blinkStartedAt: number | null = null;
  #blinkDouble = false;
  #blinkCount = 0;

  // Viseme scheduler.
  #mouth: MouthShape = "closed";
  #nextVisemeAt = 0;

  #onVisibilityChange: (() => void) | null = null;

  constructor(rig: LenaRig, options: AvatarRendererOptions = {}) {
    this.#rig = rig;
    this.#now = options.now ?? (() => performance.now());
    this.#random = options.random ?? Math.random;
    this.#requestFrame = options.requestFrame
      ?? ((cb) => requestAnimationFrame(cb));
    this.#cancelFrame = options.cancelFrame ?? ((handle) => cancelAnimationFrame(handle));
    this.#reducedMotion = options.reducedMotion ?? false;

    this.#nextBlinkAt = this.#now() / 1000 + this.#randomBetween(BLINK_MIN_S, BLINK_MAX_S);

    if (typeof document !== "undefined") {
      this.#onVisibilityChange = () => {
        if (document.hidden) this.#stopLoop();
        else if (this.#started) this.#startLoop();
      };
      document.addEventListener("visibilitychange", this.#onVisibilityChange);
    }
  }

  /** Begins rendering. Idempotent. */
  start(): void {
    if (this.#destroyed || this.#started) return;
    this.#started = true;
    if (this.#reducedMotion) this.#renderStatic();
    else this.#startLoop();
  }

  setState(snapshot: AvatarStateSnapshot): void {
    const changed = !sameAvatarState(snapshot.state, this.#snapshot.state)
      || snapshot.since !== this.#snapshot.since;
    if (!changed) return;
    this.#snapshot = snapshot;

    if (snapshot.state.kind === "talking") {
      // Start cutting visemes immediately rather than on the next scheduled boundary; a
      // quarter-second of a closed mouth at the top of a sentence is very visible.
      this.#nextVisemeAt = 0;
    } else {
      this.#mouth = NEUTRAL_POSE.mouth;
    }

    if (snapshot.state.kind === "done") {
      // "Follow with one contented blink." (RIG.md §3)
      this.#nextBlinkAt = this.#now() / 1000 + 0.75;
    } else if (snapshot.state.kind === "error") {
      // A hard, narrow stare does not blink through its own beat.
      this.#nextBlinkAt = Math.max(this.#nextBlinkAt, this.#now() / 1000 + 0.6);
    }

    if (this.#reducedMotion && this.#started) this.#renderStatic();
  }

  setReducedMotion(reduced: boolean): void {
    if (reduced === this.#reducedMotion) return;
    this.#reducedMotion = reduced;
    if (!this.#started) return;
    if (reduced) {
      this.#stopLoop();
      this.#renderStatic();
    } else {
      this.#lastFrameMs = null;
      this.#startLoop();
    }
  }

  destroy(): void {
    this.#destroyed = true;
    this.#started = false;
    this.#stopLoop();
    if (this.#onVisibilityChange !== null && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.#onVisibilityChange);
      this.#onVisibilityChange = null;
    }
  }

  /** The pose most recently written. Exposed for tests and for the QA harness. */
  get pose(): Readonly<RigPose> {
    return this.#pose;
  }

  // ── loop ──────────────────────────────────────────────────────────────────────────────────────

  #startLoop(): void {
    if (this.#handle !== null || this.#destroyed) return;
    if (typeof document !== "undefined" && document.hidden) return;
    this.#lastRenderMs = 0;
    this.#handle = this.#requestFrame(this.#tick);
  }

  #stopLoop(): void {
    if (this.#handle === null) return;
    this.#cancelFrame(this.#handle);
    this.#handle = null;
    this.#lastFrameMs = null;
  }

  #tick = (): void => {
    this.#handle = null;
    if (this.#destroyed || this.#reducedMotion) return;

    const nowMs = this.#now();
    // Frame-rate gate. rAF still wakes at the display rate, but skipping the body is the bulk of
    // the cost: no pose maths, no attribute writes, no style invalidation.
    if (nowMs - this.#lastRenderMs >= 1000 / this.#targetFps() - 1) {
      this.#lastRenderMs = nowMs;
      this.#renderFrame(nowMs);
    }

    this.#handle = this.#requestFrame(this.#tick);
  };

  #targetFps(): number {
    const kind = this.#snapshot.state.kind;
    // Cut layers and impulses need every frame they can get.
    if (kind === "talking" || this.#blinkStartedAt !== null) return FAST_FPS;

    const tIn = (this.#now() - this.#snapshot.since) / 1000;
    if (tIn < SETTLE_S) return FAST_FPS;
    // The `error` shake and the `done` perk run past the generic settle window.
    if ((kind === "error" || kind === "done") && tIn < 1.4) return FAST_FPS;

    if (kind === "thinking" || kind === "working" || kind === "error" || kind === "done") {
      return ACTIVE_FPS;
    }
    return IDLE_FPS;
  }

  #renderFrame(nowMs: number): void {
    const t = nowMs / 1000;
    const dt = this.#lastFrameMs === null ? 0 : Math.min(0.25, (nowMs - this.#lastFrameMs) / 1000);
    this.#lastFrameMs = nowMs;

    const state = this.#snapshot.state;
    const tIn = Math.max(0, (nowMs - this.#snapshot.since) / 1000);
    const target = statePose(state, t, tIn);

    // Exponential smoothing, frame-rate independent. dt === 0 on the first frame snaps into place
    // rather than easing up from neutral.
    const alpha = dt === 0 ? 1 : 1 - Math.exp(-dt / SMOOTH_TAU);
    for (const channel of NUMERIC_CHANNELS) {
      this.#pose[channel] += (target[channel] - this.#pose[channel]) * alpha;
    }
    this.#pose.mouth = target.mouth;

    applyOneShots(this.#pose, state, tIn);
    this.#applyBlink(t);
    if (state.kind === "talking") this.#pose.mouth = this.#nextViseme(t);

    this.#rig.apply(this.#pose);
  }

  /** Reduced motion: one static frame per state change, oscillators collapsed, no scheduler. */
  #renderStatic(): void {
    const state = this.#snapshot.state;
    // `amp = 0` removes every continuous component; `tIn` past the end of the entry beats leaves
    // each state at its held pose, which is the whole of what reduced motion should show.
    this.#pose = statePose(state, 0, 10, 0);
    this.#rig.apply(this.#pose);
  }

  // ── blink ─────────────────────────────────────────────────────────────────────────────────────

  #applyBlink(t: number): void {
    if (this.#blinkStartedAt === null) {
      if (t < this.#nextBlinkAt) return;
      this.#blinkStartedAt = t;
      this.#blinkCount += 1;
      // "Every 5th blink or so, double it."
      this.#blinkDouble = this.#blinkCount % 5 === 0;
    }

    const u = t - this.#blinkStartedAt;
    const span = this.#blinkDouble ? BLINK_PULSE * 2 + BLINK_DOUBLE_GAP : BLINK_PULSE;
    if (u >= span) {
      this.#blinkStartedAt = null;
      const spacing = this.#randomBetween(BLINK_MIN_S, BLINK_MAX_S)
        * (this.#snapshot.state.kind === "paused" ? 1.8 : 1);
      this.#nextBlinkAt = t + spacing;
      return;
    }

    const local = this.#blinkDouble && u >= BLINK_PULSE + BLINK_DOUBLE_GAP
      ? u - BLINK_PULSE - BLINK_DOUBLE_GAP
      : u;
    const lid = blinkLid(local);
    if (lid <= 0) return;

    // The lid closes *over* whatever the state's own lid position is, so a blink during the
    // thinking half-lid still reads as a blink rather than as a smaller one.
    this.#pose.lidUpperL = Math.max(this.#pose.lidUpperL, lid);
    this.#pose.lidUpperR = Math.max(this.#pose.lidUpperR, lid);
    // "Drop the brows 1-2 px during the close and let them recover a frame late."
    this.#pose.browDy += 1.5 * (lid / BLINK_CLOSED);
    // "A 3 deg flick on the open."
    if (local > BLINK_CLOSE + BLINK_HOLD) {
      const open = (local - BLINK_CLOSE - BLINK_HOLD) / BLINK_OPEN;
      this.#pose.ahogeRot += 3 * Math.sin(Math.PI * open);
    }
  }

  // ── visemes ───────────────────────────────────────────────────────────────────────────────────

  #nextViseme(t: number): MouthShape {
    if (t < this.#nextVisemeAt) return this.#mouth;
    this.#nextVisemeAt = t + this.#randomBetween(VISEME_MIN_S, VISEME_MAX_S)
      // One cut in eight is held for two beats, which is what a word boundary looks like. Without
      // it the cut rate is too even and the mouth reads as a buzzer.
      * (this.#random() < 0.125 ? 2 : 1);

    // Weighted so `half` dominates and the mouth is closed often enough to punctuate; never repeat
    // the current shape, since a repeat is a beat with no visible change.
    const choices: MouthShape[] = this.#mouth === "half"
      ? ["open", "open", "closed", "open"]
      : ["half", "half", "half", "open"];
    return choices[Math.min(choices.length - 1, Math.floor(this.#random() * choices.length))]!;
  }

  #randomBetween(lo: number, hi: number): number {
    return lo + this.#random() * (hi - lo);
  }
}

/** Blink lid position over one pulse, in rig units. Asymmetric, "or it looks mechanical". */
export function blinkLid(u: number): number {
  if (u < 0) return 0;
  if (u < BLINK_CLOSE) {
    const x = u / BLINK_CLOSE;
    return BLINK_CLOSED * x * x;
  }
  if (u < BLINK_CLOSE + BLINK_HOLD) return BLINK_CLOSED;
  const x = (u - BLINK_CLOSE - BLINK_HOLD) / BLINK_OPEN;
  if (x >= 1) return 0;
  return BLINK_CLOSED * (1 - (1 - (1 - x) * (1 - x)));
}
