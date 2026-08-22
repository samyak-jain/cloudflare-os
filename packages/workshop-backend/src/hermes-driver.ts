import type {
  AssistantMessage,
  AssistantMessageEvent,
  Message,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import {
  HERMES_PROTOCOL_VERSION as PROTOCOL_VERSION,
  makeHermesTurnRequest,
} from "./hermes-protocol";

/** A completed Workshop tool call, durably cached by the owning workspace. */
export type HermesToolResult = {
  result: string;
  isError: boolean;
  content: ToolResultMessage["content"];
  details?: unknown;
};

/** Durable identity of a Hermes turn announced by the authenticated wake endpoint. */
export type HermesAttachedTurn = {
  turnId: string;
  sessionId: string;
  eventsUrl: string;
  idempotencyKey: string;
  /** Durable projection cursor for this accepted attachment. */
  afterSeq: number;
};

/** Transport and persistence callbacks supplied by the Workshop agent/Overseer boundary. */
export interface HermesDriverHooks {
  emit(event: AgentEvent): Promise<void> | void;
  emitTerminal?(turnId: string, sequence: number, event: AgentEvent): Promise<void> | void;
  claimToolCall(
    turnId: string,
    callId: string,
    toolName: string,
    sessionId: string,
  ): Promise<{ execute: true } | { execute: false; result: HermesToolResult }>;
  resolveToolCall(turnId: string, callId: string, result: HermesToolResult): void;
  onTurnStarted(turnId: string, sessionId: string): void;
  onTerminalProjected?(turnId: string, sequence: number): void;
  invalidateSession?(): void;
  onDeltaFailure?(failure: HermesFailureMetadata): void;
  pauseReasonAfterMessage(): string | undefined;
  pauseReasonAfterTool(): string | undefined;
}

/** Inputs for one user-created or wake-attached Hermes turn. */
export interface HermesDriverOptions {
  baseUrl: string;
  apiKey: string;
  workspaceId: string;
  chatId: string;
  clientTurnId: string;
  inputText: string;
  tools: AgentTool[];
  signal: AbortSignal;
  hooks: HermesDriverHooks;
  attachedTurn?: HermesAttachedTurn;
  /** True when the Overseer already knows this chat's Hermes epoch. */
  sessionEstablished?: boolean;
  workspaceDeltas?: HermesWorkspaceDelta[];
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Test override; production turns are capped at fifteen minutes. */
  turnTimeoutMs?: number;
  /** Test override for the production hard-deadline grace period of sixty seconds. */
  hardDeadlineGraceMs?: number;
  /** Per-request header deadline. */
  requestTimeoutMs?: number;
  /** Maximum time an open SSE stream may produce no event. */
  sseIdleTimeoutMs?: number;
  /** Deterministic test seam for retry jitter. */
  random?: () => number;
}

/** One bounded, idempotent workspace-state notice derived during Workshop replay. */
export type HermesWorkspaceDelta = { deltaId: string; payload: Record<string, unknown> };

type HermesEvent = {
  protocol_version: number;
  turn_id: string;
  session_id: string;
  seq: number;
  event: string;
  timestamp: number;
  [key: string]: unknown;
};

/** Sanitized Hermes transport failure; response bodies are deliberately never retained. */
export class HermesHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(`Hermes request failed with status ${status}.`);
  }
}

/** A malformed or unsupported Hermes response. */
export class HermesProtocolError extends Error {}

/** A bounded local transport operation exceeded its deadline. */
export class HermesTimeoutError extends Error {}

/** Status/code-only failure information safe to retain in Durable Object storage. */
export type HermesFailureMetadata = {
  kind: "http" | "protocol" | "transport" | "timeout";
  status?: number;
  code?: string;
};

/** Classify a driver failure without retaining provider response bodies. */
export function classifyHermesFailure(error: unknown): {
  metadata: HermesFailureMetadata;
  retryable: boolean;
} {
  if (error instanceof HermesHttpError) {
    return {
      metadata: { kind: "http", status: error.status },
      retryable: error.status === 429 || error.status >= 500,
    };
  }
  if (error instanceof HermesProtocolError) {
    return { metadata: { kind: "protocol", code: error.name }, retryable: false };
  }
  if (error instanceof HermesTimeoutError) {
    return { metadata: { kind: "timeout", code: error.name }, retryable: true };
  }
  return {
    metadata: {
      kind: "transport",
      code: error instanceof Error ? error.name.slice(0, 64) : "UnknownError",
    },
    retryable: true,
  };
}

function usage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : `${error}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    let object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  let encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Hermes payload contains a non-JSON value.");
  return encoded;
}

function boundedDeltaPayload(payload: Record<string, unknown>): Record<string, unknown> {
  let canonical = canonicalJson(payload);
  if (new TextEncoder().encode(canonical).byteLength <= 900_000) return payload;
  return {
    type: typeof payload.type === "string" ? payload.type : "workspace_delta",
    truncated: true,
    canonical_prefix: canonical.slice(0, 180_000),
  };
}

function requireString(event: HermesEvent, field: string): string {
  let value = event[field];
  if (typeof value !== "string") {
    throw new HermesProtocolError(`Hermes event field ${field} must be a string.`);
  }
  return value;
}

function parseEvent(value: unknown): HermesEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HermesProtocolError("Hermes SSE data must be a JSON object.");
  }
  let event = value as HermesEvent;
  if (
    event.protocol_version !== PROTOCOL_VERSION ||
    typeof event.turn_id !== "string" ||
    typeof event.session_id !== "string" ||
    !Number.isSafeInteger(event.seq) ||
    event.seq < 1 ||
    typeof event.event !== "string" ||
    typeof event.timestamp !== "number"
  ) {
    throw new HermesProtocolError("Hermes SSE event has an invalid protocol envelope.");
  }
  return event;
}

async function* sseEvents(
  response: Response,
  idleTimeoutMs: number,
  signal: AbortSignal,
): AsyncGenerator<HermesEvent> {
  if (!response.body) throw new HermesProtocolError("Hermes returned an SSE response with no body.");
  let decoder = new TextDecoder();
  let buffer = "";
  let reader = response.body.getReader();
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new HermesTimeoutError("Hermes SSE stream was idle too long.")),
        idleTimeoutMs,
      );
    });
    let abortListener: (() => void) | undefined;
    let aborted = new Promise<never>((_resolve, reject) => {
      abortListener = () => reject(
        signal.reason instanceof Error ? signal.reason : new Error("Hermes stream aborted."),
      );
      if (signal.aborted) abortListener();
      else signal.addEventListener("abort", abortListener, {once: true});
    });
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await Promise.race([reader.read(), timeout, aborted]);
    } catch (error) {
      await reader.cancel(error).catch(() => {});
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (abortListener) signal.removeEventListener("abort", abortListener);
    }
    if (result.done) break;
    let chunk = result.value;
    buffer += decoder.decode(chunk, { stream: true }).replaceAll("\r\n", "\n");
    while (true) {
      let boundary = buffer.indexOf("\n\n");
      if (boundary < 0) break;
      let frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) {
        try {
          yield parseEvent(JSON.parse(data));
        } catch (error) {
          if (error instanceof HermesProtocolError) throw error;
          throw new HermesProtocolError("Hermes SSE data is not valid JSON.");
        }
      }
    }
  }
  buffer += decoder.decode();
  let data = buffer
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (data) {
    try {
      yield parseEvent(JSON.parse(data));
    } catch (error) {
      if (error instanceof HermesProtocolError) throw error;
      throw new HermesProtocolError("Hermes SSE data is not valid JSON.");
    }
  }
}

async function checkedFetch(
  fetcher: typeof globalThis.fetch,
  url: string,
  apiKey: string,
  signal: AbortSignal,
  timeoutMs: number,
  init?: RequestInit,
): Promise<Response> {
  let headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${apiKey}`);
  if (init?.body) headers.set("Content-Type", "application/json");
  let timeoutController = new AbortController();
  let timer = setTimeout(
    () => timeoutController.abort(new HermesTimeoutError("Hermes request timed out.")),
    timeoutMs,
  );
  let requestSignal = AbortSignal.any([signal, timeoutController.signal]);
  let response: Response;
  try {
    response = await fetcher(url, { ...init, headers, signal: requestSignal });
  } catch (error) {
    if (timeoutController.signal.aborted) {
      throw new HermesTimeoutError("Hermes request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    let retryAfter = response.headers.get("Retry-After");
    let seconds = retryAfter === null ? undefined : Number(retryAfter);
    let retryAfterMs =
      seconds !== undefined && Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : undefined;
    throw new HermesHttpError(response.status, retryAfterMs);
  }
  return response;
}

function resultText(content: ToolResultMessage["content"]): string {
  return content
    .map((part) => (part.type === "text" ? part.text : `[image result: ${part.mimeType}]`))
    .join("\n");
}

/**
 * Drive one Hermes-owned agent turn while projecting its stream through the existing pi AgentEvent
 * sink. Network detachment reattaches by sequence; only an explicit abort sends cancellation.
 */
export async function runHermesTurn(options: HermesDriverOptions): Promise<void> {
  let fetcher = options.fetch ?? globalThis.fetch;
  let sleep =
    options.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let retryDeadline = Date.now() + 15 * 60_000;
  let retryAttempt = 0;
  let toolsByName = new Map(options.tools.map((tool) => [tool.name, tool]));
  let lastSeq = options.attachedTurn?.afterSeq ?? 0;
  let turnId = options.attachedTurn?.turnId;
  let eventsUrl = options.attachedTurn?.eventsUrl;
  let terminal = false;
  let messageStarted = false;
  let controlSent: "abort" | "end_turn" | undefined;
  let controlPromise: Promise<void> | undefined;
  let textIndex: number | undefined;
  let thinkingIndex: number | undefined;
  let calls = new Map<string, { name: string; index: number; argumentsText: string }>();
  let toolResults = new Map<string, ToolResultMessage>();
  let providerError: string | undefined;
  let sessionId = options.attachedTurn?.sessionId;
  let turnCapTimer: ReturnType<typeof setTimeout> | undefined;
  let hardDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let hardDeadlineController = new AbortController();
  let runSignal = hardDeadlineController.signal;
  let requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  let sseIdleTimeoutMs = options.sseIdleTimeoutMs ?? 90_000;
  let random = options.random ?? Math.random;
  let currentUsage = usage();
  let deltasPosted = false;
  let partial: AssistantMessage = {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "hermes",
    model: "hermes",
    usage: currentUsage,
    stopReason: "pending",
    timestamp: Date.now(),
  };

  let emitUpdate = async (assistantMessageEvent: AssistantMessageEvent) => {
    await options.hooks.emit({
      type: "message_update",
      message: { ...partial },
      assistantMessageEvent,
    });
  };

  let postJson = async (path: string, body: unknown, signal = runSignal) => {
    await checkedFetch(fetcher, `${options.baseUrl}${path}`, options.apiKey, signal,
      requestTimeoutMs, {
      method: "POST",
      body: canonicalJson(body),
    });
  };

  let retryDelay = async (error: unknown) => {
    if (hardDeadlineController.signal.aborted) {
      throw new HermesTimeoutError("Hermes turn exceeded its hard local deadline.");
    }
    let classification = classifyHermesFailure(error);
    if (!classification.retryable || options.attachedTurn || Date.now() >= retryDeadline) {
      throw error;
    }
    let exponential = Math.min(30_000, 250 * 2 ** Math.min(retryAttempt++, 7));
    let jittered = Math.max(1, Math.round(exponential * (0.5 + random())));
    if (error instanceof HermesHttpError && error.retryAfterMs !== undefined) {
      let minimum = Math.min(error.retryAfterMs, 60_000);
      jittered = Math.max(jittered, minimum + Math.round(minimum * 0.25 * random()));
    }
    await sleep(jittered);
  };

  let retryPostJson = async (
    path: string,
    body: unknown,
    signal = runSignal,
  ) => {
    while (true) {
      try {
        await postJson(path, body, signal);
        retryAttempt = 0;
        return;
      } catch (error) {
        await retryDelay(error);
      }
    }
  };

  let postDeltas = async (allowMissingSession: boolean): Promise<"ok" | "session_missing"> => {
    if (deltasPosted) return "ok";
    for (let delta of options.workspaceDeltas ?? []) {
      try {
        await postJson(
          `/api/workshop/v1/sessions/${encodeURIComponent(options.workspaceId)}/` +
            `${encodeURIComponent(options.chatId)}/deltas`,
          {
            protocol_version: PROTOCOL_VERSION,
            delta_id: delta.deltaId,
            workspace_id: options.workspaceId,
            chat_id: options.chatId,
            payload: boundedDeltaPayload(delta.payload),
          },
        );
      } catch (error) {
        if (error instanceof HermesHttpError && error.status === 409) {
          if (!allowMissingSession) {
            options.hooks.invalidateSession?.();
            return "session_missing";
          }
        } else {
          options.hooks.onDeltaFailure?.(classifyHermesFailure(error).metadata);
        }
      }
    }
    deltasPosted = true;
    return "ok";
  };

  let sendControl = async (signal: "abort" | "end_turn", reason: string) => {
    if (!turnId || controlSent === "abort") return controlPromise;
    if (controlSent === signal) return controlPromise;
    controlSent = signal;
    // Cancellation controls use an independent bounded signal: the user signal which requested
    // the abort must not cancel the control request itself.
    controlPromise = retryPostJson(`/api/workshop/v1/turns/${encodeURIComponent(turnId)}/control`, {
      protocol_version: PROTOCOL_VERSION,
      signal,
      mode: signal === "abort" ? "immediate" : "after_current_call",
      reason,
    }, new AbortController().signal);
    await controlPromise;
  };

  let abortListener = () => {
    void sendControl("abort", "user_cancelled").catch(() => {});
  };
  options.signal.addEventListener("abort", abortListener, { once: true });
  hardDeadlineTimer = setTimeout(
    () => hardDeadlineController.abort(
      new HermesTimeoutError("Hermes turn exceeded its hard local deadline."),
    ),
    (options.turnTimeoutMs ?? 15 * 60_000) + (options.hardDeadlineGraceMs ?? 60_000),
  );

  let startResponse: Response | undefined;

  try {
    // An established session must observe replay-derived workspace state before it accepts the
    // dependent user turn. A first turn has no remote session to update yet, so it posts after
    // turn.started. A stale established-session 409 clears the local epoch and follows that same
    // post-start path for the replacement session.
    let sessionEstablished = options.sessionEstablished ?? false;
    if (!options.attachedTurn && sessionEstablished) {
      if (await postDeltas(false) === "session_missing") {
        sessionEstablished = false;
        deltasPosted = false;
      }
    }
    while (!terminal) {
      let progressed = false;
      try {
        let response = startResponse;
        startResponse = undefined;
        if (!response && !turnId && !options.attachedTurn) {
          response = await checkedFetch(
            fetcher,
            `${options.baseUrl}/api/workshop/v1/turns`,
            options.apiKey,
            runSignal,
            requestTimeoutMs,
            {
              method: "POST",
              body: canonicalJson(makeHermesTurnRequest(options)),
            },
          );
        } else if (!response) {
          if (!turnId)
            throw new HermesProtocolError("Hermes disconnected before announcing a turn id.");
          let url = eventsUrl
            ? new URL(eventsUrl, options.baseUrl)
            : new URL(
                `${options.baseUrl}/api/workshop/v1/turns/` +
                  `${encodeURIComponent(turnId)}/events`,
              );
          url.searchParams.set("after_seq", `${lastSeq}`);
          response = await checkedFetch(
            fetcher, url.toString(), options.apiKey, runSignal, requestTimeoutMs,
          );
        }

        for await (let event of sseEvents(response, sseIdleTimeoutMs, runSignal)) {
          if (event.seq <= lastSeq) continue;
          progressed = true;
          lastSeq = event.seq;
          if (turnId && event.turn_id !== turnId) {
            throw new HermesProtocolError("Hermes changed turn_id within an event stream.");
          }
          turnId = event.turn_id;
          if (sessionId && event.session_id !== sessionId) {
            throw new HermesProtocolError("Hermes changed session_id within an event stream.");
          }
          sessionId = event.session_id;

          switch (event.event) {
            case "turn.started":
              options.hooks.onTurnStarted(event.turn_id, event.session_id);
              turnCapTimer ??= setTimeout(
                () => {
                  void sendControl("end_turn", "turn_time_cap").catch(() => {});
                },
                options.turnTimeoutMs ?? 15 * 60_000,
              );
              if (!sessionEstablished) await postDeltas(true);
              if (options.signal.aborted) await sendControl("abort", "user_cancelled");
              break;
            case "message.start":
              if (!messageStarted) {
                messageStarted = true;
                await options.hooks.emit({ type: "message_start", message: { ...partial } });
              }
              {
                let pauseReason = options.hooks.pauseReasonAfterMessage();
                if (pauseReason) await sendControl("end_turn", pauseReason);
              }
              break;
            case "text.delta": {
              let delta = requireString(event, "delta");
              if (textIndex === undefined) {
                textIndex = partial.content.length;
                partial.content.push({ type: "text", text: "" });
              }
              let block = partial.content[textIndex];
              if (block?.type !== "text") {
                throw new HermesProtocolError("Invalid Hermes text projection state.");
              }
              block.text += delta;
              await emitUpdate({
                type: "text_delta",
                contentIndex: textIndex,
                delta,
                partial: { ...partial },
              });
              break;
            }
            case "thinking.delta": {
              let delta = requireString(event, "delta");
              if (thinkingIndex === undefined) {
                thinkingIndex = partial.content.length;
                partial.content.push({ type: "thinking", thinking: "" });
              }
              let block = partial.content[thinkingIndex];
              if (block?.type !== "thinking") {
                throw new HermesProtocolError("Invalid Hermes thinking projection state.");
              }
              block.thinking += delta;
              await emitUpdate({
                type: "thinking_delta",
                contentIndex: thinkingIndex,
                delta,
                partial: { ...partial },
              });
              break;
            }
            case "tool_call.start": {
              let callId = requireString(event, "call_id");
              let name = requireString(event, "name");
              let prior = calls.get(callId);
              if (prior && prior.name !== name) {
                throw new HermesProtocolError("Hermes reused a call id with a different tool.");
              }
              if (!calls.has(callId)) {
                let index = partial.content.length;
                partial.content.push({ type: "toolCall", id: callId, name, arguments: {} });
                calls.set(callId, { name, index, argumentsText: "" });
                await emitUpdate({
                  type: "toolcall_start",
                  contentIndex: index,
                  partial: { ...partial },
                });
              }
              break;
            }
            case "tool_call.arguments.delta": {
              let callId = requireString(event, "call_id");
              let delta = requireString(event, "delta");
              let call = calls.get(callId);
              if (!call) {
                throw new HermesProtocolError(
                  `Hermes sent arguments for unknown call ${callId}.`,
                );
              }
              call.argumentsText += delta;
              await emitUpdate({
                type: "toolcall_delta",
                contentIndex: call.index,
                delta,
                partial: { ...partial },
              });
              break;
            }
            case "tool_call.end": {
              let callId = requireString(event, "call_id");
              let call = calls.get(callId);
              if (!call) throw new HermesProtocolError(`Hermes ended unknown call ${callId}.`);
              if (
                !event.arguments ||
                typeof event.arguments !== "object" ||
                Array.isArray(event.arguments)
              ) {
                throw new HermesProtocolError(`Hermes call ${callId} has invalid arguments.`);
              }
              let block = partial.content[call.index];
              if (block?.type !== "toolCall")
                throw new HermesProtocolError("Invalid Hermes tool projection state.");
              block.arguments = event.arguments as Record<string, unknown>;
              await emitUpdate({
                type: "toolcall_end",
                contentIndex: call.index,
                toolCall: block,
                partial: { ...partial },
              });

              if (!sessionId) throw new HermesProtocolError("Hermes tool call has no session id.");
              let claim = await options.hooks.claimToolCall(
                turnId, callId, call.name, sessionId,
              );
              let stored: HermesToolResult;
              if (claim.execute) {
                let tool = toolsByName.get(call.name);
                await options.hooks.emit({
                  type: "tool_execution_start",
                  toolCallId: callId,
                  toolName: call.name,
                  args: block.arguments,
                });
                try {
                  if (!tool) throw new Error(`Tool ${call.name} not found`);
                  let prepared = tool.prepareArguments?.(block.arguments) ?? block.arguments;
                  let args = validateToolArguments(tool, { ...block, arguments: prepared });
                  let hermesTool = tool as AgentTool & {
                    executeHermes?: (
                      ...args: [...Parameters<AgentTool["execute"]>, string]
                    ) => ReturnType<AgentTool["execute"]>;
                  };
                  let operationId = `hermes:${turnId}:${callId}`;
                  let result = hermesTool.executeHermes
                    ? await hermesTool.executeHermes(
                        callId,
                        args,
                        options.signal,
                        undefined,
                        operationId,
                      )
                    : await tool.execute(callId, args, options.signal);
                  stored = {
                    result: resultText(result.content),
                    isError: false,
                    content: result.content,
                    details: result.details,
                  };
                } catch (error) {
                  let message = errorText(error);
                  stored = {
                    result: message,
                    isError: true,
                    content: [{ type: "text", text: message }],
                  };
                }
                options.hooks.resolveToolCall(turnId, callId, stored);
                await options.hooks.emit({
                  type: "tool_execution_end",
                  toolCallId: callId,
                  toolName: call.name,
                  result: { content: stored.content, details: stored.details },
                  isError: stored.isError,
                });
              } else {
                stored = claim.result;
                await options.hooks.emit({
                  type: "tool_execution_end",
                  toolCallId: callId,
                  toolName: call.name,
                  result: { content: stored.content, details: stored.details },
                  isError: stored.isError,
                });
              }

              toolResults.set(callId, {
                role: "toolResult",
                toolCallId: callId,
                toolName: call.name,
                content: stored.content,
                details: stored.details,
                isError: stored.isError,
                timestamp: Date.now(),
              });
              await retryPostJson(
                `/api/workshop/v1/turns/${encodeURIComponent(turnId)}/tool-results/` +
                  encodeURIComponent(callId),
                {
                  protocol_version: PROTOCOL_VERSION,
                  result: stored.result,
                  is_error: stored.isError,
                },
              );
              let pauseReason = options.hooks.pauseReasonAfterTool();
              if (pauseReason) await sendControl("end_turn", pauseReason);
              break;
            }
            case "usage": {
              let input = typeof event.input_tokens === "number" ? event.input_tokens : 0;
              let output = typeof event.output_tokens === "number" ? event.output_tokens : 0;
              currentUsage = { ...usage(), input, output, totalTokens: input + output };
              partial.usage = currentUsage;
              break;
            }
            case "error":
              providerError = requireString(event, "message");
              break;
            case "turn.end": {
              let reason = requireString(event, "stop_reason");
              let status = requireString(event, "status");
              if (
                textIndex === undefined &&
                typeof event.final_text === "string" &&
                event.final_text.length > 0
              ) {
                textIndex = partial.content.length;
                partial.content.push({ type: "text", text: event.final_text });
              }
              partial.content = partial.content.filter((block) => block.type !== "thinking");
              partial.usage = currentUsage;
              partial.stopReason =
                status === "completed"
                  ? "stop"
                  : status === "aborted"
                    ? "aborted"
                    : status === "error" || status === "interrupted"
                      ? "error"
                      : "error";
              if (partial.stopReason === "error" || partial.stopReason === "aborted") {
                partial.errorMessage =
                  providerError ??
                  (status === "interrupted"
                    ? `Hermes turn interrupted (${reason}); retryable transport incident.`
                    : typeof event.final_text === "string"
                      ? event.final_text.slice(0, 1024)
                      : `Hermes turn ${status} (${reason}).`);
              }
              if (!messageStarted) {
                messageStarted = true;
                await options.hooks.emit({ type: "message_start", message: { ...partial } });
              }
              await options.hooks.emit({ type: "message_end", message: partial });
              let terminalEvent = {
                type: "turn_end",
                message: partial,
                toolResults: [...toolResults.values()],
              } satisfies AgentEvent;
              if (options.hooks.emitTerminal) {
                await options.hooks.emitTerminal(event.turn_id, event.seq, terminalEvent);
              } else {
                await options.hooks.emit(terminalEvent);
              }
              options.hooks.onTerminalProjected?.(event.turn_id, event.seq);
              terminal = true;
              break;
            }
            default:
              throw new HermesProtocolError(`Unknown Hermes event type: ${event.event}`);
          }
          if (terminal) break;
        }
        retryAttempt = 0;
      } catch (error) {
        await retryDelay(error);
        continue;
      }
      if (!terminal && !progressed) {
        await sleep(Math.max(1, Math.round(100 * (0.5 + random()))));
      }
    }
  } finally {
    if (turnCapTimer !== undefined) clearTimeout(turnCapTimer);
    if (hardDeadlineTimer !== undefined) clearTimeout(hardDeadlineTimer);
    options.signal.removeEventListener("abort", abortListener);
  }
}

/** Return a plain-text representation of the one new message Hermes should receive. */
export function hermesInputText(message: Message): string {
  if (message.role === "user") {
    return typeof message.content === "string"
      ? message.content
      : message.content
          .map((part) => (part.type === "text" ? part.text : "[image attachment]"))
          .join("\n");
  }
  if (message.role === "toolResult") {
    return resultText(message.content);
  }
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}
