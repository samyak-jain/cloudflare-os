import { describe, expect, it, vi } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import type { AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";

import {
  runHermesTurn, type HermesDriverHooks, type HermesToolResult,
} from "../src/hermes-driver";

type EventInput = {seq: number, event: string, [key: string]: unknown};

function sse(events: EventInput[], sessionId = "session-1", turnId = "turn-1"): Response {
  let body = events.map(event => `event: ${event.event}\ndata: ${JSON.stringify({
    protocol_version: 1,
    turn_id: turnId,
    session_id: sessionId,
    timestamp: 1,
    ...event,
  })}\n\n`).join("");
  return new Response(body, {headers: {"Content-Type": "text/event-stream"}});
}

class FakeHermesServer {
  requests: {url: URL, method: string, body?: Record<string, unknown>}[] = [];
  toolResults: Record<string, unknown>[] = [];
  controls: Record<string, unknown>[] = [];
  deltas: Record<string, unknown>[] = [];
  reconnectAfter: string[] = [];
  deltaStatus = 200;

  constructor(private initial: EventInput[], private replay: EventInput[] = [],
              private sessionId = "session-1") {}

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let request = new Request(input, init);
    let url = new URL(request.url);
    let body = request.method === "POST" ? await request.json() as Record<string, unknown> : undefined;
    this.requests.push({url, method: request.method, body});
    if (url.pathname === "/api/workshop/v1/turns") {
      return sse(this.initial, this.sessionId);
    }
    if (url.pathname.endsWith("/events")) {
      this.reconnectAfter.push(url.searchParams.get("after_seq") ?? "");
      return sse(this.replay, this.sessionId);
    }
    if (url.pathname.includes("/tool-results/")) {
      this.toolResults.push(body!);
      return Response.json({ok: true});
    }
    if (url.pathname.endsWith("/control")) {
      this.controls.push(body!);
      return Response.json({ok: true});
    }
    if (url.pathname.endsWith("/deltas")) {
      this.deltas.push(body!);
      return this.deltaStatus === 200
        ? Response.json({accepted: true})
        : Response.json({error: "session missing"}, {status: this.deltaStatus});
    }
    return new Response("not found", {status: 404});
  };
}

function tool(execute: AgentTool["execute"]): AgentTool {
  return {
    name: "readFile",
    label: "Read file",
    description: "Read a file.",
    parameters: Type.Object({filename: Type.String()}),
    execute,
  };
}

function harness(server: FakeHermesServer, overrides: Partial<HermesDriverHooks> = {}) {
  let events: AgentEvent[] = [];
  let stored = new Map<string, HermesToolResult>();
  let sessions: string[] = [];
  let hooks: HermesDriverHooks = {
    emit: event => { events.push(event); },
    getToolResult: (turnId, callId) => stored.get(`${turnId}.${callId}`),
    putToolResult: (turnId, callId, result) => { stored.set(`${turnId}.${callId}`, result); },
    onTurnStarted: (_turnId, sessionId) => { sessions.push(sessionId); },
    pauseReasonAfterMessage: () => undefined,
    pauseReasonAfterTool: () => undefined,
    ...overrides,
  };
  return {events, hooks, sessions, stored, fetch: server.fetch};
}

function terminalEvents(from = 1): EventInput[] {
  return [
    {seq: from, event: "turn.started", catalog_version: "catalog"},
    {seq: from + 1, event: "message.start"},
    {seq: from + 2, event: "text.delta", delta: "hello"},
    {seq: from + 3, event: "usage", input_tokens: 3, output_tokens: 2},
    {seq: from + 4, event: "turn.end", status: "completed", stop_reason: "stop"},
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
      tools: [tool(async () => ({content: [{type: "text", text: "unused"}], details: {}}))],
      signal: new AbortController().signal,
      hooks: run.hooks,
      fetch: run.fetch,
    });

    expect(server.requests[0].body).toMatchObject({
      protocol_version: 1,
      client_turn_id: "chat-7-seq-3",
      input: {type: "user", text: "new message"},
      tools: [{name: "readFile", description: "Read a file.", input_schema: {type: "object"}}],
    });
    let end = run.events.find(event => event.type === "turn_end");
    expect(end).toMatchObject({
      type: "turn_end",
      message: {stopReason: "stop", usage: {totalTokens: 5}},
    });
  });

  it("reattaches with after_seq when the initial SSE subscriber disconnects", async () => {
    let server = new FakeHermesServer(terminalEvents().slice(0, 3), terminalEvents(1).slice(3));
    let run = harness(server);
    await runHermesTurn({
      baseUrl: "https://hermes.test", apiKey: "a".repeat(64), workspaceId: "workspace-1",
      chatId: "7", clientTurnId: "chat-7-seq-4", inputText: "hi", tools: [],
      signal: new AbortController().signal, hooks: run.hooks, fetch: run.fetch,
    });
    expect(server.reconnectAfter).toEqual(["3"]);
    expect(run.events.some(event => event.type === "turn_end")).toBe(true);
  });

  it("executes a duplicate remote call once and re-posts the durable result", async () => {
    let execute = vi.fn(async () => ({
      content: [{type: "text" as const, text: "contents"}], details: {observed: true},
    }));
    let server = new FakeHermesServer([
      {seq: 1, event: "turn.started"},
      {seq: 2, event: "message.start"},
      {seq: 3, event: "tool_call.start", call_id: "call-1", name: "readFile"},
      {seq: 4, event: "tool_call.arguments.delta", call_id: "call-1",
       delta: "{\"filename\":\"a.txt\"}"},
      {seq: 5, event: "tool_call.end", call_id: "call-1", arguments: {filename: "a.txt"}},
      {seq: 6, event: "tool_call.start", call_id: "call-1", name: "readFile"},
      {seq: 7, event: "tool_call.end", call_id: "call-1", arguments: {filename: "a.txt"}},
      {seq: 8, event: "turn.end", status: "completed", stop_reason: "stop"},
    ]);
    let run = harness(server);
    await runHermesTurn({
      baseUrl: "https://hermes.test", apiKey: "a".repeat(64), workspaceId: "workspace-1",
      chatId: "7", clientTurnId: "chat-7-seq-5", inputText: "read it", tools: [tool(execute)],
      signal: new AbortController().signal, hooks: run.hooks, fetch: run.fetch,
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(server.toolResults).toEqual([
      {protocol_version: 1, result: "contents", is_error: false},
      {protocol_version: 1, result: "contents", is_error: false},
    ]);
  });

  it("uses graceful after_current_call control for Workshop pause conditions", async () => {
    let server = new FakeHermesServer([
      {seq: 1, event: "turn.started"},
      {seq: 2, event: "message.start"},
      {seq: 3, event: "tool_call.start", call_id: "call-1", name: "readFile"},
      {seq: 4, event: "tool_call.end", call_id: "call-1", arguments: {filename: "a.txt"}},
      {seq: 5, event: "turn.end", status: "paused", stop_reason: "connection_requested"},
    ]);
    let run = harness(server, {pauseReasonAfterTool: () => "connection_requested"});
    await runHermesTurn({
      baseUrl: "https://hermes.test", apiKey: "a".repeat(64), workspaceId: "workspace-1",
      chatId: "7", clientTurnId: "chat-7-seq-6", inputText: "connect", tools: [tool(async () => ({
        content: [{type: "text", text: "requested"}], details: {},
      }))], signal: new AbortController().signal, hooks: run.hooks, fetch: run.fetch,
    });
    expect(server.controls).toEqual([{
      protocol_version: 1,
      signal: "end_turn",
      mode: "after_current_call",
      reason: "connection_requested",
    }]);
  });

  it("posts stable workspace deltas after session establishment and tolerates a 409", async () => {
    let server = new FakeHermesServer(terminalEvents());
    server.deltaStatus = 409;
    let run = harness(server);
    await runHermesTurn({
      baseUrl: "https://hermes.test", apiKey: "a".repeat(64), workspaceId: "workspace-1",
      chatId: "7", clientTurnId: "chat-7-seq-8", inputText: "reconcile", tools: [],
      workspaceDeltas: [{deltaId: "chat-7-seq-4-revert", payload: {type: "revert"}}],
      signal: new AbortController().signal, hooks: run.hooks, fetch: run.fetch,
    });
    expect(server.deltas).toEqual([{
      protocol_version: 1,
      delta_id: "chat-7-seq-4-revert",
      workspace_id: "workspace-1",
      chat_id: "7",
      payload: {type: "revert"},
    }]);
    expect(run.events.some(event => event.type === "turn_end")).toBe(true);
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
      baseUrl: "https://hermes.test", apiKey: "a".repeat(64), workspaceId: "workspace-1",
      chatId: "7", clientTurnId: "chat-7-seq-9", inputText: "cancel", tools: [],
      signal: controller.signal, hooks: run.hooks, fetch: run.fetch,
    });
    expect(server.controls).toEqual([{
      protocol_version: 1,
      signal: "abort",
      mode: "immediate",
      reason: "user_cancelled",
    }]);
  });

  it("reports an epoch change and converts provider error turns", async () => {
    let firstServer = new FakeHermesServer(terminalEvents(), [], "session-1");
    let secondServer = new FakeHermesServer([
      {seq: 1, event: "turn.started"},
      {seq: 2, event: "message.start"},
      {seq: 3, event: "error", code: "provider_error", message: "provider unavailable",
       retryable: true},
      {seq: 4, event: "turn.end", status: "failed", stop_reason: "error"},
    ], [], "session-2");
    let run = harness(firstServer);
    let currentSession: string | undefined;
    let epochChanges = 0;
    run.hooks.onTurnStarted = (_turnId, sessionId) => {
      run.sessions.push(sessionId);
      if (currentSession && currentSession !== sessionId) epochChanges++;
      currentSession = sessionId;
    };
    let common = {
      baseUrl: "https://hermes.test", apiKey: "a".repeat(64), workspaceId: "workspace-1",
      chatId: "7", inputText: "fail", tools: [], signal: new AbortController().signal,
      hooks: run.hooks,
    };
    await runHermesTurn({
      ...common, clientTurnId: "chat-7-seq-6", fetch: firstServer.fetch,
    });
    await runHermesTurn({
      ...common, clientTurnId: "chat-7-seq-7", fetch: secondServer.fetch,
    });
    expect(run.sessions).toEqual(["session-1", "session-2"]);
    expect(epochChanges).toBe(1);
    expect(run.events.filter(event => event.type === "turn_end").at(-1)).toMatchObject({
      message: {stopReason: "error", errorMessage: "provider unavailable"},
    });
  });
});
