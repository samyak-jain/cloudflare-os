/**
 * The avatar view: one baked portrait per state, cross-dissolved on every state change.
 *
 * Presentational only -- it does not know where the state came from, which is what keeps the
 * renderer swappable (see `state.ts`). `ChatAvatar.tsx` is the piece that binds it to the chat.
 *
 * ## Why a crossfade and not a rig
 *
 * v1 drove a hand-authored SVG skeleton. The states were legible in the code and nearly identical
 * on screen, because the ceiling was the authoring method, not the rig. The v2 art is eleven
 * image-model *edits of one anchor frame*, so the whole set registers within a few pixels: eyes,
 * hair silhouette and coat all land in the same place. That property is what makes a plain opacity
 * cross-dissolve read as Lena moving rather than as two pictures swapping -- the only things that
 * actually change across the dissolve are the parts the art changed.
 *
 * ## Why nothing moves while a state holds
 *
 * The first v2 cut carried two ambient CSS animations: a ~4.6 s breathing `scale` and a ~1.1 deg
 * head-tilt `rotate` every ~11 s. Both were compositor-only and cost no main-thread time, and both
 * had to go, because "costs no CPU" is not the same as "costs nothing".
 *
 * A baked portrait is a *raster*. Any transform other than an identity one resamples it, and the
 * art arrives at 384 px to be drawn at 72, so the resample is a 5x downscale with real detail to
 * lose. Measured in Chromium on the QA harness at the 96 px the header used to ask for, so the
 * numbers are against the build that shipped:
 *
 * | | high-frequency energy | per-frame edge motion (p99, 33 ms) |
 * | --- | --- | --- |
 * | at rest | 7619, identical on every sample | 0 |
 * | breathing | -- | 6 luma levels, forever |
 * | mid head-tilt | 7067 (**-7 %**), ramping over ~3 s | 38 luma levels |
 *
 * So the tilt softened the whole frame for three seconds out of every eleven and then sharpened it
 * back, and the breath kept every edge in the picture crawling sub-pixel the entire time it was on
 * screen. Together that is what an operator reported as "a lot of blurring and glitching". The
 * breath's amplitude was also mis-described as sub-pixel: `scale(1.018)` about a top-edge origin
 * moves the *bottom* of a 96 px frame by ~1.7 px.
 *
 * Neither could be rescued by tuning. A rotation resamples every pixel at any non-zero angle, and a
 * continuous scale or translate passes through fractional device-pixel offsets whatever its
 * amplitude. So the portrait now carries no transform at all: it is rasterized once, composited
 * 1:1, and stays bit-identical for as long as the state holds. Life comes from the state changes
 * themselves and from the status pill beside her, which are the moments that mean something anyway.
 *
 * `prefers-reduced-motion: reduce` turns the dissolve into a cut, following the OS setting live.
 */

import { useEffect, useRef, useState } from "react";
import type { AvatarPortraitKey } from "./portraits";
import { describeAvatarState, type AvatarStateSnapshot } from "./state";

/**
 * Crossfade duration.
 *
 * Every frame in the set is opaque and covers the crop, so at dissolve progress `p` the screen
 * shows `p x incoming + (1-p) x outgoing` -- a true cross-dissolve with no dip to the backdrop. The
 * cost is that while `p` is near 0.5 the two *poses* double-expose: idle -> thinking shows a
 * translucent phantom arm, talking -> error a doubled pair of fists. That is the other half of the
 * "glitching" report, and unlike the ambient motion it is inherent to dissolving between poses.
 *
 * It can only be made shorter and steeper. 180 ms with a symmetric ease that whips through the
 * middle leaves 24 ms inside the worst band (opacity 0.25-0.75), against 63 ms for the 260 ms
 * `cubic-bezier(0.33, 0, 0.2, 1)` this replaces -- a 2.6x cut -- while the eased ends keep it from
 * reading as a hard cut.
 */
const CROSSFADE_MS = 180;
const CROSSFADE_EASE = "cubic-bezier(0.8, 0, 0.2, 1)";

/**
 * Cap on stacked crossfade layers.
 *
 * Each state change pushes a layer that fades in over the ones below and then collapses the stack
 * on `animationend`. States changing faster than the fade can therefore stack -- `mapping.ts`'s
 * dwell hysteresis makes that rare, but "rare" is not "never" and an uncapped stack is a leak.
 * Anything below the top few layers is fully covered.
 */
const MAX_LAYERS = 4;

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * The art's own backdrop, as a CSS gradient, sampled from the frames.
 *
 * Shown before the art chunk lands, so the load is a fill-in rather than a flash of empty circle.
 * The frames are opaque and cover the whole crop, so this is never visible once they are up.
 */
const BACKDROP =
  "radial-gradient(circle at 50% 42%, #f2ecf9 0%, #e3dcf1 56%, #d0cae6 100%)";

const MOTION_STYLE_ID = "lena-avatar-motion";

/**
 * The one keyframe, injected once into `document.head`.
 *
 * A `<style>` element rather than a stylesheet import because the QA harness page loads no CSS at
 * all, and a dissolve that only runs inside the app is a dissolve whose timing never gets
 * reviewed. Inline styles cannot express `@keyframes`, so this is the cheap way to have both.
 */
const MOTION_KEYFRAMES = `
@keyframes lena-portrait-in { from { opacity: 0 } to { opacity: 1 } }
`;

function ensureMotionKeyframes(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(MOTION_STYLE_ID) !== null) return;
  const style = document.createElement("style");
  style.id = MOTION_STYLE_ID;
  style.textContent = MOTION_KEYFRAMES;
  document.head.append(style);
}

/** `override` wins when given, so the harness can preview reduced motion without OS settings. */
function usePrefersReducedMotion(override?: boolean): boolean {
  const [preferred, setPreferred] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(REDUCED_MOTION_QUERY);
    setPreferred(media.matches);
    const onChange = (event: MediaQueryListEvent) => setPreferred(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  return override ?? preferred;
}

/** One drawn frame on the stack. `id` rather than the key, so a repeat of a state gets its own. */
type PortraitLayer = { id: number; portrait: AvatarPortraitKey; src: string };

type ArtModule = typeof import("./portraits");

export type LenaAvatarProps = {
  snapshot: AvatarStateSnapshot;
  /**
   * Rendered diameter in CSS pixels. The art is vendored at 384 px, so anything up to 384 is
   * sharp on a 1x display and up to 128 on a 3x one; the presence bubble asks for 72.
   */
  size?: number;
  className?: string;
  /** Force reduced motion on or off. Unset (the default) follows the OS setting. QA only. */
  reducedMotion?: boolean;
};

export default function LenaAvatar(
  { snapshot, size = 72, className = "", reducedMotion }: LenaAvatarProps,
) {
  const [art, setArt] = useState<ArtModule | null>(null);
  const [layers, setLayers] = useState<PortraitLayer[]>([]);
  const nextLayerId = useRef(0);
  const still = usePrefersReducedMotion(reducedMotion);

  useEffect(ensureMotionKeyframes, []);

  // The art table is a dynamic import so its eleven asset URLs -- and the ~310 KB behind them --
  // stay out of the initial bundle. It pulls the whole set into the browser cache on arrival, so
  // that after this one await no state change can ever dissolve into a half-loaded frame.
  useEffect(() => {
    let cancelled = false;
    void import("./portraits").then((module) => {
      if (cancelled) return;
      module.preloadAvatarPortraits();
      setArt(module);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const portrait = art === null ? null : art.portraitKeyFor(snapshot.state);

  useEffect(() => {
    if (art === null || portrait === null) return;
    setLayers((previous) => {
      if (previous[previous.length - 1]?.portrait === portrait) return previous;
      const layer = {
        id: nextLayerId.current++,
        portrait,
        src: art.AVATAR_PORTRAITS[portrait],
      };
      return still ? [layer] : [...previous, layer].slice(-MAX_LAYERS);
    });
  }, [art, portrait, still]);

  // Turning reduced motion on mid-dissolve: drop to the destination frame rather than letting the
  // fade that is already running finish.
  useEffect(() => {
    if (!still) return;
    setLayers((previous) => (previous.length > 1 ? previous.slice(-1) : previous));
  }, [still]);

  /** Collapse the stack once the top layer is fully opaque; ignore fades overtaken by a newer one. */
  const onLayerShown = (id: number) => {
    setLayers((previous) => (
      previous[previous.length - 1]?.id === id && previous.length > 1
        ? previous.slice(-1)
        : previous
    ));
  };

  const label = `Lena — ${describeAvatarState(snapshot.state)}`;

  return (
    <div
      className={`relative flex-shrink-0 ${className}`}
      // The circle crop is inline rather than a utility class: the QA harness page loads no
      // stylesheet, and a square Lena is a visibly different design, not a degraded one.
      style={{
        // `position` inline as well as in the class list: the stacked frames are absolutely
        // positioned, and on the QA harness page -- which loads no stylesheet at all -- Tailwind's
        // `relative` does not exist, so they would escape to the viewport and the crop would show a
        // window onto a full-screen Lena.
        position: "relative",
        width: size,
        height: size,
        background: BACKDROP,
        borderRadius: "50%",
        overflow: "hidden",
        // Safari otherwise paints the stacked layers below over the rounded corners.
        isolation: "isolate",
      }}
      role="img"
      aria-label={label}
      title={label}
      data-avatar-state={snapshot.state.kind}
      data-avatar-work={snapshot.state.kind === "working" ? snapshot.state.work : undefined}
      data-avatar-portrait={portrait ?? undefined}
      data-avatar-still={still ? "true" : undefined}
    >
      {layers.map((layer) => (
        <img
          key={layer.id}
          src={layer.src}
          alt=""
          draggable={false}
          data-avatar-layer={layer.portrait}
          onAnimationEnd={() => onLayerShown(layer.id)}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            // The filter belongs to the frame, so it dissolves in and out with it.
            filter: art?.AVATAR_PORTRAIT_FILTERS[layer.portrait],
            animation: still
              ? undefined
              : `${CROSSFADE_MS}ms lena-portrait-in ${CROSSFADE_EASE} both`,
          }}
        />
      ))}
    </div>
  );
}
