// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

/**
 * Renderer tests: what the catalog draws, what a binding does, and what freezing takes away.
 *
 * Driven through the real card (`GenerativeUiCard`), not the walker, because the parts worth
 * testing are the ones that only exist once the state hook, the catalog, and the freeze rule are
 * wired together. React is driven with `react-dom/client` + `act` directly, matching the
 * repository's other component tests.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GENERATIVE_UI_CATALOG,
  type GenerativeUiNode,
  type GenerativeUiResult,
} from "@gadgets/workshop-shared/api";
import { GenerativeUiCard, ComposingUiCard } from "./GenerativeUiCard";
import { createRecordingGenerativeUiClient } from "./client";
import { STATE_MIRROR_DEBOUNCE_MS } from "./state";
import { KITCHEN_SINK, DEPLOY_FORM } from "./harness/fixtures";

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT;
testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT;
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function render(ui: React.ReactNode) {
  act(() => root.render(ui));
}

function node(
  type: string,
  props: Record<string, unknown> = {},
  children: (GenerativeUiNode | string)[] = [],
): GenerativeUiNode {
  return { type, props, children };
}

function result(tree: GenerativeUiNode, stateDefaults: Record<string, unknown> = {}): GenerativeUiResult {
  return { tree, stateDefaults, catalogVersion: 1 };
}

/** Sets a controlled input's value the way a user's keystroke would, past React's value tracker. */
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function chooseOption(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  act(() => {
    setter.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function buttonLabelled(text: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")]
    .find((button) => button.textContent?.includes(text));
  if (!match) throw new Error(`no button labelled ${text}; saw ${container.textContent}`);
  return match as HTMLButtonElement;
}

// ── Catalog coverage ────────────────────────────────────────────────────────────────────────────

/** A minimal node per catalog component, plus what must be visible once it renders. */
const CATALOG_CASES: Record<string, { node: GenerativeUiNode; expect: (host: HTMLElement) => void }> = {
  Stack: {
    node: node("Stack", { gap: "lg" }, [node("Text", {}, ["inside"])]),
    expect: (host) => expect(host.textContent).toContain("inside"),
  },
  Row: {
    node: node("Row", { justify: "between" }, [node("Text", {}, ["left"]), node("Text", {}, ["right"])]),
    expect: (host) => expect(host.textContent).toContain("leftright"),
  },
  Card: {
    node: node("Card", { title: "Filters", subtitle: "this card only" }, [node("Text", {}, ["body"])]),
    expect: (host) => {
      expect(host.textContent).toContain("Filters");
      expect(host.textContent).toContain("this card only");
      expect(host.textContent).toContain("body");
    },
  },
  Text: {
    node: node("Text", { tone: "danger", size: "sm" }, ["plain words"]),
    expect: (host) => expect(host.querySelector("p")?.textContent).toBe("plain words"),
  },
  Heading: {
    node: node("Heading", { level: 1 }, ["A title"]),
    expect: (host) => expect(host.querySelector("h3")?.textContent).toBe("A title"),
  },
  Badge: {
    node: node("Badge", { tone: "success" }, ["Healthy"]),
    expect: (host) => expect(host.querySelector("span")?.textContent).toContain("Healthy"),
  },
  Divider: {
    node: node("Divider"),
    expect: (host) => expect(host.querySelector('[role="separator"]')).not.toBeNull(),
  },
  Button: {
    node: node("Button", { action: "go", variant: "primary" }, ["Go"]),
    expect: (host) => expect(host.querySelector("button")?.textContent).toContain("Go"),
  },
  Input: {
    node: node("Input", { label: "Tag", value: { $bind: "tag" }, placeholder: "v0.0.0" }),
    expect: (host) => {
      expect(host.textContent).toContain("Tag");
      expect(host.querySelector<HTMLInputElement>('input[type="text"]')?.placeholder).toBe("v0.0.0");
    },
  },
  Select: {
    node: node("Select", { label: "Env", value: { $bind: "env" }, options: ["staging", "prod"] }),
    expect: (host) => {
      const options = [...host.querySelectorAll("option")].map((option) => option.textContent);
      expect(options).toEqual(["Select…", "staging", "prod"]);
    },
  },
  Checkbox: {
    node: node("Checkbox", { checked: { $bind: "notify" }, label: "Notify me" }),
    expect: (host) => {
      expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')).not.toBeNull();
      expect(host.textContent).toContain("Notify me");
    },
  },
  Slider: {
    node: node("Slider", { label: "Share", value: { $bind: "share" }, min: 0, max: 10 }),
    expect: (host) => {
      const range = host.querySelector<HTMLInputElement>('input[type="range"]')!;
      expect(range.max).toBe("10");
    },
  },
  Table: {
    node: node("Table", {
      columns: [{ key: "route", label: "Route" }, { key: "n", label: "Requests", align: "right" }],
      rows: [{ route: "/a", n: 12 }, { route: "/b", n: 3 }],
    }),
    expect: (host) => {
      expect([...host.querySelectorAll("th")].map((th) => th.textContent)).toEqual(["Route", "Requests"]);
      expect(host.querySelectorAll("tbody tr").length).toBe(2);
      expect(host.textContent).toContain("/a");
    },
  },
  ProgressBar: {
    node: node("ProgressBar", { label: "Budget", value: 30, max: 60 }),
    expect: (host) => {
      const bar = host.querySelector('[role="progressbar"]')!;
      expect(bar.getAttribute("aria-valuenow")).toBe("30");
      expect(host.textContent).toContain("50%");
    },
  },
  Callout: {
    node: node("Callout", { tone: "warning", title: "Careful" }, ["one zone is behind"]),
    expect: (host) => {
      expect(host.textContent).toContain("Careful");
      expect(host.textContent).toContain("one zone is behind");
    },
  },
  KeyValue: {
    node: node("KeyValue", { items: [{ label: "p99", value: "138 ms" }, { label: "Errors", value: 12 }] }),
    expect: (host) => {
      expect([...host.querySelectorAll("dt")].map((dt) => dt.textContent)).toEqual(["p99", "Errors"]);
      expect([...host.querySelectorAll("dd")].map((dd) => dd.textContent)).toEqual(["138 ms", "12"]);
    },
  },
};

describe("catalog", () => {
  it("covers every component the contract names", () => {
    expect(Object.keys(CATALOG_CASES).toSorted()).toEqual(GENERATIVE_UI_CATALOG.toSorted());
  });

  for (const name of GENERATIVE_UI_CATALOG) {
    it(`renders ${name}`, () => {
      const testCase = CATALOG_CASES[name];
      expect(testCase).toBeDefined();
      render(
        <GenerativeUiCard
          toolCallId="call-1"
          result={result(testCase.node, { tag: "v1", env: "staging", notify: false, share: 4 })}
          client={null}
          interactive={false}
        />,
      );
      testCase.expect(container);
    });
  }

  it("renders a whole nested tree, three levels deep", () => {
    render(
      <GenerativeUiCard toolCallId="call-1" result={KITCHEN_SINK} client={null} interactive={false} />,
    );
    expect(container.textContent).toContain("Traffic review");
    expect(container.textContent).toContain("/api/checkout");
    // Card > Slider, the deepest control in the fixture.
    expect(container.querySelector('input[type="range"]')).not.toBeNull();
    expect(container.textContent).toContain("Narrow the view");
  });

  it("draws an inert placeholder for a component it doesn't know, and keeps its children", () => {
    render(
      <GenerativeUiCard
        toolCallId="call-1"
        result={result(node("Stack", {}, [
          node("Sparkline", { points: [1, 2] }, [node("Text", {}, ["still here"])]),
        ]))}
        client={null}
        interactive={false}
      />,
    );
    expect(container.textContent).toContain("Sparkline · unsupported component");
    expect(container.textContent).toContain("still here");
  });

  it("survives props of the wrong type rather than failing the card", () => {
    render(
      <GenerativeUiCard
        toolCallId="call-1"
        result={result(node("Stack", {}, [
          node("Heading", { level: "enormous" }, ["Title"]),
          node("ProgressBar", { value: "not a number", max: "also not" }),
          node("Table", { columns: "nope", rows: [{ a: 1 }] }),
          node("Badge", { tone: "chartreuse" }, ["Badge"]),
        ]))}
        client={null}
        interactive={false}
      />,
    );
    expect(container.textContent).toContain("Title");
    expect(container.textContent).toContain("Badge");
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("0");
  });
});

// ── Bindings ────────────────────────────────────────────────────────────────────────────────────

describe("bindings", () => {
  it("wires a text input to its state path, local-first", () => {
    const client = createRecordingGenerativeUiClient();
    render(
      <GenerativeUiCard
        toolCallId="call-1"
        result={result(node("Input", { label: "Tag", value: { $bind: "tag" } }), { tag: "v1" })}
        client={client}
        interactive
      />,
    );
    const input = container.querySelector<HTMLInputElement>('input[type="text"]')!;
    expect(input.value).toBe("v1");

    typeInto(input, "v2");
    expect(input.value).toBe("v2");
    // The keystroke never waited on the backend.
    expect(client.calls).toEqual([]);
  });

  it("mirrors state to the backend once the typing stops", () => {
    vi.useFakeTimers();
    const client = createRecordingGenerativeUiClient();
    render(
      <GenerativeUiCard
        toolCallId="call-1"
        result={result(node("Input", { value: { $bind: "tag" } }), { tag: "v1" })}
        client={client}
        interactive
      />,
    );
    const input = container.querySelector<HTMLInputElement>('input[type="text"]')!;
    typeInto(input, "v2");
    typeInto(input, "v25");
    expect(client.calls).toEqual([]);

    act(() => { vi.advanceTimersByTime(STATE_MIRROR_DEBOUNCE_MS); });
    expect(client.calls).toEqual([
      { kind: "setState", toolCallId: "call-1", state: { tag: "v25" } },
    ]);
  });

  it("writes a number input back as a number", () => {
    vi.useFakeTimers();
    const client = createRecordingGenerativeUiClient();
    render(
      <GenerativeUiCard
        toolCallId="call-1"
        result={result(node("Input", { type: "number", value: { $bind: "count" } }), { count: 1 })}
        client={client}
        interactive
      />,
    );
    typeInto(container.querySelector<HTMLInputElement>("input")!, "7");
    act(() => { vi.advanceTimersByTime(STATE_MIRROR_DEBOUNCE_MS); });
    expect(client.calls[0]).toMatchObject({ state: { count: 7 } });
  });

  it("wires select, checkbox and slider, including into nested paths", () => {
    vi.useFakeTimers();
    const client = createRecordingGenerativeUiClient();
    render(
      <GenerativeUiCard
        toolCallId="call-1"
        result={result(
          node("Stack", {}, [
            node("Select", { value: { $bind: "filters.env" }, options: ["staging", "prod"] }),
            node("Checkbox", { checked: { $bind: "notify" }, label: "Notify" }),
            node("Slider", { value: { $bind: "share" }, min: 0, max: 100 }),
          ]),
          { filters: { env: "staging", other: "kept" }, notify: false, share: 10 },
        )}
        client={client}
        interactive
      />,
    );

    chooseOption(container.querySelector("select")!, "prod");
    act(() => { container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
    const range = container.querySelector<HTMLInputElement>('input[type="range"]')!;
    typeInto(range, "80");

    act(() => { vi.advanceTimersByTime(STATE_MIRROR_DEBOUNCE_MS); });
    expect(client.calls.at(-1)).toEqual({
      kind: "setState",
      toolCallId: "call-1",
      state: { filters: { env: "prod", other: "kept" }, notify: true, share: 80 },
    });
  });

  it("renders a control with no binding read-only rather than losing keystrokes", () => {
    render(
      <GenerativeUiCard
        toolCallId="call-1"
        result={result(node("Input", { value: "fixed" }))}
        client={createRecordingGenerativeUiClient()}
        interactive
      />,
    );
    expect(container.querySelector<HTMLInputElement>("input")!.readOnly).toBe(true);
  });
});

// ── Submission and freezing ─────────────────────────────────────────────────────────────────────

describe("submission", () => {
  it("sends the action with the state as edited, then freezes the card", async () => {
    const client = createRecordingGenerativeUiClient();
    render(
      <GenerativeUiCard
        toolCallId="call-1"
        result={result(
          node("Stack", {}, [
            node("Input", { value: { $bind: "tag" } }),
            node("Button", { action: "deploy", variant: "primary" }, ["Deploy"]),
          ]),
          { tag: "v1" },
        )}
        client={client}
        interactive
      />,
    );

    typeInto(container.querySelector<HTMLInputElement>('input[type="text"]')!, "v2");
    await act(async () => { buttonLabelled("Deploy").click(); });

    expect(client.calls).toEqual([
      { kind: "submitAction", toolCallId: "call-1", action: "deploy", state: { tag: "v2" } },
    ]);
    expect(container.textContent).toContain("Submitted");
    expect(buttonLabelled("Deploy").disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[type="text"]')!.readOnly).toBe(true);
  });

  it("submits only once, however many times the button is pressed", async () => {
    const client = createRecordingGenerativeUiClient();
    render(
      <GenerativeUiCard
        toolCallId="call-1"
        result={result(node("Button", { action: "deploy" }, ["Deploy"]))}
        client={client}
        interactive
      />,
    );
    await act(async () => { buttonLabelled("Deploy").click(); });
    await act(async () => { buttonLabelled("Deploy").click(); });
    expect(client.calls.length).toBe(1);
  });

  it("submits only once for two clicks inside one tick, before the button can disable", async () => {
    const client = createRecordingGenerativeUiClient();
    render(
      <GenerativeUiCard
        toolCallId="call-1"
        result={result(node("Button", { action: "deploy" }, ["Deploy"]))}
        client={client}
        interactive
      />,
    );
    const button = buttonLabelled("Deploy");
    await act(async () => { button.click(); button.click(); });
    expect(client.calls.length).toBe(1);
  });

  it("does not mirror state after the card is consumed", async () => {
    vi.useFakeTimers();
    const client = createRecordingGenerativeUiClient();
    render(
      <GenerativeUiCard
        toolCallId="call-1"
        result={result(
          node("Stack", {}, [
            node("Input", { value: { $bind: "tag" } }),
            node("Button", { action: "deploy" }, ["Deploy"]),
          ]),
          { tag: "v1" },
        )}
        client={client}
        interactive
      />,
    );
    typeInto(container.querySelector<HTMLInputElement>('input[type="text"]')!, "v2");
    await act(async () => { buttonLabelled("Deploy").click(); });
    act(() => { vi.advanceTimersByTime(STATE_MIRROR_DEBOUNCE_MS * 4); });

    expect(client.calls.map((call) => call.kind)).toEqual(["submitAction"]);
  });

  it("reports a failed submission and leaves the card usable", async () => {
    const client = createRecordingGenerativeUiClient();
    client.submitAction = () => Promise.reject(new Error("agent is not listening"));
    render(
      <GenerativeUiCard
        toolCallId="call-1"
        result={result(node("Button", { action: "deploy" }, ["Deploy"]))}
        client={client}
        interactive
      />,
    );
    await act(async () => { buttonLabelled("Deploy").click(); });

    expect(container.textContent).toContain("agent is not listening");
    expect(buttonLabelled("Deploy").disabled).toBe(false);
  });

  it("renders a historical card read-only, and says so", () => {
    const client = createRecordingGenerativeUiClient();
    render(
      <GenerativeUiCard
        toolCallId="call-1"
        result={DEPLOY_FORM}
        client={client}
        interactive={false}
      />,
    );
    expect(container.querySelector<HTMLInputElement>('input[type="text"]')!.readOnly).toBe(true);
    expect(container.querySelector<HTMLSelectElement>("select")!.disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(true);
    expect(buttonLabelled("Deploy").disabled).toBe(true);
    expect(container.textContent).toContain("No longer active");

    buttonLabelled("Deploy").click();
    expect(client.calls).toEqual([]);
  });

  it("notes a tree built for a catalog this build doesn't have", () => {
    render(
      <GenerativeUiCard
        toolCallId="call-1"
        result={{ ...result(node("Text", {}, ["hi"])), catalogVersion: 99 }}
        client={null}
        interactive={false}
      />,
    );
    expect(container.textContent).toContain("newer version of the app");
  });
});

// ── Composing ───────────────────────────────────────────────────────────────────────────────────

describe("composing state", () => {
  it("shows the label alone when nothing has streamed", () => {
    render(<ComposingUiCard />);
    expect(container.textContent).toContain("Composing interface");
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it("shows the label alone for a fragment that is still only containers", () => {
    render(<ComposingUiCard jsx="<Stack gap=" />);
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it("sketches the components named so far", () => {
    render(<ComposingUiCard jsx='<Stack><Heading>Deploy</Heading><Input value={bind("tag' />);
    const skeleton = container.querySelector('[aria-hidden="true"]')!;
    // A row per component that draws something: Heading and Input. The Stack around them is a
    // container and contributes only its children's indentation.
    expect(skeleton.children.length).toBe(2);
    // And one bar per line of that component's shape: 1 for the Heading, 2 for the Input.
    const bars = skeleton.querySelectorAll("div > div").length - skeleton.children.length;
    expect(bars).toBe(3);
  });
});
