/**
 * The Lena rig binding: the contract in `art/RIG.md` expressed as code.
 *
 * Everything here -- transform origins, safe ranges, the transform *composition order* -- is
 * transcribed from `art/RIG.md` §2, which is the rig's API. `art/verify.py` validates the SVG
 * against the same contract (`python3 art/verify.py`, from this package). If the art is re-exported
 * and an origin moves, this file and RIG.md move together.
 *
 * The rig animates by writing a `transform` attribute on a named group, or by toggling `display`
 * on the mouth siblings. No CSS, no `transform-box`, no `transform-origin`: every rotation is
 * SVG-1.1 `rotate(angle cx cy)`, which behaves identically across browsers and rasterizers.
 */

/** Documented transform origins, in viewBox units (RIG.md §2). */
const ORIGIN = {
  head: [256, 380],
  pupilL: [196, 250],
  pupilR: [316, 250],
  browL: [150, 197],
  browR: [362, 197],
  lockL: [152, 114],
  lockR: [360, 114],
  bangL: [250, 58],
  bangR: [262, 58],
  backSwayL: [102, 176],
  backSwayR: [410, 176],
  ahoge: [258, 72],
  capeL: [258, 390],
  capeR: [254, 390],
  star: [256, 470],
  clasp: [256, 386],
} as const;

/** Safe ranges from RIG.md §2 -- "verified not to clip, spill, or tear". */
export const RANGE = {
  headRot: [-12, 12],
  headDx: [-8, 8],
  headDy: [-6, 10],
  /** 0 = open, 56 = fully closed. */
  lidUpper: [0, 56],
  lidLower: [-18, 4],
  globeDx: [-8, 8],
  globeDy: [-6, 6],
  pupilScale: [0.8, 1.35],
  browRot: [-14, 14],
  browDy: [-9, 5],
  lockRot: [-3.5, 3.5],
  bangRot: [-3, 3],
  backSwayRot: [-3, 3],
  ahogeRot: [-22, 22],
  ahogeScale: [0.88, 1.12],
  collarDy: [-5, 3],
  capeRot: [-2.5, 2.5],
  starScale: [0.9, 1.25],
  claspScale: [0.9, 1.3],
  blushOpacity: [0, 1],
} as const satisfies Record<string, readonly [number, number]>;

/** The value of `lidUpper` at which the eye is fully shut (RIG.md §2). */
export const BLINK_CLOSED = 56;

/**
 * The viewBox to render the art through when it is circle-cropped.
 *
 * The art is composed for a *square* frame: `lena-ahoge`'s topmost ink sits at y = 1, i.e. flush
 * with the top of the 512 box and 255.3 units from its centre -- a hair inside the inscribed
 * circle at rest, and outside it the moment the loop scales (up to 1.12) or the head lifts. Since
 * RIG.md §3 makes the ahoge the state signal that survives to the smallest sizes, losing its tip is
 * the one crop loss that is not acceptable.
 *
 * So the art is inset inside a slightly larger square box. The padding is top-heavy on purpose:
 * the bust bleeds off the bottom of the frame by design, and padding there would put a pale
 * crescent under the navy shoulders. Left/right padding lands on the overdrawn back-hair mass and
 * the backdrop's outer stop, both of which sit within a couple of levels of the host's own
 * backdrop, so those bands do not read as a seam.
 *
 * With this box the crop circle is centred at (256, 239) with r = 273 in art units, which clears
 * the ahoge at its full documented extremes (scale 1.12, rotate ±22, head lifted 6).
 */
export const CROP_VIEWBOX = "-17 -34 546 546";

export type MouthShape = "closed" | "half" | "open" | "smile" | "frown";
export const MOUTH_SHAPES: readonly MouthShape[] = ["closed", "half", "open", "smile", "frown"];

/**
 * Every channel the renderer can drive, in rig units.
 *
 * Split from the DOM deliberately: a pose is plain data, so poses can be composed, blended and
 * asserted on without a document. `renderer.ts` computes one of these per frame and `LenaRig`
 * writes the diff.
 */
export type RigPose = {
  headRot: number;
  headDx: number;
  headDy: number;

  lidUpperL: number;
  lidUpperR: number;
  lidLowerL: number;
  lidLowerR: number;
  globeDx: number;
  globeDy: number;
  pupilScale: number;

  browRot: number;
  browDy: number;

  lockRot: number;
  bangRot: number;
  backSwayRot: number;

  ahogeRot: number;
  ahogeScale: number;

  collarDy: number;
  capeRot: number;
  starRot: number;
  starScale: number;
  claspScale: number;
  blushOpacity: number;

  mouth: MouthShape;
};

/**
 * Rest pose. Every numeric channel is zero-or-identity, so the rig with `NEUTRAL_POSE` applied is
 * byte-for-byte the art as authored.
 */
export const NEUTRAL_POSE: RigPose = {
  headRot: 0, headDx: 0, headDy: 0,
  lidUpperL: 0, lidUpperR: 0, lidLowerL: 0, lidLowerR: 0,
  globeDx: 0, globeDy: 0, pupilScale: 1,
  browRot: 0, browDy: 0,
  lockRot: 0, bangRot: 0, backSwayRot: 0,
  ahogeRot: 0, ahogeScale: 1,
  collarDy: 0, capeRot: 0, starRot: 0, starScale: 1, claspScale: 1, blushOpacity: 1,
  mouth: "closed",
};

export function clamp(value: number, [lo, hi]: readonly [number, number]): number {
  return value < lo ? lo : value > hi ? hi : value;
}

/**
 * Round for attribute output.
 *
 * Two decimals is well under a rendered pixel at any size we ship (1 viewBox unit = 1 px at 512),
 * and quantizing is what makes the change-detection in `LenaRig.apply()` effective: the slow idle
 * channels genuinely stop moving between frames, so most frames write nothing at all.
 */
function q(value: number): number {
  return Math.round(value * 100) / 100;
}

function rot(angle: number, origin: readonly [number, number] | readonly number[]): string {
  return `rotate(${q(angle)} ${origin[0]} ${origin[1]})`;
}

function scaleAbout(k: number, origin: readonly number[]): string {
  const [cx, cy] = origin;
  return `translate(${cx} ${cy}) scale(${q(k)}) translate(${-cx!} ${-cy!})`;
}

/**
 * Namespaces the rig's ids so two avatars can coexist on one page.
 *
 * The art uses hand-authored literal ids (`lena-*`), which is what makes them safe to bind to --
 * and also means two inlined copies would collide, with the second copy's `url(#lena-clip-face)`
 * resolving against the first copy's clip. Rewriting ids and the `url(#...)`/`aria-labelledby`
 * references that point at them keeps each instance self-contained. `LenaRig` indexes elements by
 * their *base* id, so nothing downstream sees the suffix.
 */
export function namespaceRigIds(svg: string, suffix: string): string {
  if (suffix === "") return svg;
  return svg
    .replace(/id="(lena-[A-Za-z0-9-]+)"/g, (_m, id: string) => `id="${id}--${suffix}"`)
    .replace(/url\(#(lena-[A-Za-z0-9-]+)\)/g, (_m, id: string) => `url(#${id}--${suffix})`)
    .replace(
      /aria-labelledby="([^"]*)"/g,
      (_m, list: string) =>
        `aria-labelledby="${list.split(/\s+/).map((id) => (id.startsWith("lena-") ? `${id}--${suffix}` : id)).join(" ")}"`,
    );
}

/** Ids the renderer drives. Missing ones are tolerated (see `LenaRig.missing`). */
const DRIVEN_IDS = [
  "lena-head", "lena-head-back",
  "lena-eye-l-lid-upper", "lena-eye-r-lid-upper",
  "lena-eye-l-lid-lower", "lena-eye-r-lid-lower",
  "lena-eye-l-globe", "lena-eye-r-globe",
  "lena-eye-l-pupil", "lena-eye-r-pupil",
  "lena-brow-l", "lena-brow-r",
  "lena-hair-lock-l", "lena-hair-lock-r",
  "lena-hair-bang-l", "lena-hair-bang-r",
  "lena-hair-back-sway-l", "lena-hair-back-sway-r",
  "lena-ahoge",
  "lena-collar", "lena-collar-clasp",
  "lena-cape-l", "lena-cape-r",
  "lena-chest-star",
  "lena-blush",
  ...MOUTH_SHAPES.map((m) => `lena-mouth-${m}`),
] as const;

/**
 * A live binding onto one inlined copy of `lena.svg`.
 *
 * Holds the element lookup and the last-written attribute values, and writes only what changed.
 */
export class LenaRig {
  readonly #el = new Map<string, SVGElement>();
  /** Last value written per element, so an unchanged frame costs no DOM work. */
  readonly #written = new Map<string, string>();
  /** Rig ids the document did not supply. Empty on healthy art; surfaced for diagnostics. */
  readonly missing: string[] = [];

  #mouth: MouthShape | null = null;

  constructor(root: ParentNode, suffix: string) {
    for (const id of DRIVEN_IDS) {
      const el = root.querySelector<SVGElement>(`#${cssEscape(suffix === "" ? id : `${id}--${suffix}`)}`);
      if (el === null) this.missing.push(id);
      else this.#el.set(id, el);
    }
  }

  /** Writes `pose` to the document, skipping every attribute whose value is unchanged. */
  apply(pose: RigPose): void {
    const headRot = clamp(pose.headRot, RANGE.headRot);
    const headDx = clamp(pose.headDx, RANGE.headDx);
    const headDy = clamp(pose.headDy, RANGE.headDy);
    // RIG.md §2: compose as `translate(dx dy) rotate(a 256 380)`, and `lena-head-back` must carry
    // the identical transform every frame -- it is the same bone, split so the back hair can sit
    // behind the body while the face sits in front of it.
    const head = `translate(${q(headDx)} ${q(headDy)}) ${rot(headRot, ORIGIN.head)}`;
    this.#set("lena-head", "transform", head);
    this.#set("lena-head-back", "transform", head);

    this.#set("lena-eye-l-lid-upper", "transform", `translate(0 ${q(clamp(pose.lidUpperL, RANGE.lidUpper))})`);
    this.#set("lena-eye-r-lid-upper", "transform", `translate(0 ${q(clamp(pose.lidUpperR, RANGE.lidUpper))})`);
    this.#set("lena-eye-l-lid-lower", "transform", `translate(0 ${q(clamp(pose.lidLowerL, RANGE.lidLower))})`);
    this.#set("lena-eye-r-lid-lower", "transform", `translate(0 ${q(clamp(pose.lidLowerR, RANGE.lidLower))})`);

    const globe = `translate(${q(clamp(pose.globeDx, RANGE.globeDx))} ${q(clamp(pose.globeDy, RANGE.globeDy))})`;
    this.#set("lena-eye-l-globe", "transform", globe);
    this.#set("lena-eye-r-globe", "transform", globe);

    const pupilK = clamp(pose.pupilScale, RANGE.pupilScale);
    this.#set("lena-eye-l-pupil", "transform", scaleAbout(pupilK, ORIGIN.pupilL));
    this.#set("lena-eye-r-pupil", "transform", scaleAbout(pupilK, ORIGIN.pupilR));

    // RIG.md §2: positive rotation drops the *inner* end of a brow, so the right brow mirrors the
    // sign of the left. One `browRot` channel therefore drives a symmetric expression.
    const browRot = clamp(pose.browRot, RANGE.browRot);
    const browDy = q(clamp(pose.browDy, RANGE.browDy));
    this.#set("lena-brow-l", "transform", `translate(0 ${browDy}) ${rot(browRot, ORIGIN.browL)}`);
    this.#set("lena-brow-r", "transform", `translate(0 ${browDy}) ${rot(-browRot, ORIGIN.browR)}`);

    // Hair: one phase, opposed signs left/right, so the mass reads as swaying rather than rotating.
    const lockRot = clamp(pose.lockRot, RANGE.lockRot);
    this.#set("lena-hair-lock-l", "transform", rot(lockRot, ORIGIN.lockL));
    this.#set("lena-hair-lock-r", "transform", rot(-lockRot, ORIGIN.lockR));
    const bangRot = clamp(pose.bangRot, RANGE.bangRot);
    this.#set("lena-hair-bang-l", "transform", rot(bangRot, ORIGIN.bangL));
    this.#set("lena-hair-bang-r", "transform", rot(-bangRot, ORIGIN.bangR));
    const backRot = clamp(pose.backSwayRot, RANGE.backSwayRot);
    this.#set("lena-hair-back-sway-l", "transform", rot(backRot, ORIGIN.backSwayL));
    this.#set("lena-hair-back-sway-r", "transform", rot(-backRot, ORIGIN.backSwayR));

    // RIG.md §2: scale first, rotate second, and never a bare `scale(k)` -- that scales about the
    // viewBox origin and flings the loop off the head.
    const ahogeK = clamp(pose.ahogeScale, RANGE.ahogeScale);
    const ahogeA = clamp(pose.ahogeRot, RANGE.ahogeRot);
    this.#set("lena-ahoge", "transform", `${scaleAbout(ahogeK, ORIGIN.ahoge)} ${rot(ahogeA, ORIGIN.ahoge)}`);

    this.#set("lena-collar", "transform", `translate(0 ${q(clamp(pose.collarDy, RANGE.collarDy))})`);
    const capeRot = clamp(pose.capeRot, RANGE.capeRot);
    this.#set("lena-cape-l", "transform", rot(capeRot, ORIGIN.capeL));
    this.#set("lena-cape-r", "transform", rot(-capeRot, ORIGIN.capeR));

    this.#set(
      "lena-chest-star",
      "transform",
      `${scaleAbout(clamp(pose.starScale, RANGE.starScale), ORIGIN.star)} ${rot(pose.starRot, ORIGIN.star)}`,
    );
    this.#set("lena-collar-clasp", "transform", scaleAbout(clamp(pose.claspScale, RANGE.claspScale), ORIGIN.clasp));

    // The blush's base alpha is baked into its gradient; the group opacity multiplies it.
    this.#set("lena-blush", "opacity", String(q(clamp(pose.blushOpacity, RANGE.blushOpacity))));

    this.#setMouth(pose.mouth);
  }

  /** Restores the art's authored rest state. Used when reduced motion is on and on teardown. */
  reset(): void {
    this.apply(NEUTRAL_POSE);
  }

  #setMouth(shape: MouthShape): void {
    if (shape === this.#mouth) return;
    this.#mouth = shape;
    for (const candidate of MOUTH_SHAPES) {
      this.#el.get(`lena-mouth-${candidate}`)?.setAttribute(
        "display",
        candidate === shape ? "inline" : "none",
      );
    }
  }

  #set(id: string, attr: string, value: string): void {
    const key = `${id}.${attr}`;
    if (this.#written.get(key) === value) return;
    this.#written.set(key, value);
    this.#el.get(id)?.setAttribute(attr, value);
  }
}

/** `CSS.escape` is unavailable in jsdom-less environments; the rig's ids need no escaping anyway. */
function cssEscape(id: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(id) : id;
}
