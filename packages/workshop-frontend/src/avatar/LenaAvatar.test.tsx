// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import LenaAvatar from "./LenaAvatar";
import { AVATAR_PORTRAITS } from "./portraits";
import type { AvatarState, AvatarStateSnapshot } from "./state";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function snapshot(state: AvatarState, since = 0): AvatarStateSnapshot {
  return { state, since };
}

/** jsdom has no `matchMedia`; install one whose `matches` can be flipped mid-test. */
function stubReducedMotion(matches: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const media = {
    matches,
    addEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    },
  };
  (window as { matchMedia?: unknown }).matchMedia = () => media as unknown as MediaQueryList;
  return {
    set(next: boolean) {
      media.matches = next;
      for (const listener of listeners) listener({ matches: next } as MediaQueryListEvent);
    },
  };
}

describe("LenaAvatar", () => {
  let root: Root;
  let container: HTMLDivElement;

  /** The art table is a dynamic import; give its promise a turn before asserting on frames. */
  const render = async (props: Parameters<typeof LenaAvatar>[0]) => {
    await act(async () => root.render(<LenaAvatar {...props} />));
    await act(async () => {});
  };

  const frames = () => [...container.querySelectorAll("img")];
  const shown = () => frames().map((img) => img.dataset.avatarLayer);
  /** jsdom runs no CSS, so the fade that would collapse the stack has to be delivered by hand. */
  const finishFade = async () => {
    const top = frames().at(-1);
    await act(async () => {
      top?.dispatchEvent(new Event("animationend", { bubbles: true }));
    });
  };

  beforeEach(() => {
    stubReducedMotion(false);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (window as { matchMedia?: unknown }).matchMedia;
  });

  it("draws the frame for the state, and the right one for each working kind", async () => {
    await render({ snapshot: snapshot({ kind: "idle" }) });
    expect(shown()).toEqual(["idle"]);
    expect(frames()[0]!.getAttribute("src")).toBe(AVATAR_PORTRAITS.idle);

    for (const work of ["read", "write", "browse", "execute"] as const) {
      await render({ snapshot: snapshot({ kind: "working", work }, 1) });
      await finishFade();
      expect(shown()).toEqual([`working-${work}`]);
    }
  });

  it("exposes the state on the host for the harness and for screenshots", async () => {
    await render({ snapshot: snapshot({ kind: "working", work: "browse" }) });
    const host = container.firstElementChild as HTMLElement;
    expect(host.getAttribute("role")).toBe("img");
    expect(host.getAttribute("aria-label")).toBe("Lena — Working (browse)");
    expect(host.dataset.avatarState).toBe("working");
    expect(host.dataset.avatarWork).toBe("browse");
    expect(host.dataset.avatarPortrait).toBe("working-browse");
  });

  it("crossfades by stacking the incoming frame over the outgoing one, then collapsing", async () => {
    await render({ snapshot: snapshot({ kind: "idle" }) });
    await finishFade();
    expect(shown()).toEqual(["idle"]);

    await render({ snapshot: snapshot({ kind: "talking" }, 1) });
    // Both frames are mounted: the old one is what the new one dissolves *out of*.
    expect(shown()).toEqual(["idle", "talking"]);
    expect(frames().at(-1)!.style.animation).toContain("lena-portrait-in");

    await finishFade();
    expect(shown()).toEqual(["talking"]);
  });

  it("does not restack when the same state is re-published", async () => {
    await render({ snapshot: snapshot({ kind: "thinking" }) });
    await finishFade();
    await render({ snapshot: snapshot({ kind: "thinking" }, 99) });
    expect(shown()).toEqual(["thinking"]);
  });

  it("caps the stack when states change faster than the fade", async () => {
    const order: AvatarState[] = [
      { kind: "idle" },
      { kind: "listening" },
      { kind: "thinking" },
      { kind: "talking" },
      { kind: "working", work: "read" },
      { kind: "done" },
    ];
    for (const [index, state] of order.entries()) {
      await render({ snapshot: snapshot(state, index) });
    }
    expect(frames().length).toBeLessThanOrEqual(4);
    expect(shown().at(-1)).toBe("done");
  });

  it("desaturates `paused` at runtime and leaves every other frame alone", async () => {
    await render({ snapshot: snapshot({ kind: "paused" }) });
    expect(frames().at(-1)!.style.filter).toContain("saturate");

    await render({ snapshot: snapshot({ kind: "idle" }, 1) });
    await finishFade();
    expect(frames().at(-1)!.style.filter).toBe("");
  });

  // The v2.1 fix for "a lot of blurring and glitching": a baked portrait is a raster, and the
  // ambient breathe/bob transforms resampled it continuously. Nothing may transform a frame.
  it("never transforms a frame, so the raster is composited untouched", async () => {
    await render({ snapshot: snapshot({ kind: "idle" }) });
    expect(container.querySelectorAll("[data-avatar-motion]")).toHaveLength(0);

    const keyframes = document.getElementById("lena-avatar-motion")?.textContent ?? "";
    expect(keyframes).toContain("@keyframes lena-portrait-in");
    expect(keyframes).not.toContain("lena-breathe");
    expect(keyframes).not.toContain("lena-bob");

    for (const element of [container.firstElementChild!, ...frames()]) {
      const style = (element as HTMLElement).style;
      expect(style.transform).toBe("");
      expect(style.willChange).toBe("");
    }
  });

  it("dissolves fast enough that the two poses barely double-expose", async () => {
    await render({ snapshot: snapshot({ kind: "idle" }) });
    await finishFade();
    await render({ snapshot: snapshot({ kind: "thinking" }, 1) });

    const animation = frames().at(-1)!.style.animation;
    expect(animation).toContain("180ms");
    // Symmetric and steep through the middle: it is the time spent near opacity 0.5, not the
    // duration, that shows a phantom arm.
    expect(animation).toContain("cubic-bezier(0.8, 0, 0.2, 1)");
  });

  describe("under prefers-reduced-motion", () => {
    beforeEach(() => stubReducedMotion(true));

    it("holds still and cuts instead of fading", async () => {
      await render({ snapshot: snapshot({ kind: "idle" }) });
      const host = container.firstElementChild as HTMLElement;
      expect(host.dataset.avatarStill).toBe("true");
      expect(frames()[0]!.style.animation).toBe("");

      await render({ snapshot: snapshot({ kind: "error" }, 1) });
      // One frame, not two: nothing to dissolve out of, because nothing dissolved.
      expect(shown()).toEqual(["error"]);
    });

    it("still shows the right frame, including the paused filter", async () => {
      await render({ snapshot: snapshot({ kind: "paused" }) });
      expect(shown()).toEqual(["paused"]);
      expect(frames()[0]!.style.filter).toContain("saturate");
    });
  });

  it("drops to the destination frame when reduced motion turns on mid-fade", async () => {
    const media = stubReducedMotion(false);
    await render({ snapshot: snapshot({ kind: "idle" }) });
    await finishFade();
    await render({ snapshot: snapshot({ kind: "done" }, 1) });
    expect(shown()).toEqual(["idle", "done"]);

    await act(async () => media.set(true));
    expect(shown()).toEqual(["done"]);
  });
});
