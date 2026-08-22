/**
 * Client-side re-validation of a generative-UI tree.
 *
 * The sandbox already validated this tree before it left the DO, and that validation -- not this
 * one -- is the security boundary. This pass exists because the *renderer* has to be total: a tree
 * reaching it is model output that was persisted, possibly by an older validator, possibly by a
 * deployment with a different catalog, and a card that throws inside React takes the whole
 * transcript down with it. Everything here is shape-narrowing and bounding, never trust.
 *
 * Unknown component names survive normalization on purpose (the renderer draws them as inert
 * placeholders); malformed *structure* does not.
 */

import type { GenerativeUiNode, GenerativeUiResult } from "@gadgets/workshop-shared/api";

/**
 * How deep a tree may nest before the rest is dropped.
 *
 * Well past anything a chat card should hold; it is here so a pathological tree costs a bounded
 * number of React elements rather than the stack.
 */
export const MAX_TREE_DEPTH = 24;

/** How many nodes a single card may render. Excess is dropped, breadth-first order preserved. */
export const MAX_TREE_NODES = 400;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A prop value stripped to JSON the renderer can hold.
 *
 * Anything that isn't JSON -- a function, a symbol, an RPC stub that somehow rode along -- is
 * dropped rather than passed to a component, so no path exists from a recorded tool call to a
 * callable object in the render tree.
 */
function normalizePropValue(value: unknown, depth: number): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return Number.isNaN(value) ? undefined : value;
    case "object":
      break;
    default:
      return undefined;
  }
  if (depth >= MAX_TREE_DEPTH) return undefined;
  if (Array.isArray(value)) {
    return value.map((entry) => normalizePropValue(entry, depth + 1));
  }
  if (!isPlainObject(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalized = normalizePropValue(entry, depth + 1);
    if (normalized !== undefined) {
      // DefineOwnProperty keeps a durable legacy `__proto__` key inert instead of invoking the
      // Object.prototype setter. New backend rows reject reserved keys before persistence.
      Object.defineProperty(out, key, { value: normalized, enumerable: true });
    }
  }
  return out;
}

type Budget = { remaining: number };

function normalizeNode(value: unknown, depth: number, budget: Budget): GenerativeUiNode | null {
  if (!isPlainObject(value)) return null;
  if (typeof value.type !== "string" || value.type.length === 0) return null;
  if (depth >= MAX_TREE_DEPTH || budget.remaining <= 0) return null;
  budget.remaining--;

  const props = isPlainObject(value.props)
    ? normalizePropValue(value.props, 0) as Record<string, unknown>
    : {};

  const children: (GenerativeUiNode | string)[] = [];
  if (Array.isArray(value.children)) {
    for (const child of value.children) {
      if (typeof child === "string") {
        children.push(child);
        continue;
      }
      // Numbers are the one non-string primitive JSX puts in a child position often enough to be
      // worth keeping ({count} in a Text); everything else is a malformed child and is dropped.
      if (typeof child === "number" && Number.isFinite(child)) {
        children.push(String(child));
        continue;
      }
      const node = normalizeNode(child, depth + 1, budget);
      if (node) children.push(node);
    }
  }

  return { type: value.type, props, children };
}

/**
 * A tool call's recorded `renderUI` output, narrowed to something renderable, or null if it isn't.
 *
 * Null means "show the failure chrome", not "throw": a card whose tree can't be read is a visible,
 * inert row in the transcript, which is the same thing the user sees for any other failed tool.
 */
export function normalizeGenerativeUiResult(output: unknown): GenerativeUiResult | null {
  if (!isPlainObject(output)) return null;
  const budget: Budget = { remaining: MAX_TREE_NODES };
  const tree = normalizeNode(output.tree, 0, budget);
  if (!tree) return null;

  const stateDefaults = isPlainObject(output.stateDefaults)
    ? normalizePropValue(output.stateDefaults, 0) as Record<string, unknown>
    : {};

  return {
    tree,
    stateDefaults,
    // A tree from a catalog this build doesn't know still renders; the version only drives the
    // note the card shows, so an unreadable one is reported as 0 rather than rejected.
    catalogVersion: typeof output.catalogVersion === "number" ? output.catalogVersion : 0,
    ...(typeof output.consumed === "boolean" ? { consumed: output.consumed } : {}),
  };
}
