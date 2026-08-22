/**
 * A skeleton of the interface being written, read off the still-streaming JSX.
 *
 * The tool's arguments arrive as raw text long before the sandbox has anything to validate, and
 * the existing chat already mines that stream for live previews (`toolCodeDelta` →
 * `StreamingToolInputParser` for `executeCode`). The same fragments name the components the model
 * is placing, so the card can show the *shape* of the answer while it is still being written
 * instead of a spinner that says nothing.
 *
 * This is a deliberately shallow scan, not a parser. It is wrong sometimes -- a component name
 * inside a string literal counts, an unbalanced fragment mid-stream nests one level too deep --
 * and that is fine: the output is grey boxes that are replaced a second later by the real tree.
 * Nothing downstream trusts it, and nothing here can fail.
 */

/** One line of the skeleton: a catalog name and how deep it sits. */
export type SkeletonItem = { type: string; depth: number };

/** Skeleton lines beyond this are dropped: past a screenful it stops being a preview. */
export const MAX_SKELETON_ITEMS = 14;

/** How deep the skeleton indents before it stops indenting further. */
export const MAX_SKELETON_DEPTH = 3;

/**
 * The components named so far in a partial JSX fragment, in document order.
 *
 * Only capitalized tag names count -- lowercase ones are HTML, which the catalog doesn't include
 * and the sandbox rejects.
 */
export function sketchPartialJsx(jsx: string): SkeletonItem[] {
  const items: SkeletonItem[] = [];
  let depth = 0;

  for (let i = 0; i < jsx.length; i++) {
    if (jsx[i] !== "<") continue;

    const closing = jsx[i + 1] === "/";
    const nameStart = closing ? i + 2 : i + 1;
    if (!/[A-Z]/.test(jsx[nameStart] ?? "")) continue;

    let nameEnd = nameStart;
    while (nameEnd < jsx.length && /[A-Za-z0-9_.]/.test(jsx[nameEnd])) nameEnd++;
    const type = jsx.slice(nameStart, nameEnd);

    if (closing) {
      depth = Math.max(0, depth - 1);
      i = nameEnd;
      continue;
    }

    if (items.length < MAX_SKELETON_ITEMS) {
      items.push({ type, depth: Math.min(depth, MAX_SKELETON_DEPTH) });
    }

    // Find this tag's own `>` to learn whether it self-closed. An unterminated tag is the newest
    // one in the stream: treat it as open, which is what the model is about to make it.
    const end = jsx.indexOf(">", nameEnd);
    if (end === -1) break;
    if (jsx[end - 1] !== "/") depth++;
    i = end;
  }

  return items;
}
