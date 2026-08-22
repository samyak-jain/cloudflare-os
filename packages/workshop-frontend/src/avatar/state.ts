/**
 * The abstract avatar state: what the avatar is *doing*, with no reference to how it is drawn.
 *
 * This is the seam the design calls for -- `mapping.ts` derives these from the chat event stream,
 * and a renderer (`rig.ts` + `renderer.ts` for the SVG rig, a Rive runtime later) consumes them.
 * Neither side knows about the other, so the renderer can be swapped without touching the
 * integration, and the mapping can be unit-tested without a DOM.
 *
 * The avatar is a pure *view* of the stream. Nothing here is agent-controlled: there is no channel
 * by which a model can select its own expression, by design.
 */

/** What kind of tool the agent is running, for the per-kind working poses. */
export type AvatarWorkKind = "read" | "write" | "browse" | "execute";

export type AvatarState =
  /** Nothing is happening. Ambient motion only. */
  | { kind: "idle" }
  /** The user has spoken (or is composing) and the agent has not answered yet. */
  | { kind: "listening" }
  /** Reasoning tokens are streaming, or context is being compacted. */
  | { kind: "thinking" }
  /** Assistant text is streaming. */
  | { kind: "talking" }
  /** A tool call is streaming or executing. */
  | { kind: "working"; work: AvatarWorkKind }
  /** The turn ended with an error. Transient. */
  | { kind: "error" }
  /** The turn ended successfully. Transient, then settles to idle. */
  | { kind: "done" }
  /** The stream is frozen -- the connection dropped, so we cannot claim to know anything. */
  | { kind: "paused" };

export type AvatarStateKind = AvatarState["kind"];

/**
 * A state plus the timestamp it was entered at, on the same clock the machine was driven with.
 *
 * Renderers key one-shot animations (the `error` head-shake, the `done` star pop) off `since`
 * rather than off state identity, so a second error in a row replays the shake instead of being
 * swallowed as "no change".
 */
export type AvatarStateSnapshot = {
  state: AvatarState;
  since: number;
};

export const IDLE_SNAPSHOT: AvatarStateSnapshot = { state: { kind: "idle" }, since: 0 };

export function sameAvatarState(a: AvatarState, b: AvatarState): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "working" && b.kind === "working") return a.work === b.work;
  return true;
}

/** Human-readable label, used for the component's accessible name and for QA screenshots. */
export function describeAvatarState(state: AvatarState): string {
  switch (state.kind) {
    case "idle": return "Idle";
    case "listening": return "Listening";
    case "thinking": return "Thinking";
    case "talking": return "Talking";
    case "working": return `Working (${state.work})`;
    case "error": return "Error";
    case "done": return "Done";
    case "paused": return "Paused";
  }
}

/**
 * The caption shown beside the avatar in the chat header.
 *
 * Says what is happening rather than naming the state: the avatar is the glanceable signal and
 * this is the sentence for when a glance is not enough. It is also the only place the four
 * `working` kinds are named outright, which is what makes their poses legible the first time
 * someone sees them.
 */
export function avatarStatusLabel(state: AvatarState): string {
  switch (state.kind) {
    case "idle": return "Ready";
    case "listening": return "Listening";
    case "thinking": return "Thinking…";
    case "talking": return "Answering…";
    case "error": return "Something went wrong";
    case "done": return "Done";
    case "paused": return "Reconnecting…";
    case "working":
      switch (state.work) {
        case "read": return "Reading…";
        case "write": return "Editing files…";
        case "browse": return "Browsing…";
        case "execute": return "Running code…";
      }
  }
}
