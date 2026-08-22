import { describe, expect, it } from "vitest";
import {
  AVATAR_PORTRAIT_FILTERS,
  AVATAR_PORTRAIT_KEYS,
  AVATAR_PORTRAITS,
  portraitKeyFor,
  type AvatarPortraitKey,
} from "./portraits";
import type { AvatarState, AvatarWorkKind } from "./state";

const WORK_KINDS: AvatarWorkKind[] = ["read", "write", "browse", "execute"];

/** Every state the machine can publish, so the mapping below is exhaustive by construction. */
const EVERY_STATE: AvatarState[] = [
  { kind: "idle" },
  { kind: "listening" },
  { kind: "thinking" },
  { kind: "talking" },
  ...WORK_KINDS.map((work): AvatarState => ({ kind: "working", work })),
  { kind: "error" },
  { kind: "done" },
  { kind: "paused" },
];

describe("portraitKeyFor", () => {
  it("maps every state to a key the art table has a frame for", () => {
    for (const state of EVERY_STATE) {
      const key = portraitKeyFor(state);
      expect(AVATAR_PORTRAITS[key], `${key} has no frame`).toBeTruthy();
    }
  });

  it("splits `working` by kind and passes every other state through by name", () => {
    expect(portraitKeyFor({ kind: "idle" })).toBe("idle");
    expect(portraitKeyFor({ kind: "paused" })).toBe("paused");
    for (const work of WORK_KINDS) {
      expect(portraitKeyFor({ kind: "working", work })).toBe(`working-${work}`);
    }
  });

  it("gives no two states the same frame", () => {
    const keys = EVERY_STATE.map(portraitKeyFor);
    expect(new Set(keys).size).toBe(EVERY_STATE.length);
    // The four working kinds separate on props, not expression, so a duplicated URL here would be
    // a silently indistinguishable pair rather than an obvious bug -- worth asserting.
    const urls = keys.map((key) => AVATAR_PORTRAITS[key]);
    expect(new Set(urls).size).toBe(keys.length);
  });
});

describe("the art table", () => {
  it("lists exactly the frames it ships, once each", () => {
    expect(AVATAR_PORTRAIT_KEYS.toSorted()).toEqual(Object.keys(AVATAR_PORTRAITS).toSorted());
    expect(new Set(AVATAR_PORTRAIT_KEYS).size).toBe(AVATAR_PORTRAIT_KEYS.length);
  });

  it("points every key at its own `.webp`", () => {
    for (const key of AVATAR_PORTRAIT_KEYS) {
      expect(AVATAR_PORTRAITS[key]).toMatch(new RegExp(`${key}\\.\\w*\\.?webp$`));
    }
  });

  it("desaturates `paused` and nothing else", () => {
    expect(Object.keys(AVATAR_PORTRAIT_FILTERS)).toEqual(["paused"]);
    expect(AVATAR_PORTRAIT_FILTERS.paused).toContain("saturate");
  });

  it("keeps the reachable-state set and the frame set the same size", () => {
    const reachable = new Set<AvatarPortraitKey>(EVERY_STATE.map(portraitKeyFor));
    expect(reachable.size).toBe(AVATAR_PORTRAIT_KEYS.length);
  });
});
