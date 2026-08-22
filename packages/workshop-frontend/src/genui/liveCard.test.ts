import { describe, expect, it } from "vitest";
import type { AiChatMessage, AiToolCall } from "@gadgets/workshop-shared/api";
import { findLiveGenerativeUiCall } from "./liveCard";

const AGENT = { type: "agent", id: "lena", name: "Lena" } as AiChatMessage["author"];
const USER = { type: "user", id: "u1", name: "Sam" } as AiChatMessage["author"];

function renderUiCall(toolCallId: string, failed = false): AiToolCall {
  return {
    toolCallId,
    toolName: "renderUI",
    input: { jsx: "<Stack />" },
    ...(failed
      ? { error: "validation failed" }
      : { output: { tree: { type: "Stack", props: {}, children: [] }, stateDefaults: {}, catalogVersion: 1 } }),
  };
}

let sequence = 0;
function message(
  author: AiChatMessage["author"],
  text: string,
  toolCalls?: AiToolCall[],
): AiChatMessage {
  return {
    chatId: 1,
    sequence: sequence++,
    timestamp: new Date(0),
    author,
    type: "message",
    message: text,
    ...(toolCalls ? { toolCalls } : {}),
  };
}

function submittedAction(): AiChatMessage {
  return {
    chatId: 1,
    sequence: sequence++,
    timestamp: new Date(0),
    author: USER,
    type: "generativeUiAction",
    toolCallId: "call-1",
    action: "deploy",
    state: {environment: "staging"},
  };
}

describe("findLiveGenerativeUiCall", () => {
  it("finds nothing in a chat with no interfaces", () => {
    expect(findLiveGenerativeUiCall([message(USER, "hi"), message(AGENT, "hello")])).toBeNull();
  });

  it("makes the newest interface live when it is the last thing said", () => {
    const messages = [
      message(USER, "deploy it"),
      message(AGENT, "Which environment?", [renderUiCall("call-1")]),
    ];
    expect(findLiveGenerativeUiCall(messages)).toBe("call-1");
  });

  it("freezes an interface once the conversation moves past it", () => {
    const messages = [
      message(AGENT, "Which environment?", [renderUiCall("call-1")]),
      message(USER, "actually never mind"),
    ];
    expect(findLiveGenerativeUiCall(messages)).toBeNull();
  });

  it("freezes it once the agent answers, which is what a submission produces", () => {
    const messages = [
      message(AGENT, "Which environment?", [renderUiCall("call-1")]),
      message(AGENT, "Deploying to staging."),
    ];
    expect(findLiveGenerativeUiCall(messages)).toBeNull();
  });

  it("keeps it live across an empty tool-only message", () => {
    const messages = [
      message(AGENT, "Which environment?", [renderUiCall("call-1")]),
      message(AGENT, ""),
    ];
    expect(findLiveGenerativeUiCall(messages)).toBe("call-1");
  });

  it("keeps a submitted card frozen after reload even if the resumed turn is empty", () => {
    const messages = [
      message(AGENT, "Which environment?", [renderUiCall("call-1")]),
      submittedAction(),
      message(AGENT, ""),
    ];
    expect(findLiveGenerativeUiCall(messages)).toBeNull();
  });

  it("takes the newest of several interfaces in one turn", () => {
    const messages = [
      message(AGENT, "Two options", [renderUiCall("call-1"), renderUiCall("call-2")]),
    ];
    expect(findLiveGenerativeUiCall(messages)).toBe("call-2");
  });

  it("ignores an interface that failed to build", () => {
    const messages = [message(AGENT, "here", [renderUiCall("call-1", true)])];
    expect(findLiveGenerativeUiCall(messages)).toBeNull();
  });
});
