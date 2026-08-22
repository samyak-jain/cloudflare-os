import { describe, expect, it } from "vitest";
import type { AiChatStreamEvent } from "@gadgets/workshop-shared/api";
import { AvatarStateMachine, DEFAULT_TIMINGS, workKindForTool } from "./mapping";
import type { AvatarState } from "./state";

/**
 * A hand-driven clock. Every machine entry point takes `now`, so a test reads as a transcript of a
 * turn: advance, feed an event, assert the pose. No fake timers, no async.
 */
class Driver {
  readonly machine = new AvatarStateMachine();
  t = 1_000;

  advance(ms: number): this {
    this.t += ms;
    return this;
  }

  stream(event: AiChatStreamEvent): this {
    this.machine.handleStream(event, this.t);
    return this;
  }

  message(type: "message" | "error" | "changes", author: "user" | "agent" = "agent"): this {
    this.machine.handleMessage({ type, author: { type: author } } as never, this.t);
    return this;
  }

  active(value: boolean): this {
    this.machine.setAgentActive(value, this.t);
    return this;
  }

  get state(): AvatarState {
    return this.machine.state(this.t);
  }

  get kind(): AvatarState["kind"] {
    return this.state.kind;
  }
}

const text: AiChatStreamEvent = { type: "textDelta", delta: "hi" };
const reasoning: AiChatStreamEvent = { type: "reasoningDelta", delta: "hmm" };

function toolStart(id: string, toolName: string): AiChatStreamEvent {
  return { type: "toolCallStarted", toolCallId: id, toolName: toolName as never };
}

describe("workKindForTool", () => {
  it("maps the tool table onto the four working poses", () => {
    expect(workKindForTool("readFile")).toBe("read");
    expect(workKindForTool("editFile")).toBe("write");
    expect(workKindForTool("createGadget")).toBe("write");
    expect(workKindForTool("webFetch")).toBe("browse");
    expect(workKindForTool("executeCode")).toBe("execute");
  });

  it("degrades an unknown tool to a generic busy pose rather than dropping out of working", () => {
    expect(workKindForTool("someToolAddedUpstream")).toBe("execute");
  });
});

describe("turn shape", () => {
  it("idles before anything happens", () => {
    expect(new Driver().kind).toBe("idle");
  });

  it("listens from the user's message until the agent's first token", () => {
    const d = new Driver();
    d.message("message", "user");
    expect(d.kind).toBe("listening");

    // The agent is running but has emitted nothing yet: still listening, however long it takes.
    d.active(true).advance(8_000);
    expect(d.kind).toBe("listening");

    d.stream(reasoning);
    expect(d.kind).toBe("thinking");
  });

  it("walks reason -> talk -> tool -> talk across one turn", () => {
    const d = new Driver();
    d.message("message", "user").active(true);

    d.stream(reasoning);
    expect(d.kind).toBe("thinking");

    d.advance(400).stream(text);
    expect(d.kind).toBe("talking");

    d.advance(300).stream(toolStart("t1", "readFile"));
    expect(d.state).toEqual({ kind: "working", work: "read" });

    d.advance(800).stream(text);
    expect(d.kind).toBe("talking");
  });

  it("flashes done for the configured window after a turn that produced something", () => {
    const d = new Driver();
    d.message("message", "user").active(true).stream(text).advance(500).message("message", "agent");

    d.active(false);
    expect(d.kind).toBe("done");

    d.advance(DEFAULT_TIMINGS.doneMs - 50);
    expect(d.kind).toBe("done");

    d.advance(100);
    expect(d.kind).toBe("idle");
  });

  it("does not flash done for a turn that produced nothing", () => {
    const d = new Driver();
    d.active(true).advance(100).active(false);
    expect(d.kind).toBe("idle");
  });

  it("flashes error on a failed turn and lets it outlive the turn boundary", () => {
    const d = new Driver();
    d.message("message", "user").active(true).stream(text).advance(200);

    d.message("error");
    expect(d.kind).toBe("error");

    // The metadata retracts `activeAgent` afterwards; error must win over the done flash.
    d.advance(50).active(false);
    expect(d.kind).toBe("error");

    d.advance(DEFAULT_TIMINGS.errorMs);
    expect(d.kind).toBe("idle");
  });

  it("lets a fresh prompt supersede the previous turn's outcome", () => {
    const d = new Driver();
    d.active(true).stream(text).advance(100).active(false);
    expect(d.kind).toBe("done");

    d.advance(200).message("message", "user");
    expect(d.kind).toBe("listening");
  });
});

describe("hysteresis", () => {
  it("holds talking through an interleaved reasoning burst", () => {
    const d = new Driver();
    d.active(true).stream(text);
    expect(d.kind).toBe("talking");

    // A short reasoning burst inside narration is the flicker case; talking must survive it.
    d.advance(120).stream(reasoning);
    expect(d.kind).toBe("talking");
    d.advance(120).stream(reasoning);
    expect(d.kind).toBe("talking");

    // Once the guard elapses, sustained reasoning does take over.
    d.advance(600).stream(reasoning);
    expect(d.kind).toBe("thinking");
  });

  it("lets a tool call preempt narration immediately", () => {
    const d = new Driver();
    d.active(true).stream(text);
    d.advance(30).stream(toolStart("t1", "writeFile"));
    expect(d.state).toEqual({ kind: "working", work: "write" });
  });

  it("lets text preempt reasoning quickly, since the mouth should follow the words", () => {
    const d = new Driver();
    d.active(true).stream(reasoning);
    d.advance(320).stream(text);
    expect(d.kind).toBe("talking");
  });

  it("switches work kind at once when a different tool starts", () => {
    const d = new Driver();
    d.active(true).stream(toolStart("t1", "readFile"));
    expect(d.state).toEqual({ kind: "working", work: "read" });

    d.advance(50).stream(toolStart("t2", "webFetch"));
    expect(d.state).toEqual({ kind: "working", work: "browse" });
  });
});

describe("tool execution", () => {
  it("stays working through the silent gap after toolCallFinished", () => {
    const d = new Driver();
    d.active(true).stream(toolStart("t1", "executeCode"));
    d.advance(200).stream({ type: "toolCallFinished", toolCallId: "t1" });

    // `toolCallFinished` only means the *input* finished streaming; the tool then runs, emitting
    // nothing. A decay-based reading would show idle here, in the middle of the work.
    d.advance(30_000);
    expect(d.state).toEqual({ kind: "working", work: "execute" });
  });

  it("keeps the started call's kind on its later events", () => {
    const d = new Driver();
    d.active(true).stream(toolStart("t1", "readFile"));
    d.advance(60).stream({ type: "toolOutputDelta", toolCallId: "t1", delta: "..." });
    expect(d.state).toEqual({ kind: "working", work: "read" });
  });

  it("reads an edit preview as a write even with no toolCallStarted seen", () => {
    const d = new Driver();
    d.active(true).stream({
      type: "editPreviewStart",
      toolCallId: "late",
      file: { workpieceId: 1 as never, filename: "a.ts" },
    });
    expect(d.state).toEqual({ kind: "working", work: "write" });
  });
});

describe("edge cases", () => {
  it("treats streaming as proof the agent is running when the metadata lags", () => {
    // `activeAgent` and the first delta travel as separate messages; trusting the flag alone would
    // drop the opening of a turn.
    const d = new Driver();
    d.stream(text);
    expect(d.kind).toBe("talking");

    d.active(true).advance(100).stream(text);
    expect(d.kind).toBe("talking");
    d.advance(50).active(false);
    expect(d.kind).toBe("done");
  });

  it("reads compaction as thinking and holds it through the silence", () => {
    const d = new Driver();
    d.active(true).stream({ type: "compacting" });
    expect(d.kind).toBe("thinking");

    d.advance(20_000);
    expect(d.kind).toBe("thinking");

    d.stream({ type: "compacted" }).advance(10).stream(text);
    expect(d.kind).toBe("talking");
  });

  it("pauses on a dropped socket, outranking any claim about the agent", () => {
    const d = new Driver();
    d.active(true).stream(text);
    expect(d.kind).toBe("talking");

    d.machine.setConnectionLost(true);
    expect(d.kind).toBe("paused");

    d.machine.setConnectionLost(false);
    expect(d.kind).toBe("idle");
  });

  it("still shows an error while the socket is down", () => {
    const d = new Driver();
    d.active(true).stream(text).advance(10).message("error");
    d.machine.setConnectionLost(true);
    expect(d.kind).toBe("error");

    d.advance(DEFAULT_TIMINGS.errorMs);
    expect(d.kind).toBe("paused");
  });

  it("keeps listening indefinitely while a turn is running but has not spoken yet", () => {
    const d = new Driver();
    d.message("message", "user").active(true);
    d.advance(DEFAULT_TIMINGS.listeningMs * 3);
    expect(d.kind).toBe("listening");
  });

  it("settles to idle when a sent message is never picked up at all", () => {
    // A chat with no model configured: `activeAgent` never sets and no stream event ever arrives.
    // Sitting attentive forever would be a lie about something that is not coming.
    const d = new Driver();
    d.message("message", "user");
    d.advance(DEFAULT_TIMINGS.listeningMs - 100);
    expect(d.kind).toBe("listening");

    d.advance(200);
    expect(d.kind).toBe("idle");
  });

  it("listens while the user types, then lapses back to idle", () => {
    const d = new Driver();
    d.machine.noteUserComposing(d.t);
    expect(d.kind).toBe("listening");

    d.advance(DEFAULT_TIMINGS.composingMs + 10);
    expect(d.kind).toBe("idle");
  });

  it("resets on a chat switch so the previous conversation does not bleed through", () => {
    const d = new Driver();
    d.active(true).stream(toolStart("t1", "readFile"));
    expect(d.kind).toBe("working");

    d.machine.reset();
    expect(d.kind).toBe("idle");
  });
});

describe("nextChangeIn", () => {
  it("reports nothing to wait for when the state is event-driven", () => {
    const d = new Driver();
    d.active(true).stream(text);
    expect(d.machine.nextChangeIn(d.t)).toBeNull();
  });

  it("reports the remaining hold for a transient outcome", () => {
    const d = new Driver();
    d.active(true).stream(text).advance(10).active(false);
    expect(d.machine.nextChangeIn(d.t)).toBe(DEFAULT_TIMINGS.doneMs);

    d.advance(500);
    expect(d.machine.nextChangeIn(d.t)).toBe(DEFAULT_TIMINGS.doneMs - 500);
  });
});
