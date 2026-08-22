/**
 * The avatar view: inlines `art/lena.svg` and drives it from an `AvatarStateSnapshot`.
 *
 * Presentational only -- it does not know where the state came from, which is what keeps the
 * renderer swappable (see `state.ts`). `ChatAvatar.tsx` is the piece that binds it to the chat.
 */

import { useEffect, useId, useRef, useState } from "react";
import { CROP_VIEWBOX, LenaRig, namespaceRigIds } from "./rig";
import { SvgAvatarRenderer } from "./renderer";
import { describeAvatarState, IDLE_SNAPSHOT, type AvatarStateSnapshot } from "./state";

/**
 * `lena-backdrop`'s own radial, re-projected onto the padded crop box.
 *
 * The art's gradient is `cx=0.5 cy=0.4 r=0.75` over its 512 rect; inside `CROP_VIEWBOX`'s 546 box
 * that centre lands at (50%, 43.7%) with a radius of 70.3%. Matching it exactly matters because
 * the inset leaves a thin band of this background visible around the art at the sides and top --
 * off by a few levels and that band reads as a rim rather than as more backdrop. It also makes the
 * loading placeholder a continuation of the avatar rather than a different graphic.
 */
const BACKDROP =
  "radial-gradient(ellipse 70.3% 70.3% at 50% 43.7%, #fcfbff 0%, #eee9f8 58%, #d5cceb 100%)";

export type LenaAvatarProps = {
  snapshot: AvatarStateSnapshot;
  /**
   * Rendered diameter in CSS pixels. RIG.md §5 verifies the art down to 64 px and calls 96 px
   * "still comfortable"; below 64 the mouth stops reading at all.
   */
  size?: number;
  className?: string;
};

export default function LenaAvatar(
  { snapshot, size = 96, className = "" }: LenaAvatarProps,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<SvgAvatarRenderer | null>(null);
  const mediaCleanup = useRef<(() => void) | null>(null);
  /**
   * The renderer is constructed inside an async import, so it needs the snapshot as of *that*
   * moment rather than the one captured when the mount effect ran.
   */
  const snapshotRef = useRef<AvatarStateSnapshot>(IDLE_SNAPSHOT);
  snapshotRef.current = snapshot;

  const [loaded, setLoaded] = useState(false);

  // React's `useId` produces colons, which are legal in XML but awkward in selectors and in
  // `url(#...)`. Strip to an identifier-safe fragment.
  const instance = useId().replace(/[^A-Za-z0-9_-]/g, "");

  // Mount: fetch the art, inline it, bind the rig, start the loop. The SVG is a dynamic import so
  // its ~32 KB stays out of the initial bundle -- which is also what gives the placeholder below
  // something real to cover.
  useEffect(() => {
    let cancelled = false;
    let renderer: SvgAvatarRenderer | null = null;

    void import("./art/lena.svg?raw").then(({ default: markup }) => {
      const host = hostRef.current;
      if (cancelled || host === null) return;

      host.innerHTML = namespaceRigIds(markup, instance);
      const svg = host.querySelector("svg");
      if (svg === null) return;
      // The art is authored at a fixed 512; let the box decide the size.
      svg.setAttribute("width", "100%");
      svg.setAttribute("height", "100%");
      // Inset the art so the ahoge survives the circle crop -- see CROP_VIEWBOX.
      svg.setAttribute("viewBox", CROP_VIEWBOX);
      svg.style.display = "block";

      const rig = new LenaRig(host, instance);
      if (rig.missing.length > 0) {
        console.warn("[avatar] rig ids missing from lena.svg:", rig.missing.join(", "));
      }

      const media = typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;

      renderer = new SvgAvatarRenderer(rig, { reducedMotion: media?.matches ?? false });
      rendererRef.current = renderer;
      renderer.setState(snapshotRef.current);
      renderer.start();
      setLoaded(true);

      const onChange = (event: MediaQueryListEvent) => renderer?.setReducedMotion(event.matches);
      media?.addEventListener("change", onChange);
      mediaCleanup.current = () => media?.removeEventListener("change", onChange);
    });

    return () => {
      cancelled = true;
      mediaCleanup.current?.();
      mediaCleanup.current = null;
      renderer?.destroy();
      rendererRef.current = null;
      if (hostRef.current !== null) hostRef.current.innerHTML = "";
    };
    // `instance` is stable for the component's lifetime; the art never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance]);

  useEffect(() => {
    rendererRef.current?.setState(snapshot);
  }, [snapshot]);

  const label = `Lena — ${describeAvatarState(snapshot.state)}`;

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
      }}
      role="img"
      aria-label={label}
      title={label}
      data-avatar-state={snapshot.state.kind}
      data-avatar-work={snapshot.state.kind === "working" ? snapshot.state.work : undefined}
    >
      {/*
        Static circle-crop placeholder, shown until the art chunk lands. It is the backdrop disc
        the art itself sits on (RIG.md §4), so the transition is a fill-in rather than a swap.
      */}
      {!loaded && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "50%",
            background: BACKDROP,
            boxShadow: "inset 0 0 0 1px rgba(154,144,180,0.28)",
          }}
        />
      )}
      <div ref={hostRef} style={{ width: "100%", height: "100%" }} aria-hidden />
    </div>
  );
}
