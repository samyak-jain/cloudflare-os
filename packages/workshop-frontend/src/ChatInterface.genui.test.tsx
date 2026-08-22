// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

/**
 * How the transcript routes the two kinds of tool call that draw their own card: a composed
 * interface, and a call to a tool this build doesn't own.
 *
 * `buildChatDisplayEntries` is the seam -- it decides what lands in a collapsed work row -- so
 * asserting there covers both entry shapes (a turn that only ran tools, and an assistant message
 * that ran tools) without mounting the whole chat.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AiChatMessage, AiChatMessageBody, AiToolCall } from "@gadgets/workshop-shared/api";
import { buildChatDisplayEntries } from "./ChatInterface";
import { RemoteToolCard, formatRemoteToolName } from "./components/chat/RemoteToolCard";

const AUTHOR = { type: "agent", id: "lena", name: "Lena" } as const;

function message(sequence: number, body: AiChatMessageBody): AiChatMessage {
  return { chatId: 1, sequence, timestamp: new Date(sequence * 1000), author: AUTHOR, ...body };
}

const RENDER_UI: AiToolCall = {
  toolCallId: "ui-1",
  toolName: "renderUI",
  input: { jsx: "<Stack />" },
  output: { tree: { type: "Stack", props: {}, children: [] }, stateDefaults: {}, catalogVersion: 1 },
};

const FAILED_RENDER_UI: AiToolCall = {
  toolCallId: "ui-2",
  toolName: "renderUI",
  input: { jsx: "<Nope />" },
  error: "Unknown component: Nope",
};

// A tool that belongs to the backing agent, not to the workshop. Its name is outside the closed
// union by construction, which is exactly the case the generic card exists for.
const REMOTE_TOOL = {
  toolCallId: "remote-1",
  toolName: "spawn_agent",
  input: { task: "summarize" },
} as unknown as AiToolCall;

const READ_FILE: AiToolCall = {
  toolCallId: "read-1",
  toolName: "readFile",
  input: { filename: "index.ts" },
};

function groupedCalls(messages: AiChatMessage[]) {
  return buildChatDisplayEntries(messages, new Map())
    .flatMap((entry) => (entry.type === "workRun" || entry.type === "message"
      ? entry.toolCallGroups ?? []
      : []))
    .flatMap((group) => group.calls.map((call) => call.toolCallId));
}

describe("transcript routing", () => {
  it("keeps a successful interface out of the collapsed work row", () => {
    const messages = [message(1, { type: "message", message: "", toolCalls: [RENDER_UI, READ_FILE] })];
    expect(groupedCalls(messages)).toEqual(["read-1"]);
  });

  it("keeps a failed interface in the work row, where its error is visible", () => {
    const messages = [message(1, { type: "message", message: "", toolCalls: [FAILED_RENDER_UI] })];
    expect(groupedCalls(messages)).toEqual(["ui-2"]);
  });

  it("keeps a remote tool out of the work row whether or not it failed", () => {
    const failed = { ...REMOTE_TOOL, toolCallId: "remote-2", error: "no such agent" };
    const messages = [
      message(1, { type: "message", message: "", toolCalls: [REMOTE_TOOL, failed, READ_FILE] }),
    ];
    expect(groupedCalls(messages)).toEqual(["read-1"]);
  });

  it("does the same when the calls hang off an assistant message with text", () => {
    const messages = [
      message(1, { type: "message", message: "Here you go.", toolCalls: [RENDER_UI, REMOTE_TOOL, READ_FILE] }),
    ];
    expect(groupedCalls(messages)).toEqual(["read-1"]);
  });

  it("leaves a turn of only self-carding calls with no work row at all", () => {
    const messages = [message(1, { type: "message", message: "", toolCalls: [RENDER_UI] })];
    const entries = buildChatDisplayEntries(messages, new Map());
    expect(entries.flatMap((entry) =>
      entry.type === "workRun" || entry.type === "message" ? entry.toolCallGroups ?? [] : [],
    )).toEqual([]);
    // The call itself is still on the entry, which is where the card renders from.
    expect(entries.some((entry) =>
      (entry.type === "workRun" || entry.type === "message") &&
      (entry.toolCalls ?? []).some((call) => call.toolCallId === "ui-1"),
    )).toBe(true);
  });
});

describe("RemoteToolCard", () => {
  const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = testGlobal.IS_REACT_ACT_ENVIRONMENT;
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  afterAll(() => {
    if (previous === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT;
    else testGlobal.IS_REACT_ACT_ENVIRONMENT = previous;
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
  });

  it("names the tool and its state without inventing a summary", () => {
    act(() => root.render(<RemoteToolCard toolName="spawn_agent" status="running" />));
    expect(container.textContent).toContain("Running");
    expect(container.textContent).toContain("spawn agent");

    act(() => root.render(<RemoteToolCard toolName="memory" status="done" />));
    expect(container.textContent).toContain("Ran");
    expect(container.textContent).toContain("memory");
  });

  it("shows a failure's message", () => {
    act(() => root.render(
      <RemoteToolCard toolName="memory" status="error" error="quota exceeded" />,
    ));
    expect(container.textContent).toContain("quota exceeded");
  });

  it("leaves a name with nothing to split alone", () => {
    expect(formatRemoteToolName("memory")).toBe("memory");
    expect(formatRemoteToolName("__")).toBe("__");
  });
});
