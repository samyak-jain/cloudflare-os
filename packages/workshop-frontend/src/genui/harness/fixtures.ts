/**
 * Representative trees, in exactly the shape the sandbox emits.
 *
 * Shared by the QA harness and the renderer tests so the thing screenshotted and the thing
 * asserted on are the same thing. Written as JSON rather than authored as JSX, because JSON is
 * what actually crosses the wire -- a fixture built by a client-side JSX helper would quietly test
 * the helper.
 */

import type { GenerativeUiNode, GenerativeUiResult } from "@gadgets/workshop-shared/api";

function node(
  type: string,
  props: Record<string, unknown> = {},
  children: (GenerativeUiNode | string)[] = [],
): GenerativeUiNode {
  return { type, props, children };
}

/** A binding marker, as the sandbox writes it. */
const bind = (path: string) => ({ $bind: path });

/**
 * The everyday case: a short form that asks for a decision.
 *
 * Sparse on purpose -- three controls and a button -- because this is the shape most `renderUI`
 * calls will take, and it is the one the card has to look calmest in.
 */
export const DEPLOY_FORM: GenerativeUiResult = {
  catalogVersion: 1,
  stateDefaults: { env: "staging", tag: "v2.4.1", notify: true },
  tree: node("Stack", { gap: "md" }, [
    node("Heading", { level: 1 }, ["Deploy checkout-api"]),
    node("Text", {}, ["Three commits ahead of what is running. Pick a target and I'll roll it out."]),
    node("Select", {
      label: "Environment",
      value: bind("env"),
      options: [
        { value: "staging", label: "Staging" },
        { value: "canary", label: "Canary (5%)" },
        { value: "production", label: "Production" },
      ],
    }),
    node("Input", { label: "Release tag", value: bind("tag"), placeholder: "v0.0.0" }),
    node("Checkbox", { checked: bind("notify"), label: "Post to #deploys when it lands" }),
    node("Row", { justify: "end", gap: "sm" }, [
      node("Button", { action: "cancel", variant: "secondary" }, ["Not now"]),
      node("Button", { action: "deploy", variant: "primary" }, ["Deploy"]),
    ]),
  ]),
};

/**
 * The dense case: every catalog component at once, nested three deep.
 *
 * Not a realistic answer -- it is the contact sheet. If the spacing survives this, it survives
 * anything a model composes.
 */
export const KITCHEN_SINK: GenerativeUiResult = {
  catalogVersion: 1,
  stateDefaults: { query: "zone:edge", budget: 60, strict: false, plan: "pro" },
  tree: node("Stack", { gap: "md" }, [
    node("Row", { justify: "between" }, [
      node("Heading", { level: 1 }, ["Traffic review"]),
      node("Badge", { tone: "success" }, ["Healthy"]),
    ]),
    node("Text", {}, ["Last 24 hours across four zones."]),
    node("KeyValue", {
      items: [
        { label: "Requests", value: 18420913 },
        { label: "Cache hit", value: "94.2%" },
        { label: "p99", value: "138 ms" },
        { label: "Origin errors", value: 12 },
      ],
    }),
    node("Divider"),
    node("Heading", { level: 3 }, ["Top routes"]),
    node("Table", {
      columns: [
        { key: "route", label: "Route" },
        { key: "requests", label: "Requests", align: "right" },
        { key: "p99", label: "p99", align: "right" },
      ],
      rows: [
        { route: "/api/checkout", requests: 4820193, p99: 212 },
        { route: "/api/session", requests: 3910244, p99: 96 },
        { route: "/assets/*", requests: 9014882, p99: 41 },
      ],
    }),
    node("ProgressBar", { label: "Monthly budget used", value: 61, max: 100 }),
    node("Callout", { tone: "warning", title: "One zone is behind" }, [
      "edge-eu is serving a build from three days ago.",
    ]),
    node("Card", { title: "Narrow the view", subtitle: "Applies to this card only" }, [
      node("Input", { label: "Filter", value: bind("query"), placeholder: "zone:…" }),
      node("Slider", { label: "Minimum traffic share", value: bind("budget"), min: 0, max: 100 }),
      node("Checkbox", { checked: bind("strict"), label: "Exact matches only" }),
    ]),
    node("Row", { justify: "end", gap: "sm" }, [
      node("Button", { action: "export", variant: "secondary" }, ["Export CSV"]),
      node("Button", { action: "apply", variant: "primary" }, ["Apply filters"]),
    ]),
  ]),
};

/** The sparsest useful card: a statement and one decision. */
export const CONFIRM: GenerativeUiResult = {
  catalogVersion: 1,
  stateDefaults: {},
  tree: node("Stack", { gap: "md" }, [
    node("Callout", { tone: "danger", title: "This deletes 41 rows" }, [
      "The backup from 06:00 is still available if this turns out wrong.",
    ]),
    node("Row", { justify: "end", gap: "sm" }, [
      node("Button", { action: "keep", variant: "secondary" }, ["Keep them"]),
      node("Button", { action: "delete", variant: "danger" }, ["Delete rows"]),
    ]),
  ]),
};

/** A tree naming a component this build doesn't have, to exercise forward compatibility. */
export const FROM_A_NEWER_CATALOG: GenerativeUiResult = {
  catalogVersion: 2,
  stateDefaults: {},
  tree: node("Stack", { gap: "md" }, [
    node("Heading", { level: 2 }, ["Latency by colo"]),
    node("Sparkline", { points: [3, 9, 4, 12, 7] }, [
      node("Text", {}, ["A component from a newer catalog, with children this build can still draw."]),
    ]),
    node("Text", { size: "sm", tone: "muted" }, ["Everything else renders normally."]),
  ]),
};

/** Every fixture, in the order the harness lists them. */
export const FIXTURES: { name: string; result: GenerativeUiResult }[] = [
  { name: "Deploy form", result: DEPLOY_FORM },
  { name: "Confirm", result: CONFIRM },
  { name: "Kitchen sink", result: KITCHEN_SINK },
  { name: "Newer catalog", result: FROM_A_NEWER_CATALOG },
];

/** A partial JSX fragment, mid-stream, for the composing state. */
export const PARTIAL_JSX = `<Stack gap="md">
  <Heading level={1}>Deploy checkout-api</Heading>
  <Text>Three commits ahead of what is running.</Text>
  <Select label="Environment" value={bind("env")} options={[
    {value: "staging", label: "Staging"},
  ]} />
  <Input label="Release tag" value={bind("tag`;
