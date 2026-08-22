import { describe, expect, it } from "vitest";
import { MAX_TREE_DEPTH, MAX_TREE_NODES, normalizeGenerativeUiResult } from "./validate";

describe("normalizeGenerativeUiResult", () => {
  it("accepts a well-formed result unchanged", () => {
    const result = normalizeGenerativeUiResult({
      tree: { type: "Stack", props: { gap: "md" }, children: [{ type: "Text", props: {}, children: ["hi"] }] },
      stateDefaults: { name: "lena" },
      catalogVersion: 1,
    });
    expect(result).toEqual({
      tree: { type: "Stack", props: { gap: "md" }, children: [{ type: "Text", props: {}, children: ["hi"] }] },
      stateDefaults: { name: "lena" },
      catalogVersion: 1,
    });
  });

  it("fills in the parts a sparse node leaves out", () => {
    expect(normalizeGenerativeUiResult({ tree: { type: "Divider" } })).toEqual({
      tree: { type: "Divider", props: {}, children: [] },
      stateDefaults: {},
      catalogVersion: 0,
    });
  });

  it("keeps an unknown component name, so a newer catalog still renders", () => {
    const result = normalizeGenerativeUiResult({
      tree: { type: "Sparkline", props: {}, children: [] },
      catalogVersion: 7,
    });
    expect(result?.tree.type).toBe("Sparkline");
    expect(result?.catalogVersion).toBe(7);
  });

  it("rejects anything that isn't a tree", () => {
    expect(normalizeGenerativeUiResult(null)).toBeNull();
    expect(normalizeGenerativeUiResult("Stack")).toBeNull();
    expect(normalizeGenerativeUiResult({})).toBeNull();
    expect(normalizeGenerativeUiResult({ tree: { props: {} } })).toBeNull();
    expect(normalizeGenerativeUiResult({ tree: { type: "" } })).toBeNull();
  });

  it("drops props that aren't JSON, so nothing callable can reach a component", () => {
    const result = normalizeGenerativeUiResult({
      tree: { type: "Button", props: { onClick: () => "boom", action: "go", nested: { fn: () => 1, ok: 2 } }, children: [] },
    });
    expect(result?.tree.props).toEqual({ action: "go", nested: { ok: 2 } });
  });

  it("keeps bindings, which are ordinary JSON objects", () => {
    const result = normalizeGenerativeUiResult({
      tree: { type: "Input", props: { value: { $bind: "name" } }, children: [] },
    });
    expect(result?.tree.props.value).toEqual({ $bind: "name" });
  });

  it("keeps numeric children as text and drops malformed ones", () => {
    const result = normalizeGenerativeUiResult({
      tree: { type: "Text", props: {}, children: ["n = ", 42, null, true, { nope: 1 }] },
    });
    expect(result?.tree.children).toEqual(["n = ", "42"]);
  });

  it("bounds depth", () => {
    let tree: unknown = { type: "Text", props: {}, children: ["deep"] };
    for (let i = 0; i < MAX_TREE_DEPTH + 5; i++) {
      tree = { type: "Stack", props: {}, children: [tree] };
    }
    let node = normalizeGenerativeUiResult({ tree })!.tree;
    let depth = 1;
    while (node.children.length > 0 && typeof node.children[0] !== "string") {
      node = node.children[0] as typeof node;
      depth++;
    }
    expect(depth).toBeLessThanOrEqual(MAX_TREE_DEPTH);
  });

  it("bounds the node count", () => {
    const children = Array.from({ length: MAX_TREE_NODES + 50 }, () => ({
      type: "Text", props: {}, children: [],
    }));
    const result = normalizeGenerativeUiResult({ tree: { type: "Stack", props: {}, children } });
    expect(result!.tree.children.length).toBe(MAX_TREE_NODES - 1);
  });

  it("treats an unreadable catalog version as unknown rather than failing the tree", () => {
    const result = normalizeGenerativeUiResult({
      tree: { type: "Text", props: {}, children: [] },
      catalogVersion: "v1",
    });
    expect(result?.catalogVersion).toBe(0);
  });
});
