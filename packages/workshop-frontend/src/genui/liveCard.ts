/**
 * Which recorded interface, if any, the user may still act on.
 *
 * The design's rule is "forms freeze after the turn that consumed their submission", and the
 * transcript already records exactly that: submitting a card feeds an input event into the
 * session, which produces a turn, which appends messages after the card. So liveness needs no
 * extra state on either side -- an interface is live if it is the newest one and nothing has been
 * said since.
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

    // An interface is only live while it is the last thing in the conversation. Anything *said*
    // after it -- by the user or by the agent -- has moved past it. The message carrying the call
    // is itself skipped above, since the agent's own explanation of the form arrives with it, and
    // an empty assistant message (a turn that only called tools) is bookkeeping, not speech.
    if (message.type === "slashCommand") return null;
    if (message.type === "message" && message.message.trim() !== "") return null;
  }
  return null;
}
