import { describe, expect, it } from "vitest";
import { bindingOf, getAtPath, parsePath, resolveProps, setAtPath } from "./bind";

describe("parsePath", () => {
  it("rejects the shapes that make a write ambiguous", () => {
    expect(parsePath("")).toBeNull();
    expect(parsePath(".a")).toBeNull();
    expect(parsePath("a..b")).toBeNull();
    expect(parsePath("a.b")).toEqual(["a", "b"]);
  });
});

describe("getAtPath", () => {
  const state = { name: "lena", filters: { region: "eu", tags: ["a", "b"] }, count: 0 };

  it("reads nested values, including through arrays", () => {
    expect(getAtPath(state, "name")).toBe("lena");
    expect(getAtPath(state, "filters.region")).toBe("eu");
    expect(getAtPath(state, "filters.tags.1")).toBe("b");
    expect(getAtPath(state, "count")).toBe(0);
  });

  it("answers undefined rather than throwing on a path that isn't there", () => {
    expect(getAtPath(state, "missing.deeply.nested")).toBeUndefined();
    expect(getAtPath(state, "name.length")).toBeUndefined();
    expect(getAtPath(state, "")).toBeUndefined();
  });
});

describe("setAtPath", () => {
  it("writes without mutating, sharing every untouched subtree", () => {
    const state = { a: { x: 1 }, b: { y: 2 } };
    const next = setAtPath(state, "a.x", 9);

    expect(next).toEqual({ a: { x: 9 }, b: { y: 2 } });
    expect(state.a.x).toBe(1);
    expect(next.b).toBe(state.b);
    expect(next.a).not.toBe(state.a);
  });

  it("creates missing containers on the way down", () => {
    expect(setAtPath({}, "filters.region", "eu")).toEqual({ filters: { region: "eu" } });
  });

  it("writes into arrays by index", () => {
    const next = setAtPath({ tags: ["a", "b"] }, "tags.1", "c");
    expect(next).toEqual({ tags: ["a", "c"] });
    expect(Array.isArray((next as { tags: unknown }).tags)).toBe(true);
  });

  it("replaces a container the path disagrees with rather than failing the write", () => {
    expect(setAtPath({ a: 5 }, "a.b", 1)).toEqual({ a: { b: 1 } });
    expect(setAtPath({ a: ["x"] }, "a.name", 1)).toEqual({ a: { name: 1 } });
  });

  it("leaves the state alone for an unusable path", () => {
    const state = { a: 1 };
    expect(setAtPath(state, "", 2)).toBe(state);
  });
});

describe("resolveProps", () => {
  const state = { name: "lena", nested: { on: true } };

  it("substitutes bindings and leaves literals alone", () => {
    expect(resolveProps({ value: { $bind: "name" }, label: "Name" }, state))
      .toEqual({ value: "lena", label: "Name" });
    expect(resolveProps({ checked: { $bind: "nested.on" } }, state)).toEqual({ checked: true });
  });

  it("resolves a binding to undefined when its path is empty", () => {
    expect(resolveProps({ value: { $bind: "nope" } }, state)).toEqual({ value: undefined });
  });

  it("returns the same object when nothing is bound", () => {
    const props = { label: "Name" };
    expect(resolveProps(props, state)).toBe(props);
  });
});

describe("bindingOf", () => {
  it("reports the bound path, and nothing for a literal", () => {
    expect(bindingOf({ value: { $bind: "a.b" } }, "value")).toBe("a.b");
    expect(bindingOf({ value: "a.b" }, "value")).toBeUndefined();
    expect(bindingOf({}, "value")).toBeUndefined();
  });
});
