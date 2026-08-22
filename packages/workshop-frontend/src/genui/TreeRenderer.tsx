/**
 * The walk from validated JSON to React elements.
 *
 * Small on purpose: every decision about how something *looks* belongs to `catalog.tsx`, and every
 * decision about what a prop *means* belongs to `bind.ts`. What is left here is the traversal and
 * the one forward-compatibility rule -- an unknown element name becomes an inert placeholder that
 * still renders its children, so a tree from a larger catalog degrades a node at a time rather
 * than all at once.
 */

import { Fragment, type ReactNode } from "react";
import type { GenerativeUiNode } from "@gadgets/workshop-shared/api";
import { resolveProps, type BoundState } from "./bind";
import { CATALOG, UnsupportedComponent, type CatalogContext } from "./catalog";

/**
 * Whether a string child is JSX's insignificant whitespace rather than content.
 *
 * `<Stack>\n  <Text/>\n</Stack>` leaves whitespace strings between the elements. Dropping them
 * only when the node has element children keeps `<Text>Hello {name}</Text>`, whose two string
 * children must stay joined by their space, intact.
 */
function isLayoutWhitespace(child: GenerativeUiNode | string, siblings: (GenerativeUiNode | string)[]) {
  return typeof child === "string" &&
    child.trim() === "" &&
    siblings.some((sibling) => typeof sibling !== "string");
}

export function renderChildren(
  children: (GenerativeUiNode | string)[],
  state: BoundState,
  ctx: CatalogContext,
): ReactNode {
  const rendered = children
    .filter((child) => !isLayoutWhitespace(child, children))
    .map((child, index) => (
      <Fragment key={index}>
        {typeof child === "string" ? child : <RenderNode node={child} state={state} ctx={ctx} />}
      </Fragment>
    ));
  return rendered.length > 0 ? rendered : null;
}

export function RenderNode({
  node,
  state,
  ctx,
}: {
  node: GenerativeUiNode;
  state: BoundState;
  ctx: CatalogContext;
}) {
  const children = renderChildren(node.children, state, ctx);
  const component = CATALOG[node.type];
  if (!component) {
    return <UnsupportedComponent type={node.type}>{children}</UnsupportedComponent>;
  }
  return (
    <>
      {component({
        node,
        props: resolveProps(node.props, state),
        children,
        hasChildren: node.children.length > 0,
        ctx,
      })}
    </>
  );
}
