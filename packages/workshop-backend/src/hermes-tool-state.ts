import type { HermesToolResult } from "./hermes-driver";

/** Durable state for one Hermes `(turn_id, call_id)` local execution. */
export type HermesToolCallRecord = {
  chatId: number;
  sessionId: string;
  turnId: string;
  callId: string;
  toolName: string;
} & (
  | { state: "executing" }
  | {
      state: "resolved" | "interrupted";
      result: HermesToolResult;
    }
);

/** Minimal durable collection used by HermesToolCallStateMachine. */
export interface HermesToolCallRecords {
  get(key: string): HermesToolCallRecord | undefined;
  put(record: HermesToolCallRecord): void;
}

/** Collision-free storage key for a remote turn/call pair. */
export function hermesToolCallKey(turnId: string, callId: string): string {
  return `${turnId.length}:${turnId}${callId}`;
}

/**
 * Coordinates durable claims with same-instance waiters. A fresh object instance treats an
 * unresolved executeCode claim as interrupted; replay-safe tools receive the same stable operation
 * id and rely on their tagged mutation primitive to recognize an already-applied operation.
 */
export class HermesToolCallStateMachine {
  #active = new Map<
    string,
    {
      promise: Promise<HermesToolResult>;
      resolve(result: HermesToolResult): void;
    }
  >();

  constructor(private records: HermesToolCallRecords) {}

  /** Claim before execution, await a racing same-instance call, or return a durable result. */
  async claim(
    chatId: number,
    sessionId: string,
    turnId: string,
    callId: string,
    toolName: string,
  ): Promise<{ execute: true } | { execute: false; result: HermesToolResult }> {
    let key = hermesToolCallKey(turnId, callId);
    let previous = this.records.get(key);
    if (previous && previous.toolName !== toolName) {
      throw new Error("Hermes reused a call id with a different tool name.");
    }
    if (previous?.state === "resolved" || previous?.state === "interrupted") {
      return { execute: false, result: previous.result };
    }
    let active = this.#active.get(key);
    if (active) return { execute: false, result: await active.promise };

    if (previous?.state === "executing" && toolName === "executeCode") {
      let message = "execution state unknown after crash";
      let result: HermesToolResult = {
        result: message,
        isError: true,
        content: [{ type: "text", text: message }],
      };
      this.records.put({ ...previous, state: "interrupted", result });
      return { execute: false, result };
    }

    let resolvers = Promise.withResolvers<HermesToolResult>();
    this.#active.set(key, resolvers);
    this.records.put({ chatId, sessionId, turnId, callId, toolName, state: "executing" });
    return { execute: true };
  }

  /** Atomically replace an executing claim with its reusable result and release race waiters. */
  resolve(turnId: string, callId: string, result: HermesToolResult): void {
    let key = hermesToolCallKey(turnId, callId);
    let previous = this.records.get(key);
    if (!previous) throw new Error("Hermes tool call was resolved without a durable claim.");
    if (previous.state === "resolved" || previous.state === "interrupted") return;
    this.records.put({ ...previous, state: "resolved", result });
    let active = this.#active.get(key);
    this.#active.delete(key);
    active?.resolve(result);
  }

  /** Resolve a timed-out claim as interrupted and release any racing delivery. */
  interrupt(turnId: string, callId: string, result: HermesToolResult): void {
    let key = hermesToolCallKey(turnId, callId);
    let previous = this.records.get(key);
    if (!previous) throw new Error("Hermes tool call was interrupted without a durable claim.");
    if (previous.state === "resolved" || previous.state === "interrupted") return;
    this.records.put({ ...previous, state: "interrupted", result });
    let active = this.#active.get(key);
    this.#active.delete(key);
    active?.resolve(result);
  }
}
