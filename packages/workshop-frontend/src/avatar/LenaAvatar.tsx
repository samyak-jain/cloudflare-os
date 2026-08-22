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
 * ## Motion
 *
 * Everything that moves here is a CSS animation on a `transform` or an `opacity`, so it runs on
 * the compositor and costs no main-thread time at all: no rAF loop, no per-frame attribute writes,
 * nothing for React to re-render. (v1's rAF renderer measured 0.69 % of a main thread at idle,
 * almost all of it rasterizing the SVG. A composited transform on an already-decoded 384 px raster
 * is well under that.) The browser also throttles these on its own while the tab is hidden.
 *
 * Two layers of life, both chosen because they work on a *static* frame -- no blink, because the
 * art has open eyes baked in and faking one would need a second frame per state:
 *
 * - **Breathing.** A ~4.6 s scale oscillation of well under a pixel at 96 px. Invisible when you
 *   look at it and unmistakable when it stops.
 * - **The bob.** A slow head-tilt every ~11 s, at rest for most of the cycle. A continuous bob
 *   reads as a bouncing GIF; one that mostly sits still reads as someone sitting there.
 *
 * Both are shaped so they can never uncover the backdrop inside the circle crop, which is why the
 * bob is a rotation and not a translation. The distance from a square's centre to each of its edges
 * does not change when it rotates, so a square rotated about its centre always still contains its
 * own inscribed circle -- whereas any translation slides an edge across the crop and exposes a
 * crescent of background. For the same reason `breathe` scales from the *top* edge (`50% 0%`): it
 * grows down and outward and never lifts the top of the head into the crop. `BOB_MARGIN` covers the
 * four points where a pure rotation is exactly tangent to the circle.
 *
 * Under `prefers-reduced-motion: reduce` both stop and the crossfade becomes a cut.
 */

import { useEffect, useRef, useState } from "react";
import type { AvatarPortraitKey } from "./portraits";
import { describeAvatarState, type AvatarStateSnapshot } from "./state";

/** Crossfade duration. Long enough to read as a dissolve, short enough to keep the UI responsive. */
const CROSSFADE_MS = 260;

/** Breathing period (one direction; the animation alternates, so a full breath is twice this). */
const BREATHE_S = 4.6;

/** Bob period. Most of it is the rest hold in the keyframes below. */
const BOB_S = 11;

/**
 * Uniform scale carried by the bob, so a rotation that is exactly tangent to the circle crop
 * cannot leave an antialiased hairline of backdrop at the four tangent points.
 */
const BOB_MARGIN = 1.006;

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
 * The keyframes, injected once into `document.head`.
 *
 * A `<style>` element rather than a stylesheet import because the QA harness page loads no CSS at
 * all, and an avatar that only breathes inside the app is an avatar whose motion never gets
 * reviewed. Inline styles cannot express `@keyframes`, so this is the cheap way to have both.
 */
const MOTION_KEYFRAMES = `
@keyframes lena-portrait-in { from { opacity: 0 } to { opacity: 1 } }
@keyframes lena-breathe { from { transform: scale(1) } to { transform: scale(1.018) } }
@keyframes lena-bob {
  0%, 58% { transform: scale(${BOB_MARGIN}) rotate(0deg) }
  73% { transform: scale(${BOB_MARGIN}) rotate(-1.1deg) }
  87% { transform: scale(${BOB_MARGIN}) rotate(0.3deg) }
  100% { transform: scale(${BOB_MARGIN}) rotate(0deg) }
}
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
   * sharp on a 1x display and up to 192 on a 2x one; the chat header asks for 96.
   */
  size?: number;
  className?: string;
  /** Force reduced motion on or off. Unset (the default) follows the OS setting. QA only. */
  reducedMotion?: boolean;
};

export default function LenaAvatar(
  { snapshot, size = 96, className = "", reducedMotion }: LenaAvatarProps,
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
  const motion = still ? undefined : "transform";

  return (
    <div
      className={`relative flex-shrink-0 ${className}`}
      // The circle crop is inline rather than a utility class: the QA harness page loads no
      // stylesheet, and a square Lena is a visibly different design, not a degraded one.
      style={{
        width: size,
        height: size,
        background: BACKDROP,
        borderRadius: "50%",
        overflow: "hidden",
        // Safari otherwise paints the composited layers below over the rounded corners.
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
      {/* Bob outside breathe: two animations, both on `transform`, so they cannot share a node. */}
      <div
        aria-hidden
        data-avatar-motion="bob"
        style={{
          width: "100%",
          height: "100%",
          willChange: motion,
          animation: still ? undefined : `${BOB_S}s lena-bob ease-in-out infinite`,
        }}
      >
        <div
          data-avatar-motion="breathe"
          style={{
            position: "relative",
            width: "100%",
            height: "100%",
            willChange: motion,
            transformOrigin: "50% 0%",
            animation: still
              ? undefined
              : `${BREATHE_S}s lena-breathe ease-in-out infinite alternate`,
          }}
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
                  : `${CROSSFADE_MS}ms lena-portrait-in cubic-bezier(0.33, 0, 0.2, 1) both`,
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
