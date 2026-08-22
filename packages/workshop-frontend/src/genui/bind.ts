/**
 * Bound state: reading and writing the paths a tree's `$bind` markers name.
 *
 * A generated interface carries no behavior, only data paths (see `GenerativeUiBinding`), so this
 * module is the entire coupling between what the model wrote and what the user typed. It is pure:
 * no React, no clock, no RPC.
 *
 * Writes are immutable -- `setAtPath` returns a new tree and shares every untouched subtree -- so
 * React sees a changed identity for exactly the containers on the written path and re-renders the
 * card without a deep compare.
 */

import { isGenerativeUiBinding } from "@gadgets/workshop-shared/api";

/** A card's bound state. Plain JSON: the values came out of a sandbox as JSON and go back as JSON. */
export type BoundState = Record<string, unknown>;

/**
 * Splits a dot path into segments, rejecting the shapes that would make a write ambiguous.
 *
 * Returns null for an empty path or an empty segment (`"a..b"`, `".a"`), which a well-formed tree
 * never contains -- the sandbox validator rejects them -- but a stored tree from an older
 * validator might.
 */
export function parsePath(path: string): string[] | null {
  if (path.length === 0) return null;
  const segments = path.split(".");
  return segments.some((segment) => segment.length === 0) ? null : segments;
}

/** The value at `path`, or undefined if any segment of the way there is missing. */
export function getAtPath(state: BoundState, path: string): unknown {
  const segments = parsePath(path);
  if (!segments) return undefined;

  let cursor: unknown = state;
  for (const segment of segments) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = Array.isArray(cursor)
      ? cursor[Number(segment)]
      : (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/**
 * `state` with `path` set to `value`, structurally sharing everything off the path.
 *
 * Intermediate containers are created as objects when missing. A segment that would have to index
 * into a non-container (a path that disagrees with the defaults the tree shipped with) replaces it
 * rather than throwing: the user's keystroke is worth more than the model's idea of the shape.
 */
export function setAtPath(state: BoundState, path: string, value: unknown): BoundState {
  const segments = parsePath(path);
  if (!segments) return state;
  return writeSegments(state, segments, 0, value) as BoundState;
}

function writeSegments(
  container: unknown,
  segments: string[],
  index: number,
  value: unknown,
): unknown {
  const segment = segments[index];
  const isLast = index === segments.length - 1;

  if (Array.isArray(container)) {
    const at = Number(segment);
    // A non-numeric segment against an array means the path and the data disagree; fall through to
    // the object branch, which replaces the array wholesale.
    if (Number.isInteger(at) && at >= 0) {
      const next = container.slice();
      next[at] = isLast ? value : writeSegments(next[at], segments, index + 1, value);
      return next;
    }
  }

  const base = container !== null && typeof container === "object" && !Array.isArray(container)
    ? container as Record<string, unknown>
    : {};
  return {
    ...base,
    [segment]: isLast ? value : writeSegments(base[segment], segments, index + 1, value),
  };
}

/**
 * A node's props with every `$bind` marker replaced by the value it points at.
 *
 * Returns the original object when nothing was bound, so the common case (inert display nodes)
 * allocates nothing and memoized children stay memoized.
 */
export function resolveProps(
  props: Record<string, unknown>,
  state: BoundState,
): Record<string, unknown> {
  let resolved: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(props)) {
    if (!isGenerativeUiBinding(value)) continue;
    resolved ??= { ...props };
    resolved[key] = getAtPath(state, value.$bind);
  }
  return resolved ?? props;
}

/** The path a prop is bound to, or undefined if it holds a literal. */
export function bindingOf(props: Record<string, unknown>, key: string): string | undefined {
  const value = props[key];
  return isGenerativeUiBinding(value) ? value.$bind : undefined;
}
