// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import ART from "./art/lena.svg?raw";
import { LenaRig, NEUTRAL_POSE, namespaceRigIds, type RigPose } from "./rig";
import { blinkLid } from "./renderer";
import { statePose } from "./poses";
import type { AvatarState } from "./state";

function mount(suffix: string): { host: HTMLElement; rig: LenaRig } {
  const host = document.createElement("div");
  host.innerHTML = namespaceRigIds(ART, suffix);
  document.body.append(host);
  return { host, rig: new LenaRig(host, suffix) };
}

function transformOf(host: HTMLElement, id: string, suffix: string): string | null {
  return host.querySelector(`#${id}--${suffix}`)?.getAttribute("transform") ?? null;
}

describe("namespaceRigIds", () => {
  it("rewrites ids and every reference that points at them", () => {
    const out = namespaceRigIds(ART, "a1");
    expect(out).toContain('id="lena-head--a1"');
    expect(out).toContain("url(#lena-clip-socket-l--a1)");
    expect(out).toContain('aria-labelledby="lena-title--a1 lena-desc--a1"');
    // Nothing may be left pointing at an un-suffixed id, or two instances would cross-wire.
    const refs = [...out.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.filter((id) => !id.endsWith("--a1"))).toEqual([]);
  });

  it("leaves the art untouched for the un-namespaced case", () => {
    expect(namespaceRigIds(ART, "")).toBe(ART);
  });
});

describe("LenaRig", () => {
  it("binds every id it drives", () => {
    const { rig } = mount("bind");
    expect(rig.missing).toEqual([]);
  });

  it("keeps head and head-back on the identical transform", () => {
    const { host, rig } = mount("head");
    rig.apply({ ...NEUTRAL_POSE, headRot: 7, headDx: 2, headDy: -3 });
    const head = transformOf(host, "lena-head", "head");
    expect(head).toBe("translate(2 -3) rotate(7 256 380)");
    expect(transformOf(host, "lena-head-back", "head")).toBe(head);
  });

  it("clamps every channel into RIG.md's verified safe range", () => {
    const { host, rig } = mount("clamp");
    rig.apply({ ...NEUTRAL_POSE, headRot: 90, lidUpperL: 500, ahogeRot: -180, ahogeScale: 4 });
    expect(transformOf(host, "lena-head", "clamp")).toContain("rotate(12 256 380)");
    expect(transformOf(host, "lena-eye-l-lid-upper", "clamp")).toBe("translate(0 56)");
    expect(transformOf(host, "lena-ahoge", "clamp"))
      .toBe("translate(258 72) scale(1.12) translate(-258 -72) rotate(-22 258 72)");
  });

  it("composes the ahoge scale before the rotate, about the strand root", () => {
    // RIG.md §2: a bare `scale(k)` scales about the viewBox origin and flings the loop off the head.
    const { host, rig } = mount("ahoge");
    rig.apply({ ...NEUTRAL_POSE, ahogeRot: 10, ahogeScale: 1.1 });
    expect(transformOf(host, "lena-ahoge", "ahoge"))
      .toBe("translate(258 72) scale(1.1) translate(-258 -72) rotate(10 258 72)");
  });

  it("mirrors the brow rotation sign across the two sides", () => {
    const { host, rig } = mount("brow");
    rig.apply({ ...NEUTRAL_POSE, browRot: 12, browDy: 3 });
    expect(transformOf(host, "lena-brow-l", "brow")).toBe("translate(0 3) rotate(12 150 197)");
    expect(transformOf(host, "lena-brow-r", "brow")).toBe("translate(0 3) rotate(-12 362 197)");
  });

  it("keeps exactly one mouth visible", () => {
    const { host, rig } = mount("mouth");
    rig.apply({ ...NEUTRAL_POSE, mouth: "open" });
    const visible = ["closed", "half", "open", "smile", "frown"].filter(
      (m) => host.querySelector(`#lena-mouth-${m}--mouth`)?.getAttribute("display") !== "none",
    );
    expect(visible).toEqual(["open"]);
  });
});

describe("blinkLid", () => {
  it("closes fully and reopens over the documented 220 ms", () => {
    expect(blinkLid(0)).toBe(0);
    expect(blinkLid(0.07)).toBe(56); // closed at 70 ms
    expect(blinkLid(0.1)).toBe(56); // still held
    expect(blinkLid(0.22)).toBe(0); // open again at 220 ms
  });

  it("is asymmetric: the close accelerates, the open decelerates", () => {
    // Half-way through the close, less than half the travel is done (ease-in).
    expect(blinkLid(0.035)).toBeLessThan(28);
    // Half-way through the open, more than half the travel is done (ease-out).
    expect(blinkLid(0.11 + 0.055)).toBeLessThan(28);
  });
});

describe("statePose", () => {
  const states: AvatarState[] = [
    { kind: "idle" }, { kind: "listening" }, { kind: "thinking" }, { kind: "talking" },
    { kind: "working", work: "read" }, { kind: "working", work: "write" },
    { kind: "working", work: "browse" }, { kind: "working", work: "execute" },
    { kind: "error" }, { kind: "done" }, { kind: "paused" },
  ];

  it("produces finite values for every state across a long span of time", () => {
    for (const state of states) {
      for (let t = 0; t < 30; t += 0.37) {
        const pose = statePose(state, t, t);
        for (const [channel, value] of Object.entries(pose)) {
          if (channel === "mouth") continue;
          expect(Number.isFinite(value as number), `${state.kind}.${channel} @ ${t}`).toBe(true);
        }
      }
    }
  });

  it("collapses to a static hold at amp = 0, which is the reduced-motion pose", () => {
    for (const state of states) {
      const a = statePose(state, 0, 10, 0);
      const b = statePose(state, 17.3, 10, 0);
      expect(a, state.kind).toEqual(b);
    }
  });

  it("gives each working kind a distinguishable gaze", () => {
    // The four kinds have to be told apart at 96 px, where the eyes carry the read.
    const at = (work: "read" | "write" | "browse" | "execute", t: number): RigPose =>
      statePose({ kind: "working", work }, t, t);
    expect(at("write", 1).globeDy).toBeGreaterThan(3);
    expect(at("execute", 1).globeDx).toBe(0);
    expect(at("execute", 1).lidUpperL).toBeGreaterThan(at("browse", 1).lidUpperL);
  });
});
