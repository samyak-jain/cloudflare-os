/**
 * Which recorded interface, if any, the user may still act on.
 *
 * The design's rule is "forms freeze after the turn that consumed their submission", and the
 * transcript already records exactly that: submitting a card appends a generativeUiAction event
 * even when the resumed agent turn has no prose. An interface is live only while it is the newest
 * one and no submission or later speech has followed it.
 *
 * The consequences are the ones the design asks for: reloading mid-form gives back a live card,
 * reloading after submitting gives back a frozen one, and scrolling up through a conversation
 * shows every past interface read-only with the values it was submitted with.
 */

import type { AiChatMessage } from "@gadgets/workshop-shared/api";

/**
 * The `toolCallId` of the interface the user can still use, or null if none can be.
 *
 * `messages` is the chat in sequence order, as the client holds it. Only the newest page needs to
 * be loaded: an interface on an older page is by definition not the last thing in the chat.
 */
export function findLiveGenerativeUiCall(messages: readonly AiChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const calls = message.type === "message" ? message.toolCalls : undefined;
    const newest = calls?.findLast(
      (call) => call.toolName === "renderUI" && call.output !== undefined && !call.error,
    );
    if (newest) return newest.toolCallId;

    // A submission is terminal even if resuming the agent produces no prose. Otherwise an
    // interface is live until something is said after it. The message carrying the call is skipped
    // above because the agent's own explanation of the form arrives with it; an empty assistant
    // message (a turn that only called tools) is bookkeeping, not speech.
    if (message.type === "slashCommand" || message.type === "generativeUiAction") return null;
    if (message.type === "message" && message.message.trim() !== "") return null;
  }
  return null;
}
