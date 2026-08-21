import type {
  AssistantMessage, AssistantMessageEvent, Message, ToolResultMessage, Usage,
} from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";

const PROTOCOL_VERSION = 1;

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
};

/** Transport and persistence callbacks supplied by the Workshop agent/Overseer boundary. */
export interface HermesDriverHooks {
  emit(event: AgentEvent): Promise<void> | void;
  getToolResult(turnId: string, callId: string): HermesToolResult | undefined;
  putToolResult(turnId: string, callId: string, result: HermesToolResult): void;
  onTurnStarted(turnId: string, sessionId: string): void;
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
  workspaceDeltas?: HermesWorkspaceDelta[];
  fetch?: typeof globalThis.fetch;
}

/** One bounded, idempotent workspace-state notice derived during Workshop replay. */
export type HermesWorkspaceDelta = {deltaId: string; payload: Record<string, unknown>};

type HermesEvent = {
  protocol_version: number;
  turn_id: string;
  session_id: string;
  seq: number;
  event: string;
  timestamp: number;
  [key: string]: unknown;
};

class HermesHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function usage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0},
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : `${error}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    let object = value as Record<string, unknown>;
    return `{${Object.keys(object).toSorted().map(key =>
      `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
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
  if (typeof value !== "string") throw new Error(`Hermes event field ${field} must be a string.`);
  return value;
}

function parseEvent(value: unknown): HermesEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Hermes SSE data must be a JSON object.");
  }
  let event = value as HermesEvent;
  if (event.protocol_version !== PROTOCOL_VERSION ||
      typeof event.turn_id !== "string" || typeof event.session_id !== "string" ||
      !Number.isSafeInteger(event.seq) || event.seq < 1 ||
      typeof event.event !== "string" || typeof event.timestamp !== "number") {
    throw new Error("Hermes SSE event has an invalid protocol envelope.");
  }
  return event;
}

async function* sseEvents(response: Response): AsyncGenerator<HermesEvent> {
  if (!response.body) throw new Error("Hermes returned an SSE response with no body.");
  let decoder = new TextDecoder();
  let buffer = "";
  for await (let chunk of response.body) {
    buffer += decoder.decode(chunk, {stream: true}).replaceAll("\r\n", "\n");
    while (true) {
      let boundary = buffer.indexOf("\n\n");
      if (boundary < 0) break;
      let frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let data = frame.split("\n")
          .filter(line => line.startsWith("data:"))
          .map(line => line.slice(5).trimStart()).join("\n");
      if (data) yield parseEvent(JSON.parse(data));
    }
  }
  buffer += decoder.decode();
  let data = buffer.split("\n")
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trimStart()).join("\n");
  if (data) yield parseEvent(JSON.parse(data));
}

async function checkedFetch(fetcher: typeof globalThis.fetch, url: string, apiKey: string,
                              init?: RequestInit): Promise<Response> {
  let headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${apiKey}`);
  if (init?.body) headers.set("Content-Type", "application/json");
  let response = await fetcher(url, {...init, headers});
  if (!response.ok) {
    let body = await response.text();
    throw new HermesHttpError(
        `Hermes request failed (${response.status}): ${body.slice(0, 1024)}`, response.status);
  }
  return response;
}

function toolCatalog(tools: AgentTool[]) {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

function resultText(content: ToolResultMessage["content"]): string {
  return content.map(part => part.type === "text"
    ? part.text
    : `[image result: ${part.mimeType}]`).join("\n");
}

/**
 * Drive one Hermes-owned agent turn while projecting its stream through the existing pi AgentEvent
 * sink. Network detachment reattaches by sequence; only an explicit abort sends cancellation.
 */
export async function runHermesTurn(options: HermesDriverOptions): Promise<void> {
  let fetcher = options.fetch ?? globalThis.fetch;
  let toolsByName = new Map(options.tools.map(tool => [tool.name, tool]));
  let lastSeq = 0;
  let turnId = options.attachedTurn?.turnId;
  let eventsUrl = options.attachedTurn?.eventsUrl;
  let terminal = false;
  let messageStarted = false;
  let controlSent: "abort" | "end_turn" | undefined;
  let controlPromise: Promise<void> | undefined;
  let textIndex: number | undefined;
  let thinkingIndex: number | undefined;
  let calls = new Map<string, {name: string, index: number, argumentsText: string}>();
  let toolResults = new Map<string, ToolResultMessage>();
  let providerError: string | undefined;
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
      message: {...partial},
      assistantMessageEvent,
    });
  };

  let postJson = async (path: string, body: unknown) => {
    await checkedFetch(fetcher, `${options.baseUrl}${path}`, options.apiKey, {
      method: "POST",
      body: canonicalJson(body),
    });
  };

  let sendControl = async (signal: "abort" | "end_turn", reason: string) => {
    if (!turnId || controlSent === "abort") return controlPromise;
    if (controlSent === signal) return controlPromise;
    controlSent = signal;
    controlPromise = postJson(`/api/workshop/v1/turns/${encodeURIComponent(turnId)}/control`, {
      protocol_version: PROTOCOL_VERSION,
      signal,
      mode: signal === "abort" ? "immediate" : "after_current_call",
      reason,
    });
    await controlPromise;
  };

  let abortListener = () => {
    void sendControl("abort", "user_cancelled").catch(() => {});
  };
  options.signal.addEventListener("abort", abortListener, {once: true});

  let startResponse: Response | undefined;
  if (!options.attachedTurn) {
    startResponse = await checkedFetch(
        fetcher, `${options.baseUrl}/api/workshop/v1/turns`, options.apiKey, {
          method: "POST",
          body: canonicalJson({
            protocol_version: PROTOCOL_VERSION,
            client_turn_id: options.clientTurnId,
            workspace_id: options.workspaceId,
            chat_id: options.chatId,
            input: {type: "user", text: options.inputText},
            tools: toolCatalog(options.tools),
            metadata: {},
          }),
        });
  }

  try {
    while (!terminal) {
      let progressed = false;
      let response = startResponse;
      startResponse = undefined;
      if (!response) {
        if (!turnId) throw new Error("Hermes disconnected before announcing a turn id.");
        let url = eventsUrl
          ? new URL(eventsUrl, options.baseUrl)
          : new URL(`${options.baseUrl}/api/workshop/v1/turns/${encodeURIComponent(turnId)}/events`);
        url.searchParams.set("after_seq", `${lastSeq}`);
        response = await checkedFetch(fetcher, url.toString(), options.apiKey);
      }

      for await (let event of sseEvents(response)) {
        if (event.seq <= lastSeq) continue;
        progressed = true;
        lastSeq = event.seq;
        if (turnId && event.turn_id !== turnId) {
          throw new Error("Hermes changed turn_id within an event stream.");
        }
        turnId = event.turn_id;

        switch (event.event) {
          case "turn.started":
            options.hooks.onTurnStarted(event.turn_id, event.session_id);
            if (!deltasPosted) {
              deltasPosted = true;
              for (let delta of options.workspaceDeltas ?? []) {
                try {
                  await postJson(
                      `/api/workshop/v1/sessions/${encodeURIComponent(options.workspaceId)}/` +
                      `${encodeURIComponent(options.chatId)}/deltas`, {
                        protocol_version: PROTOCOL_VERSION,
                        delta_id: delta.deltaId,
                        workspace_id: options.workspaceId,
                        chat_id: options.chatId,
                        payload: boundedDeltaPayload(delta.payload),
                      });
                } catch (error) {
                  // Hermes has not established this deterministic session yet. Replay will derive
                  // the same stable delta id on the next user turn, so dropping here is the retry
                  // queue and cannot duplicate an internal turn.
                  if (!(error instanceof HermesHttpError) || error.status !== 409) throw error;
                }
              }
            }
            if (options.signal.aborted) await sendControl("abort", "user_cancelled");
            break;
          case "message.start":
            if (!messageStarted) {
              messageStarted = true;
              await options.hooks.emit({type: "message_start", message: {...partial}});
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
              partial.content.push({type: "text", text: ""});
            }
            let block = partial.content[textIndex];
            if (block?.type !== "text") throw new Error("Invalid Hermes text projection state.");
            block.text += delta;
            await emitUpdate({type: "text_delta", contentIndex: textIndex, delta,
                              partial: {...partial}});
            break;
          }
          case "thinking.delta": {
            let delta = requireString(event, "delta");
            if (thinkingIndex === undefined) {
              thinkingIndex = partial.content.length;
              partial.content.push({type: "thinking", thinking: ""});
            }
            let block = partial.content[thinkingIndex];
            if (block?.type !== "thinking") {
              throw new Error("Invalid Hermes thinking projection state.");
            }
            block.thinking += delta;
            await emitUpdate({type: "thinking_delta", contentIndex: thinkingIndex, delta,
                              partial: {...partial}});
            break;
          }
          case "tool_call.start": {
            let callId = requireString(event, "call_id");
            let name = requireString(event, "name");
            if (!calls.has(callId)) {
              let index = partial.content.length;
              partial.content.push({type: "toolCall", id: callId, name, arguments: {}});
              calls.set(callId, {name, index, argumentsText: ""});
              await emitUpdate({type: "toolcall_start", contentIndex: index,
                                partial: {...partial}});
            }
            break;
          }
          case "tool_call.arguments.delta": {
            let callId = requireString(event, "call_id");
            let delta = requireString(event, "delta");
            let call = calls.get(callId);
            if (!call) throw new Error(`Hermes sent arguments for unknown call ${callId}.`);
            call.argumentsText += delta;
            await emitUpdate({type: "toolcall_delta", contentIndex: call.index, delta,
                              partial: {...partial}});
            break;
          }
          case "tool_call.end": {
            let callId = requireString(event, "call_id");
            let call = calls.get(callId);
            if (!call) throw new Error(`Hermes ended unknown call ${callId}.`);
            if (!event.arguments || typeof event.arguments !== "object" ||
                Array.isArray(event.arguments)) {
              throw new Error(`Hermes call ${callId} has invalid arguments.`);
            }
            let block = partial.content[call.index];
            if (block?.type !== "toolCall") throw new Error("Invalid Hermes tool projection state.");
            block.arguments = event.arguments as Record<string, unknown>;
            await emitUpdate({type: "toolcall_end", contentIndex: call.index, toolCall: block,
                              partial: {...partial}});

            let stored = options.hooks.getToolResult(turnId, callId);
            if (!stored) {
              let tool = toolsByName.get(call.name);
              await options.hooks.emit({type: "tool_execution_start", toolCallId: callId,
                                        toolName: call.name, args: block.arguments});
              try {
                if (!tool) throw new Error(`Tool ${call.name} not found`);
                let prepared = tool.prepareArguments?.(block.arguments) ?? block.arguments;
                let args = validateToolArguments(tool, {...block, arguments: prepared});
                let result = await tool.execute(callId, args, options.signal);
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
                  content: [{type: "text", text: message}],
                };
              }
              options.hooks.putToolResult(turnId, callId, stored);
              await options.hooks.emit({
                type: "tool_execution_end",
                toolCallId: callId,
                toolName: call.name,
                result: {content: stored.content, details: stored.details},
                isError: stored.isError,
              });
            } else {
              await options.hooks.emit({
                type: "tool_execution_end",
                toolCallId: callId,
                toolName: call.name,
                result: {content: stored.content, details: stored.details},
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
            await postJson(
                `/api/workshop/v1/turns/${encodeURIComponent(turnId)}/tool-results/` +
                encodeURIComponent(callId), {
                  protocol_version: PROTOCOL_VERSION,
                  result: stored.result,
                  is_error: stored.isError,
                });
            let pauseReason = options.hooks.pauseReasonAfterTool();
            if (pauseReason) await sendControl("end_turn", pauseReason);
            break;
          }
          case "usage": {
            let input = typeof event.input_tokens === "number" ? event.input_tokens : 0;
            let output = typeof event.output_tokens === "number" ? event.output_tokens : 0;
            currentUsage = {...usage(), input, output, totalTokens: input + output};
            partial.usage = currentUsage;
            break;
          }
          case "error":
            providerError = requireString(event, "message");
            break;
          case "turn.end": {
            let stopReason = requireString(event, "stop_reason");
            if (textIndex === undefined && typeof event.final_text === "string" &&
                event.final_text.length > 0) {
              textIndex = partial.content.length;
              partial.content.push({type: "text", text: event.final_text});
            }
            partial.content = partial.content.filter(block => block.type !== "thinking");
            partial.usage = currentUsage;
            partial.stopReason = stopReason === "error" ? "error"
              : stopReason === "aborted" ? "aborted"
              : stopReason === "length" ? "length" : "stop";
            if (partial.stopReason === "error" || partial.stopReason === "aborted") {
              partial.errorMessage = providerError ??
                  (typeof event.final_text === "string" ? event.final_text : "Hermes turn failed.");
            }
            if (!messageStarted) {
              messageStarted = true;
              await options.hooks.emit({type: "message_start", message: {...partial}});
            }
            await options.hooks.emit({type: "message_end", message: partial});
            await options.hooks.emit({type: "turn_end", message: partial,
                                      toolResults: [...toolResults.values()]});
            terminal = true;
            break;
          }
          default:
            throw new Error(`Unknown Hermes event type: ${event.event}`);
        }
        if (terminal) break;
      }
      if (!terminal && !progressed) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  } finally {
    options.signal.removeEventListener("abort", abortListener);
  }
}

/** Return a plain-text representation of the one new message Hermes should receive. */
export function hermesInputText(message: Message): string {
  if (message.role === "user") {
    return typeof message.content === "string"
      ? message.content
      : message.content.map(part => part.type === "text" ? part.text : "[image attachment]")
          .join("\n");
  }
  if (message.role === "toolResult") {
    return resultText(message.content);
  }
  return message.content.filter(part => part.type === "text").map(part => part.text).join("");
}
