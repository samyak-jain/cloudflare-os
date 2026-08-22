import { describe, expect, it, vi } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import type { AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";

import { runHermesTurn, type HermesDriverHooks, type HermesToolResult } from "../src/hermes-driver";
import {
  HermesToolCallStateMachine,
  hermesToolCallKey,
  type HermesToolCallRecord,
} from "../src/hermes-tool-state";

type EventInput = { seq: number; event: string; [key: string]: unknown };

function sse(events: EventInput[], sessionId = "session-1", turnId = "turn-1"): Response {
  let body = events
    .map(
      (event) =>
        `event: ${event.event}\ndata: ${JSON.stringify({
          protocol_version: 1,
          turn_id: turnId,
          session_id: sessionId,
          timestamp: 1,
          ...event,
        })}\n\n`,
    )
    .join("");
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

class FakeHermesServer {
  requests: { url: URL; method: string; body?: Record<string, unknown> }[] = [];
  toolResults: Record<string, unknown>[] = [];
  controls: Record<string, unknown>[] = [];
  deltas: Record<string, unknown>[] = [];
  reconnectAfter: string[] = [];
  deltaStatus = 200;
  eventStatuses: { status: number; retryAfter?: string; body?: string }[] = [];
  controlStatuses: number[] = [];

  constructor(
    private initial: EventInput[],
    private replay: EventInput[] = [],
    private sessionId = "session-1",
  ) {}

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let request = new Request(input, init);
    let url = new URL(request.url);
    let body =
      request.method === "POST" ? ((await request.json()) as Record<string, unknown>) : undefined;
    this.requests.push({ url, method: request.method, body });
    if (url.pathname === "/api/workshop/v1/turns") {
      return sse(this.initial, this.sessionId);
    }
    if (url.pathname.endsWith("/events")) {
      this.reconnectAfter.push(url.searchParams.get("after_seq") ?? "");
      let failure = this.eventStatuses.shift();
      if (failure)
        return new Response(failure.body ?? "upstream detail", {
          status: failure.status,
          headers: failure.retryAfter ? { "Retry-After": failure.retryAfter } : {},
        });
      return sse(this.replay, this.sessionId);
    }
    if (url.pathname.includes("/tool-results/")) {
      this.toolResults.push(body!);
      return Response.json({ ok: true });
    }
    if (url.pathname.endsWith("/control")) {
      this.controls.push(body!);
      let status = this.controlStatuses.shift();
      if (status) return new Response("secret provider body", { status });
      return Response.json({ ok: true });
    }
    if (url.pathname.endsWith("/deltas")) {
      this.deltas.push(body!);
      return this.deltaStatus === 200
        ? Response.json({ accepted: true })
        : Response.json({ error: "session missing" }, { status: this.deltaStatus });
    }
    return new Response("not found", { status: 404 });
  };
}

function tool(execute: AgentTool["execute"]): AgentTool {
  return {
    name: "readFile",
    label: "Read file",
    description: "Read a file.",
    parameters: Type.Object({ filename: Type.String() }),
    execute,
  };
}

function harness(server: FakeHermesServer, overrides: Partial<HermesDriverHooks> = {}) {
  let events: AgentEvent[] = [];
  let stored = new Map<string, HermesToolResult>();
  let sessions: string[] = [];
  let hooks: HermesDriverHooks = {
    emit: (event) => {
      events.push(event);
    },
    claimToolCall: async (turnId, callId) => {
      let result = stored.get(`${turnId}.${callId}`);
      return result ? { execute: false, result } : { execute: true };
    },
    resolveToolCall: (turnId, callId, result) => {
      stored.set(`${turnId}.${callId}`, result);
    },
    interruptToolCall: (turnId, callId, result) => {
      stored.set(`${turnId}.${callId}`, result);
    },
    waitUntil: () => {},
    onTurnStarted: (_turnId, sessionId) => {
      sessions.push(sessionId);
    },
    pauseReasonAfterMessage: () => undefined,
    pauseReasonAfterTool: () => undefined,
    ...overrides,
  };
  return { events, hooks, sessions, stored, fetch: server.fetch };
}

function terminalEvents(from = 1): EventInput[] {
  return [
    { seq: from, event: "turn.started", catalog_version: "catalog" },
    { seq: from + 1, event: "message.start" },
    { seq: from + 2, event: "text.delta", delta: "hello" },
    { seq: from + 3, event: "usage", input_tokens: 3, output_tokens: 2 },
    { seq: from + 4, event: "turn.end", status: "completed", stop_reason: "stop" },
  ];
}

describe("Hermes remote driver", () => {
  it("sends only the new input and projects a successful SSE turn", async () => {
    let server = new FakeHermesServer(terminalEvents());
    let run = harness(server);
    await runHermesTurn({
      baseUrl: "https://hermes.test",
      apiKey: "a".repeat(64),
      workspaceId: "workspace-1",
      chatId: "7",
      clientTurnId: "chat-7-seq-3",
      inputText: "new message",
      tools: [tool(async () => ({ content: [{ type: "text", text: "unused" }], details: {} }))],
      signal: new AbortController().signal,
      hooks: run.hooks,
      fetch: run.fetch,
    });

    expect(server.requests[0].body).toMatchObject({
      protocol_version: 1,
      client_turn_id: "chat-7-seq-3",
      input: { type: "user", text: "new message" },
      tools: [{ name: "readFile", description: "Read a file.", parameters: { type: "object" } }],
    });
    let end = run.events.find((event) => event.type === "turn_end");
    expect(end).toMatchObject({
      type: "turn_end",
      message: { stopReason: "stop", usage: { totalTokens: 5 } },
    });
  });

  it("reattaches with after_seq when the initial SSE subscriber disconnects", async () => {
    let server = new FakeHermesServer(terminalEvents().slice(0, 3), terminalEvents(1).slice(3));
    let run = harness(server);
    await runHermesTurn({
      baseUrl: "https://hermes.test",
      apiKey: "a".repeat(64),
      workspaceId: "workspace-1",
      chatId: "7",
      clientTurnId: "chat-7-seq-4",
      inputText: "hi",
      tools: [],
      signal: new AbortController().signal,
      hooks: run.hooks,
      fetch: run.fetch,
    });
    expect(server.reconnectAfter).toEqual(["3"]);
    expect(run.events.some((event) => event.type === "turn_end")).toBe(true);
  });

  it("retries reattach 5xx/429 and honors Retry-After without exposing bodies", async () => {
    let server = new FakeHermesServer(terminalEvents().slice(0, 2), terminalEvents(1).slice(2));
    server.eventStatuses.push(
      { status: 503, body: "first sensitive detail" },
      { status: 429, retryAfter: "2", body: "sensitive provider detail" },
    );
    let delays: number[] = [];
    let run = harness(server);
    await runHermesTurn({
      baseUrl: "https://hermes.test",
      apiKey: "a".repeat(64),
      workspaceId: "workspace-1",
      chatId: "7",
      clientTurnId: "chat-7-seq-4",
      inputText: "hi",
      tools: [],
      signal: new AbortController().signal,
      hooks: run.hooks,
      fetch: run.fetch,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
      random: () => 0.5,
    });
    expect(delays).toEqual([250, 2250]);
    expect(server.reconnectAfter).toEqual(["2", "2", "2"]);
  });

  it("keeps a 202-accepted wake attached across an SSE body failure", async () => {
    let requests = 0;
    let initialFrames = terminalEvents()
      .slice(0, 3)
      .map(
        (event) =>
          `data: ${JSON.stringify({
            protocol_version: 1,
            turn_id: "turn-1",
            session_id: "session-1",
            timestamp: 1,
            ...event,
          })}\n\n`,
      )
      .join("");
    let fetcher: typeof fetch = async (input) => {
      let url = new URL(input instanceof Request ? input.url : input.toString());
      requests++;
      if (requests === 1) {
        expect(url.pathname).toBe("/api/workshop/v1/turns/turn-1/events");
        expect(url.searchParams.get("after_seq")).toBe("0");
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(initialFrames));
            controller.error(new Error("socket reset"));
          },
        }));
      }
      expect(url.searchParams.get("after_seq")).toBe("0");
      return sse(terminalEvents());
    };
    let run = harness(new FakeHermesServer([]));
    let options = {
      baseUrl: "https://hermes.test",
      apiKey: "a".repeat(64),
      workspaceId: "workspace-1",
      chatId: "7",
      clientTurnId: "body-reset",
      inputText: "hi",
      tools: [],
      attachedTurn: {
        turnId: "turn-1",
        sessionId: "session-1",
        eventsUrl: "https://hermes.test/api/workshop/v1/turns/turn-1/events",
        idempotencyKey: "wake-1",
        afterSeq: 0,
      },
      signal: new AbortController().signal,
      hooks: run.hooks,
      fetch: fetcher,
      sleep: async () => {},
    } satisfies Parameters<typeof runHermesTurn>[0];
    await expect(runHermesTurn(options)).rejects.toThrow("socket reset");
    // The Overseer requeues the durable attachment and invokes a fresh driver. Its explicit
    // committed cursor is zero because no terminal projection crossed the barrier yet.
    await runHermesTurn(options);
    expect(requests).toBe(2);
  });

  it("executes a duplicate remote call once and re-posts the durable result", async () => {
    let execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "contents" }],
      details: { observed: true },
    }));
    let server = new FakeHermesServer([
      { seq: 1, event: "turn.started" },
      { seq: 2, event: "message.start" },
      { seq: 3, event: "tool_call.start", call_id: "call-1", name: "readFile" },
      {
        seq: 4,
        event: "tool_call.arguments.delta",
        call_id: "call-1",
        delta: '{"filename":"a.txt"}',
      },
      { seq: 5, event: "tool_call.end", call_id: "call-1", arguments: { filename: "a.txt" } },
      { seq: 6, event: "tool_call.start", call_id: "call-1", name: "readFile" },
      { seq: 7, event: "tool_call.end", call_id: "call-1", arguments: { filename: "a.txt" } },
      { seq: 8, event: "turn.end", status: "completed", stop_reason: "stop" },
    ]);
    let run = harness(server);
    await runHermesTurn({
      baseUrl: "https://hermes.test",
      apiKey: "a".repeat(64),
      workspaceId: "workspace-1",
      chatId: "7",
      clientTurnId: "chat-7-seq-5",
      inputText: "read it",
      tools: [tool(execute)],
      signal: new AbortController().signal,
      hooks: run.hooks,
      fetch: run.fetch,
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(server.toolResults).toEqual([
      { protocol_version: 1, result: "contents", is_error: false },
      { protocol_version: 1, result: "contents", is_error: false },
    ]);
  });

  it("replays a crash-window side effect with the stable operation id without duplicating it", async () => {
    let rows = new Map<string, HermesToolCallRecord>();
    let records = {
      get: (key: string) => rows.get(key),
      put: (record: HermesToolCallRecord) => {
        rows.set(hermesToolCallKey(record.turnId, record.callId), record);
      },
    };
    let crashed = new HermesToolCallStateMachine(records);
    await crashed.claim(7, "session-1", "turn-1", "call-1", "createGadget");
    let mutations = new Map<string, string>();
    mutations.set("hermes:turn-1:call-1", "gadget-17");

    let restarted = new HermesToolCallStateMachine(records);
    let mutationCount = 1;
    let sideEffectTool = {
      name: "createGadget",
      label: "Create gadget",
      description: "Create one.",
      parameters: Type.Object({}),
      execute: async () => {
        throw new Error("stock execution path must not be used");
      },
      executeHermes: async (
        _callId: string,
        _args: unknown,
        _signal: AbortSignal | undefined,
        _update: unknown,
        operationId: string,
      ) => {
        let existing = mutations.get(operationId);
        if (!existing) {
          mutationCount++;
          existing = "gadget-18";
          mutations.set(operationId, existing);
        }
        return { content: [{ type: "text" as const, text: existing }], details: {} };
      },
    } as unknown as AgentTool;
    let server = new FakeHermesServer([
      { seq: 1, event: "turn.started" },
      { seq: 2, event: "tool_call.start", call_id: "call-1", name: "createGadget" },
      { seq: 3, event: "tool_call.end", call_id: "call-1", arguments: {} },
      { seq: 4, event: "turn.end", status: "completed", stop_reason: "stop" },
    ]);
    let run = harness(server, {
      claimToolCall: (turnId, callId, name, sessionId) =>
        restarted.claim(7, sessionId, turnId, callId, name),
      resolveToolCall: (turnId, callId, result) => restarted.resolve(turnId, callId, result),
    });
    await runHermesTurn({
      baseUrl: "https://hermes.test",
      apiKey: "a".repeat(64),
      workspaceId: "workspace-1",
      chatId: "7",
      clientTurnId: "crash-replay",
      inputText: "create",
      tools: [sideEffectTool],
      signal: new AbortController().signal,
      hooks: run.hooks,
      fetch: run.fetch,
    });
    expect(mutationCount).toBe(1);
    expect(server.toolResults[0]).toMatchObject({ result: "gadget-17", is_error: false });
  });

  it.each(["connection_requested", "awaiting_action_decision", "callbacks_complete"])(
    "uses graceful after_current_call control for %s after a tool",
    async (reason) => {
      let server = new FakeHermesServer([
        { seq: 1, event: "turn.started" },
        { seq: 2, event: "message.start" },
        { seq: 3, event: "tool_call.start", call_id: "call-1", name: "readFile" },
        { seq: 4, event: "tool_call.end", call_id: "call-1", arguments: { filename: "a.txt" } },
        { seq: 5, event: "turn.end", status: "completed", stop_reason: "connection_requested" },
      ]);
      let run = harness(server, { pauseReasonAfterTool: () => reason });
      await runHermesTurn({
        baseUrl: "https://hermes.test",
        apiKey: "a".repeat(64),
        workspaceId: "workspace-1",
        chatId: "7",
        clientTurnId: "chat-7-seq-6",
        inputText: "connect",
        tools: [
          tool(async () => ({
            content: [{ type: "text", text: "requested" }],
            details: {},
          })),
        ],
        signal: new AbortController().signal,
        hooks: run.hooks,
        fetch: run.fetch,
      });
      expect(server.controls).toEqual([
        {
          protocol_version: 1,
          signal: "end_turn",
          mode: "after_current_call",
          reason,
        },
      ]);
    },
  );

  it("ends a turn gracefully at the fifteen-minute wall-clock cap", async () => {
    let server = new FakeHermesServer([]);
    let encoder = new TextEncoder();
    server.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      let request = new Request(input, init);
      let url = new URL(request.url);
      let body =
        request.method === "POST" ? ((await request.json()) as Record<string, unknown>) : undefined;
      server.requests.push({ url, method: request.method, body });
      if (url.pathname.endsWith("/control")) {
        server.controls.push(body!);
        return Response.json({ ok: true });
      }
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  protocol_version: 1,
                  turn_id: "turn-1",
                  session_id: "session-1",
                  seq: 1,
                  event: "turn.started",
                  timestamp: 1,
                })}\n\n`,
              ),
            );
            setTimeout(() => {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    protocol_version: 1,
                    turn_id: "turn-1",
                    session_id: "session-1",
                    seq: 2,
                    event: "turn.end",
                    timestamp: 1,
                    status: "completed",
                    stop_reason: "turn_time_cap",
                  })}\n\n`,
                ),
              );
              controller.close();
            }, 20);
          },
        }),
      );
    };
    let run = harness(server);
    await runHermesTurn({
      baseUrl: "https://hermes.test",
      apiKey: "a".repeat(64),
      workspaceId: "workspace-1",
      chatId: "7",
      clientTurnId: "time-cap",
      inputText: "work",
      tools: [],
      signal: new AbortController().signal,
      hooks: run.hooks,
      fetch: server.fetch,
      turnTimeoutMs: 1,
    });
    expect(server.controls).toContainEqual({
      protocol_version: 1,
      signal: "end_turn",
      mode: "after_current_call",
      reason: "turn_time_cap",
    });
  });

  it("posts first-session workspace deltas after turn.started and tolerates a 409", async () => {
    let server = new FakeHermesServer(terminalEvents());
    server.deltaStatus = 409;
    let run = harness(server);
    await runHermesTurn({
      baseUrl: "https://hermes.test",
      apiKey: "a".repeat(64),
      workspaceId: "workspace-1",
      chatId: "7",
      clientTurnId: "chat-7-seq-8",
      inputText: "reconcile",
      tools: [],
      workspaceDeltas: [{ deltaId: "chat-7-seq-4-revert", payload: { type: "revert" } }],
      signal: new AbortController().signal,
      hooks: run.hooks,
      fetch: run.fetch,
    });
    expect(server.deltas).toEqual([
      {
        protocol_version: 1,
        delta_id: "chat-7-seq-4-revert",
        workspace_id: "workspace-1",
        chat_id: "7",
        payload: { type: "revert" },
      },
    ]);
    expect(run.events.some((event) => event.type === "turn_end")).toBe(true);
  });

  it("accepts established-session deltas before posting the dependent user turn", async () => {
    let server = new FakeHermesServer(terminalEvents());
    let run = harness(server);
    await runHermesTurn({
      baseUrl: "https://hermes.test",
      apiKey: "a".repeat(64),
      workspaceId: "workspace-1",
      chatId: "7",
      clientTurnId: "chat-7-seq-10",
      inputText: "what changed?",
      tools: [],
      sessionEstablished: true,
      workspaceDeltas: [
        { deltaId: "chat-7-seq-9-user-changes", payload: { type: "user_changes" } },
      ],
      signal: new AbortController().signal,
      hooks: run.hooks,
      fetch: run.fetch,
    });
    expect(server.requests.map((request) => request.url.pathname)).toEqual([
      "/api/workshop/v1/sessions/workspace-1/7/deltas",
      "/api/workshop/v1/turns",
    ]);
  });

  it("invalidates a stale session on delta 409 and establishes a replacement turn", async () => {
    let server = new FakeHermesServer(terminalEvents(), [], "session-replacement");
    server.deltaStatus = 409;
    let invalidations = 0;
    let run = harness(server, {invalidateSession: () => invalidations++});
    await runHermesTurn({
      baseUrl: "https://hermes.test",
      apiKey: "a".repeat(64),
      workspaceId: "workspace-1",
      chatId: "7",
      clientTurnId: "replace-session",
      inputText: "continue",
      tools: [],
      sessionEstablished: true,
      workspaceDeltas: [{deltaId: "delta-1", payload: {type: "user_changes"}}],
      signal: new AbortController().signal,
      hooks: run.hooks,
      fetch: run.fetch,
    });
    expect(invalidations).toBe(1);
    expect(server.requests.map(request => request.url.pathname)).toEqual([
      "/api/workshop/v1/sessions/workspace-1/7/deltas",
      "/api/workshop/v1/turns",
      "/api/workshop/v1/sessions/workspace-1/7/deltas",
    ]);
    expect(run.sessions).toEqual(["session-replacement"]);
  });

  it("logs a failed non-409 delta and does not block the dependent turn", async () => {
    let server = new FakeHermesServer(terminalEvents());
    server.deltaStatus = 503;
    let failures: unknown[] = [];
    let run = harness(server, {onDeltaFailure: failure => failures.push(failure)});
    await runHermesTurn({
      baseUrl: "https://hermes.test",
      apiKey: "a".repeat(64),
      workspaceId: "workspace-1",
      chatId: "7",
      clientTurnId: "delta-failure",
      inputText: "continue",
      tools: [],
      sessionEstablished: true,
      workspaceDeltas: [{deltaId: "delta-1", payload: {type: "user_changes"}}],
      signal: new AbortController().signal,
      hooks: run.hooks,
      fetch: run.fetch,
      requestTimeoutMs: 10,
    });
    expect(failures).toEqual([{kind: "http", status: 503}]);
    expect(server.requests.map(request => request.url.pathname)).toEqual([
      "/api/workshop/v1/sessions/workspace-1/7/deltas",
      "/api/workshop/v1/turns",
    ]);
  });

  it("bounds a silent SSE with the idle timeout", async () => {
    let run = harness(new FakeHermesServer([]));
    await expect(runHermesTurn({
      baseUrl: "https://hermes.test",
      apiKey: "a".repeat(64),
      workspaceId: "workspace-1",
      chatId: "7",
      clientTurnId: "idle",
      inputText: "wait",
      tools: [],
      attachedTurn: {
        turnId: "turn-idle", sessionId: "session-1", idempotencyKey: "wake-idle",
        eventsUrl: "https://hermes.test/api/workshop/v1/turns/turn-idle/events", afterSeq: 4,
      },
      signal: new AbortController().signal,
      hooks: run.hooks,
      fetch: async () => new Response(new ReadableStream({start() {}})),
      sseIdleTimeoutMs: 5,
      requestTimeoutMs: 10,
    })).rejects.toThrow("idle too long");
  });

  it("enforces the hard local turn deadline even when Hermes ignores end_turn", async () => {
    let encoder = new TextEncoder();
    let run = harness(new FakeHermesServer([]));
    let fetcher: typeof fetch = async (input, init) => {
      let request = new Request(input, init);
      if (new URL(request.url).pathname.endsWith("/control")) return Response.json({ok: true});
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            protocol_version: 1, turn_id: "turn-hard", session_id: "session-1",
            seq: 1, event: "turn.started", timestamp: 1,
          })}\n\n`));
        },
      }));
    };
    await expect(runHermesTurn({
      baseUrl: "https://hermes.test",
      apiKey: "a".repeat(64),
      workspaceId: "workspace-1",
      chatId: "7",
      clientTurnId: "hard-deadline",
      inputText: "wait",
      tools: [],
      attachedTurn: {
        turnId: "turn-hard", sessionId: "session-1", idempotencyKey: "wake-hard",
        eventsUrl: "https://hermes.test/api/workshop/v1/turns/turn-hard/events", afterSeq: 0,
      },
      signal: new AbortController().signal,
      hooks: run.hooks,
      fetch: fetcher,
      turnTimeoutMs: 5,
      hardDeadlineGraceMs: 5,
      sseIdleTimeoutMs: 1_000,
      requestTimeoutMs: 20,
    })).rejects.toThrow("hard local deadline");
  });

  it("interrupts a timed-out local tool, posts is_error, and continues the turn", async () => {
    let server = new FakeHermesServer(
      [
        {seq: 1, event: "turn.started"},
        {seq: 2, event: "message.start"},
        {seq: 3, event: "tool_call.start", call_id: "call-timeout", name: "readFile"},
        {seq: 4, event: "tool_call.end", call_id: "call-timeout", arguments: {filename: "a"}},
      ],
      [{seq: 5, event: "turn.end", status: "completed", stop_reason: "stop"}],
    );
    let detached: Promise<unknown>[] = [];
    let run = harness(server, {waitUntil: promise => detached.push(promise)});
    await runHermesTurn({
      baseUrl: "https://hermes.test",
      apiKey: "a".repeat(64),
      workspaceId: "workspace-1",
      chatId: "7",
      clientTurnId: "tool-timeout",
      inputText: "read",
      tools: [tool(() => new Promise(() => {}))],
      signal: new AbortController().signal,
      hooks: run.hooks,
      fetch: run.fetch,
      localToolTimeoutMs: 5,
    });
    expect(server.toolResults).toEqual([{
      protocol_version: 1,
      result: "local execution timeout",
      is_error: true,
    }]);
    expect(run.stored.get("turn-1.call-timeout")).toMatchObject({
      result: "local execution timeout", isError: true,
    });
    expect(detached).toHaveLength(1);
  });

  it("detaches an in-flight local tool on user abort and persists its eventual result", async () => {
    let server = new FakeHermesServer([
      {seq: 1, event: "turn.started"},
      {seq: 2, event: "message.start"},
      {seq: 3, event: "tool_call.start", call_id: "call-abort", name: "readFile"},
      {seq: 4, event: "tool_call.end", call_id: "call-abort", arguments: {filename: "a"}},
    ]);
    let controller = new AbortController();
    let finish = Promise.withResolvers<{content: [{type: "text"; text: string}]}>();
    let detached: Promise<unknown>[] = [];
    let run = harness(server, {waitUntil: promise => detached.push(promise)});
    await runHermesTurn({
      baseUrl: "https://hermes.test",
      apiKey: "a".repeat(64),
      workspaceId: "workspace-1",
      chatId: "7",
      clientTurnId: "tool-abort",
      inputText: "read",
      tools: [tool(async () => {
        controller.abort();
        return finish.promise;
      })],
      signal: controller.signal,
      hooks: run.hooks,
      fetch: run.fetch,
      localToolTimeoutMs: 1_000,
    });
    expect(server.toolResults).toEqual([]);
    expect(detached).toHaveLength(1);
    finish.resolve({content: [{type: "text", text: "finished once"}]});
    await detached[0];
    expect(run.stored.get("turn-1.call-abort")).toMatchObject({
      result: "finished once", isError: false,
    });
  });

  it("does not start a tool when cancellation arrives during toolcall_end projection", async () => {
    let server = new FakeHermesServer([
      {seq: 1, event: "turn.started"},
      {seq: 2, event: "message.start"},
      {seq: 3, event: "tool_call.start", call_id: "call-cancel-race", name: "readFile"},
      {
        seq: 4, event: "tool_call.end", call_id: "call-cancel-race",
        arguments: {filename: "a"},
      },
      {seq: 5, event: "text.delta", delta: "must not be consumed"},
      {seq: 6, event: "turn.end", status: "completed", stop_reason: "stop"},
    ]);
    let controller = new AbortController();
    let execute = vi.fn(async () => ({content: [{type: "text" as const, text: "wrong"}]}));
    let run = harness(server);
    let baseEmit = run.hooks.emit;
    run.hooks.emit = async event => {
      await baseEmit(event);
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "toolcall_end"
      ) {
        controller.abort();
      }
    };
    run.hooks.claimToolCall = async (turnId, callId, _toolName, _sessionId, signal) => {
      if (signal.aborted) {
        let result: HermesToolResult = {
          result: "local execution aborted",
          isError: true,
          content: [{type: "text", text: "local execution aborted"}],
        };
        run.stored.set(`${turnId}.${callId}`, result);
        return {execute: false, result};
      }
      return {execute: true};
    };
    await runHermesTurn({
      baseUrl: "https://hermes.test",
      apiKey: "a".repeat(64),
      workspaceId: "workspace-1",
      chatId: "7",
      clientTurnId: "cancel-at-tool-boundary",
      inputText: "cancel",
      tools: [tool(execute)],
      signal: controller.signal,
      hooks: run.hooks,
      fetch: run.fetch,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(run.stored.get("turn-1.call-cancel-race")).toMatchObject({
      result: "local execution aborted", isError: true,
    });
    expect(server.toolResults).toEqual([]);
    expect(run.events.some(event =>
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta",
    )).toBe(false);
  });

  it("cancels a silent SSE immediately when the user aborts", async () => {
    let encoder = new TextEncoder();
    let controller = new AbortController();
    let run = harness(new FakeHermesServer([]), {
      onTurnStarted: () => controller.abort(),
    });
    let fetcher: typeof fetch = async (input, init) => {
      let request = new Request(input, init);
      if (new URL(request.url).pathname.endsWith("/control")) return Response.json({ok: true});
      return new Response(new ReadableStream({
        start(stream) {
          stream.enqueue(encoder.encode(`data: ${JSON.stringify({
            protocol_version: 1, turn_id: "turn-abort", session_id: "session-1",
            seq: 1, event: "turn.started", timestamp: 1,
          })}\n\n`));
        },
      }));
    };
    await runHermesTurn({
      baseUrl: "https://hermes.test",
      apiKey: "a".repeat(64),
      workspaceId: "workspace-1",
      chatId: "7",
      clientTurnId: "silent-abort",
      inputText: "stop",
      tools: [],
      signal: controller.signal,
      hooks: run.hooks,
      fetch: fetcher,
      sseIdleTimeoutMs: 60_000,
    });
  });

  it("maps user cancellation to immediate abort control", async () => {
    let server = new FakeHermesServer(terminalEvents());
    let controller = new AbortController();
    let run = harness(server, {
      onTurnStarted: (_turnId, sessionId) => {
        run.sessions.push(sessionId);
        controller.abort();
      },
    });
    await runHermesTurn({
      baseUrl: "https://hermes.test",
      apiKey: "a".repeat(64),
      workspaceId: "workspace-1",
      chatId: "7",
      clientTurnId: "chat-7-seq-9",
      inputText: "cancel",
      tools: [],
      signal: controller.signal,
      hooks: run.hooks,
      fetch: run.fetch,
    });
    expect(server.controls).toEqual([
      {
        protocol_version: 1,
        signal: "abort",
        mode: "immediate",
        reason: "user_cancelled",
      },
    ]);
  });

  it("retries a failed abort control without leaking its response body", async () => {
    let server = new FakeHermesServer(terminalEvents());
    server.controlStatuses.push(500);
    let controller = new AbortController();
    let run = harness(server, {
      onTurnStarted: () => {
        controller.abort();
      },
    });
    await runHermesTurn({
      baseUrl: "https://hermes.test",
      apiKey: "a".repeat(64),
      workspaceId: "workspace-1",
      chatId: "7",
      clientTurnId: "chat-7-seq-11",
      inputText: "cancel",
      tools: [],
      signal: controller.signal,
      hooks: run.hooks,
      fetch: run.fetch,
      sleep: async () => {},
    });
    expect(server.controls).toHaveLength(2);
  });

  it("reports an epoch change and converts provider error turns", async () => {
    let firstServer = new FakeHermesServer(terminalEvents(), [], "session-1");
    let secondServer = new FakeHermesServer(
      [
        { seq: 1, event: "turn.started" },
        { seq: 2, event: "message.start" },
        {
          seq: 3,
          event: "error",
          code: "provider_error",
          message: "provider unavailable",
          retryable: true,
        },
        { seq: 4, event: "turn.end", status: "error", stop_reason: "agent_error" },
      ],
      [],
      "session-2",
    );
    let run = harness(firstServer);
    let currentSession: string | undefined;
    let epochChanges = 0;
    run.hooks.onTurnStarted = (_turnId, sessionId) => {
      run.sessions.push(sessionId);
      if (currentSession && currentSession !== sessionId) epochChanges++;
      currentSession = sessionId;
    };
    let common = {
      baseUrl: "https://hermes.test",
      apiKey: "a".repeat(64),
      workspaceId: "workspace-1",
      chatId: "7",
      inputText: "fail",
      tools: [],
      signal: new AbortController().signal,
      hooks: run.hooks,
    };
    await runHermesTurn({
      ...common,
      clientTurnId: "chat-7-seq-6",
      fetch: firstServer.fetch,
    });
    await runHermesTurn({
      ...common,
      clientTurnId: "chat-7-seq-7",
      fetch: secondServer.fetch,
    });
    expect(run.sessions).toEqual(["session-1", "session-2"]);
    expect(epochChanges).toBe(1);
    expect(run.events.filter((event) => event.type === "turn_end").at(-1)).toMatchObject({
      message: { stopReason: "error", errorMessage: "provider unavailable" },
    });
  });

  it.each([
    ["error", "agent_error", "error"],
    ["aborted", "user_cancelled", "aborted"],
    ["interrupted", "gateway_restart", "error"],
  ])("maps terminal status %s independently of reason", async (status, reason, expected) => {
    let server = new FakeHermesServer([
      { seq: 1, event: "turn.started" },
      { seq: 2, event: "turn.end", status, stop_reason: reason },
    ]);
    let run = harness(server);
    await runHermesTurn({
      baseUrl: "https://hermes.test",
      apiKey: "a".repeat(64),
      workspaceId: "workspace-1",
      chatId: "7",
      clientTurnId: `status-${status}`,
      inputText: "status",
      tools: [],
      signal: new AbortController().signal,
      hooks: run.hooks,
      fetch: run.fetch,
    });
    expect(run.events.find((event) => event.type === "turn_end")).toMatchObject({
      message: { stopReason: expected },
    });
  });

  it("rejects a session epoch change inside one event stream", async () => {
    let body = [
      {
        protocol_version: 1,
        turn_id: "turn-1",
        session_id: "session-1",
        seq: 1,
        event: "turn.started",
        timestamp: 1,
      },
      {
        protocol_version: 1,
        turn_id: "turn-1",
        session_id: "session-2",
        seq: 2,
        event: "turn.end",
        timestamp: 1,
        status: "completed",
        stop_reason: "stop",
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("");
    let run = harness(new FakeHermesServer([]));
    await expect(
      runHermesTurn({
        baseUrl: "https://hermes.test",
        apiKey: "a".repeat(64),
        workspaceId: "workspace-1",
        chatId: "7",
        clientTurnId: "epoch-change",
        inputText: "status",
        tools: [],
        signal: new AbortController().signal,
        hooks: run.hooks,
        fetch: async () => new Response(body),
      }),
    ).rejects.toThrow("changed session_id");
  });
});
