import { describe, expect, it } from "vitest";
import { MAX_SKELETON_ITEMS, sketchPartialJsx } from "./jsxSkeleton";
import { PARTIAL_JSX } from "./harness/fixtures";

describe("sketchPartialJsx", () => {
  it("reads components and nesting out of a complete fragment", () => {
    expect(sketchPartialJsx('<Stack><Heading>Hi</Heading><Text>x</Text></Stack>')).toEqual([
      { type: "Stack", depth: 0 },
      { type: "Heading", depth: 1 },
      { type: "Text", depth: 1 },
    ]);
  });

  it("does not nest under a self-closing tag", () => {
    expect(sketchPartialJsx('<Stack><Divider /><Input value={x} /></Stack>')).toEqual([
      { type: "Stack", depth: 0 },
      { type: "Divider", depth: 1 },
      { type: "Input", depth: 1 },
    ]);
  });

  it("handles a fragment cut off mid-attribute, which is the whole point", () => {
    const items = sketchPartialJsx(PARTIAL_JSX);
    expect(items.map((item) => item.type)).toEqual([
      "Stack", "Heading", "Text", "Select", "Input",
    ]);
    expect(items[0].depth).toBe(0);
    expect(items[1].depth).toBe(1);
  });

  it("ignores lowercase tags, which the catalog has none of", () => {
    expect(sketchPartialJsx("<div><span>hi</span></div>")).toEqual([]);
  });

  it("never throws on garbage, and never runs away", () => {
    expect(sketchPartialJsx("")).toEqual([]);
    expect(sketchPartialJsx("<<<>>><")).toEqual([]);
    expect(sketchPartialJsx("</Stack></Stack>")).toEqual([]);
    const many = "<Text />".repeat(MAX_SKELETON_ITEMS + 20);
    expect(sketchPartialJsx(many).length).toBe(MAX_SKELETON_ITEMS);
  });

  it("clamps runaway indentation", () => {
    const deep = "<Stack>".repeat(10);
    expect(Math.max(...sketchPartialJsx(deep).map((item) => item.depth))).toBeLessThanOrEqual(3);
  });
});
