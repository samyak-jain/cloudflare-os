/**
 * Chat event stream -> `AvatarState`.
 *
 * The machine is fed the events the chat UI already receives (`AiChatStreamEvent` via
 * `AiChatSubscriber.stream()`, durable rows via `message()`, turn boundaries via the metadata's
 * `activeAgent`) and derives what the avatar should be doing. It holds no DOM, no timers and no
 * clock of its own: every entry point takes `now`, so tests drive it with plain numbers and the
 * React binding drives it with `performance.now()`.
 *
 * ## Why the state is not simply "the last event type"
 *
 * Two properties the raw stream does not have on its own:
 *
 * 1. **Stickiness across silence.** After `toolCallFinished` the tool has only finished *streaming
 *    its input* -- it then executes, emitting nothing for most tools (see `AiChatStreamEvent`).
 *    A decay-based reading would fall to `idle` in the middle of the longest part of a tool call.
 *    So while the turn is live the last signal holds until another signal displaces it; the turn
 *    boundary, not a timeout, is what ends it.
 *
 * 2. **Resistance to interleaving.** Models interleave short reasoning bursts into narration, and a
 *    literal reading flickers talking/thinking several times a second. So a state that has just
 *    been entered cannot be displaced by a *lower-priority* one until its dwell has elapsed
 *    (`DWELL_MS`). Higher-priority signals -- a tool starting mid-sentence -- always win at once,
 *    because that transition is real and the user is waiting to see it.
 */

import type { AiChatMessage, AiChatStreamEvent, AiToolCall } from "@gadgets/workshop-shared/api";
import type { AvatarState, AvatarStateSnapshot, AvatarWorkKind } from "./state";

/**
 * Tool name -> the pose family the avatar strikes.
 *
 * `AiToolCall["toolName"]` is a closed union (`api.ts`), so this table is exhaustive today; the
 * `Partial` typing plus the `execute` default is deliberate, so a tool added upstream degrades to a
 * generic busy pose rather than breaking the build or falling out of `working` entirely.
 */
const TOOL_WORK_KIND: Partial<Record<AiToolCall["toolName"], AvatarWorkKind>> = {
  readFile: "read",
  describeBinding: "read",
  listBlueprints: "read",
  listConnectableResources: "read",
  observeUserChanges: "read",

  writeFile: "write",
  editFile: "write",
  createGadget: "write",
  setBindingHook: "write",
  setGadgetBinding: "write",
  saveCapsuleAsBinding: "write",

  webFetch: "browse",
  requestConnection: "browse",

  executeCode: "execute",
  giveUp: "execute",
};

export function workKindForTool(toolName: string): AvatarWorkKind {
  return TOOL_WORK_KIND[toolName as AiToolCall["toolName"]] ?? "execute";
}

/** Which live signal outranks which, when both are current. */
const PRIORITY: Record<SignalKind, number> = { working: 3, talking: 2, thinking: 1 };

/**
 * How long a signal is protected from being displaced by a lower-priority one.
 *
 * `talking` gets the longest guard because reasoning bursts interleaved into narration are the
 * flicker source we most want to suppress; `thinking` gets the shortest because the first text
 * delta after a reasoning block should reach the mouth promptly.
 */
const DWELL_MS: Record<SignalKind, number> = { talking: 700, working: 500, thinking: 300 };

export type AvatarTimings = {
  /** How long `done` is held after a clean turn end before settling to idle. */
  doneMs: number;
  /** How long `error` is held after a failed turn. */
  errorMs: number;
  /** How long fresh composer activity keeps the avatar in `listening` while the agent is idle. */
  composingMs: number;
  /**
   * How long `listening` survives a sent message that nobody picks up.
   *
   * Only applies while the agent is *not* active: once a turn is running, listening holds for as
   * long as the first token takes, however long that is. This bound is for the degenerate case --
   * a chat with no model configured, where `activeAgent` never sets and no stream event ever
   * arrives. Without it the avatar would sit attentive forever waiting for an answer that is not
   * coming.
   */
  listeningMs: number;
};

export const DEFAULT_TIMINGS: AvatarTimings = {
  doneMs: 2000,
  errorMs: 3200,
  composingMs: 2500,
  listeningMs: 45_000,
};

type SignalKind = "talking" | "thinking" | "working";

type Signal = {
  kind: SignalKind;
  at: number;
  /** Entry time of the current run of this signal, which is what `dwell` is measured from. */
  enteredAt: number;
  work: AvatarWorkKind;
};

/** The subset of `AiChatMessage` the machine reads. Keeps tests free of message-shape boilerplate. */
export type AvatarMessageInput = Pick<AiChatMessage, "type"> & {
  author?: { type: "user" | "agent" | "gadget" };
};

export class AvatarStateMachine {
  readonly #timings: AvatarTimings;

  /** The live signal, or null when the turn has ended and nothing is streaming. */
  #signal: Signal | null = null;
  /** toolCallId -> work kind, so mid-call events (`toolCodeDelta`, previews) keep the right pose. */
  #toolKinds = new Map<string, AvatarWorkKind>();
  #agentActive = false;
  #connectionLost = false;
  /** Set by a user message or composer activity; cleared once the turn it prompted is over. */
  #listeningSince: number | null = null;
  #composingAt: number | null = null;
  /** Whether this turn produced anything -- a turn that produced nothing does not earn a `done`. */
  #turnProduced = false;
  #errorAt: number | null = null;
  #doneAt: number | null = null;

  constructor(timings: Partial<AvatarTimings> = {}) {
    this.#timings = { ...DEFAULT_TIMINGS, ...timings };
  }

  // ── inputs ────────────────────────────────────────────────────────────────────────────────────

  /**
   * One provisional stream event, exactly as `AiChatSubscriber.stream()` delivers it.
   *
   * A stream event is itself proof the agent is running, so it implies `agentActive`. The metadata
   * flag can lag the first delta (they travel as separate messages), and trusting it alone would
   * drop the opening of a turn on the floor.
   */
  handleStream(event: AiChatStreamEvent, now: number): void {
    switch (event.type) {
      case "textDelta":
        this.#note("talking", "execute", now);
        break;

      case "reasoningDelta":
        this.#note("thinking", "execute", now);
        break;

      case "compacting":
        // Summarizing older context to make room. It is not the model's own reasoning, but it is
        // the same experience from the user's side: a wait with nothing to read.
        this.#note("thinking", "execute", now);
        break;

      case "compacted":
        // Says nothing about what comes next -- compaction is always followed by the turn it made
        // room for, whose first delta re-poses the avatar, or by the turn boundary.
        break;

      case "toolCallStarted": {
        const work = workKindForTool(event.toolName);
        this.#toolKinds.set(event.toolCallId, work);
        this.#note("working", work, now);
        break;
      }

      case "toolCodeDelta":
      case "toolOutputDelta":
      case "toolCallFinished":
      case "toolCallTarget":
      case "toolCallOutputFormat":
        // Keep the pose alive through the body of a call. The kind comes from the `toolCallStarted`
        // we recorded; a call whose start we missed (subscribed mid-turn) falls back to the generic
        // busy pose rather than dropping out of `working`.
        this.#note("working", this.#toolKinds.get(event.toolCallId) ?? "execute", now);
        break;

      case "editPreviewStart":
      case "editPreviewDelta":
        // Only writeFile/editFile stream previews, so this is a write regardless of what we recorded.
        this.#toolKinds.set(event.toolCallId, "write");
        this.#note("working", "write", now);
        break;

      case "setActiveFile":
        if (event.file !== null) this.#note("working", "write", now);
        break;

      case "editPreviewClear":
        // A withdrawn preview says nothing about what the agent is doing next.
        break;
    }
  }

  /** One durable message row, as `AiChatSubscriber.message()` delivers it. */
  handleMessage(msg: AvatarMessageInput, now: number): void {
    if (msg.type === "error") {
      // The run ended with an error (LLM failure, abort, restart). Flash immediately rather than
      // waiting for the metadata to retract `activeAgent`.
      this.#errorAt = now;
      this.#doneAt = null;
      this.#signal = null;
      this.#listeningSince = null;
      return;
    }

    if (msg.author?.type === "user") {
      this.#beginListening(now);
      return;
    }

    // Any agent-authored row means this turn produced something, which is what a `done` flash
    // celebrates. Tool/change rows count: a turn that only edited files still finished.
    this.#turnProduced = true;
  }

  /** Turn boundary, from `AiChatMetadata.activeAgent` on the selected chat. */
  setAgentActive(active: boolean, now: number): void {
    if (active === this.#agentActive) return;
    this.#agentActive = active;

    if (active) {
      this.#markTurnStart();
      return;
    }

    // Turn over. Anything still streaming is stale; the outcome latch takes over.
    this.#signal = null;
    this.#toolKinds.clear();
    this.#listeningSince = null;

    const errorLive = this.#errorAt !== null && now - this.#errorAt < this.#timings.errorMs;
    if (!errorLive && this.#turnProduced) this.#doneAt = now;
    this.#turnProduced = false;
  }

  /** Connection state, from `useConnectionLost()`. A dropped socket freezes the stream. */
  setConnectionLost(lost: boolean): void {
    if (lost === this.#connectionLost) return;
    this.#connectionLost = lost;
    if (lost) {
      // Whatever we last saw is now unverifiable; don't keep miming it behind a dead socket.
      this.#signal = null;
    } else {
      // Reconnection is not an outcome; don't let a stale flash fire on the way back.
      this.#doneAt = null;
    }
  }

  /** The user is typing in the composer. Optional; drives `listening` before a message is sent. */
  noteUserComposing(now: number): void {
    this.#composingAt = now;
  }

  /** The user submitted a message. Called directly by the composer for a zero-latency reaction. */
  noteUserMessageSent(now: number): void {
    this.#beginListening(now);
  }

  /** Discard everything -- used when the viewed chat changes. */
  reset(): void {
    this.#signal = null;
    this.#toolKinds.clear();
    this.#agentActive = false;
    this.#listeningSince = null;
    this.#composingAt = null;
    this.#turnProduced = false;
    this.#errorAt = null;
    this.#doneAt = null;
  }

  // ── output ────────────────────────────────────────────────────────────────────────────────────

  snapshot(now: number): AvatarStateSnapshot {
    // 1. An outcome the user has not had time to read yet outranks everything.
    if (this.#errorAt !== null) {
      if (now - this.#errorAt < this.#timings.errorMs) {
        return { state: { kind: "error" }, since: this.#errorAt };
      }
      this.#errorAt = null;
    }

    // 2. A dead socket outranks any claim about what the agent is doing.
    if (this.#connectionLost) return { state: { kind: "paused" }, since: 0 };

    if (this.#doneAt !== null) {
      if (now - this.#doneAt < this.#timings.doneMs) {
        return { state: { kind: "done" }, since: this.#doneAt };
      }
      this.#doneAt = null;
    }

    // 3. Live stream activity.
    const signal = this.#signal;
    if (signal !== null) {
      const state: AvatarState = signal.kind === "working"
        ? { kind: "working", work: signal.work }
        : { kind: signal.kind };
      return { state, since: signal.enteredAt };
    }

    // 4. The user has spoken and the agent has not answered yet.
    if (this.#listeningSince !== null) {
      if (this.#agentActive || now - this.#listeningSince < this.#timings.listeningMs) {
        return { state: { kind: "listening" }, since: this.#listeningSince };
      }
      this.#listeningSince = null;
    }
    if (this.#composingAt !== null) {
      if (now - this.#composingAt < this.#timings.composingMs) {
        return { state: { kind: "listening" }, since: this.#composingAt };
      }
      this.#composingAt = null;
    }

    return { state: { kind: "idle" }, since: 0 };
  }

  state(now: number): AvatarState {
    return this.snapshot(now).state;
  }

  /**
   * Milliseconds until `snapshot()` could return something different with no further input, or
   * null if only an event can change it. Lets the React binding arm one timer instead of polling.
   */
  nextChangeIn(now: number): number | null {
    const deadlines: number[] = [];
    if (this.#errorAt !== null) deadlines.push(this.#errorAt + this.#timings.errorMs - now);
    else if (!this.#connectionLost && this.#doneAt !== null) {
      deadlines.push(this.#doneAt + this.#timings.doneMs - now);
    }
    if (this.#signal === null && this.#listeningSince !== null && !this.#agentActive) {
      deadlines.push(this.#listeningSince + this.#timings.listeningMs - now);
    }
    if (this.#signal === null && this.#listeningSince === null && this.#composingAt !== null) {
      deadlines.push(this.#composingAt + this.#timings.composingMs - now);
    }
    if (deadlines.length === 0) return null;
    return Math.max(0, Math.min(...deadlines));
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────────

  #beginListening(now: number): void {
    this.#listeningSince = now;
    this.#composingAt = null;
    // A fresh prompt supersedes the previous turn's outcome; holding a stale flash over a new
    // question reads as the avatar ignoring the user.
    this.#doneAt = null;
    this.#errorAt = null;
  }

  #markTurnStart(): void {
    this.#turnProduced = false;
    this.#doneAt = null;
    this.#errorAt = null;
    this.#toolKinds.clear();
  }

  #note(kind: SignalKind, work: AvatarWorkKind, now: number): void {
    if (!this.#agentActive) {
      // Streaming is itself the turn boundary we trust; see handleStream().
      this.#agentActive = true;
      this.#markTurnStart();
    }
    this.#turnProduced = true;
    // The agent has answered, so we are no longer waiting on it.
    this.#listeningSince = null;
    this.#composingAt = null;

    const current = this.#signal;
    if (current === null) {
      this.#signal = { kind, at: now, enteredAt: now, work };
      return;
    }

    if (current.kind === kind) {
      current.at = now;
      // A different tool kind is a real change of pose even though the signal rank is unchanged;
      // restamp so the renderer replays its entry motion.
      if (kind === "working" && current.work !== work) {
        current.work = work;
        current.enteredAt = now;
      }
      return;
    }

    // Higher priority preempts at once; lower priority must outwait the incumbent's dwell.
    if (PRIORITY[kind] < PRIORITY[current.kind] && now - current.enteredAt < DWELL_MS[current.kind]) {
      return;
    }

    this.#signal = { kind, at: now, enteredAt: now, work };
  }
}
