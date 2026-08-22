/**
 * The card's view of the backend: two calls, both fire-and-forget from the user's point of view.
 *
 * Narrowed to an interface of its own rather than taking an `Overseer` stub so the renderer can be
 * driven without a backend at all -- the QA harness and the unit tests supply their own
 * implementation. `createOverseerGenerativeUiClient` is the one that talks to the real DO.
 */

import type { Overseer } from "@gadgets/workshop-shared/api";
import type { RpcStub } from "capnweb";
import type { BoundState } from "./bind";

/** What a generative-UI card needs from the outside world. */
export interface GenerativeUiClient {
  /**
   * Mirror the card's bound state. Called debounced while the user types; never awaited on the
   * render path, and a rejection is not shown to the user -- the local copy is authoritative for
   * the session, and the next keystroke retries with the full state anyway.
   */
  setState(toolCallId: string, state: BoundState): Promise<void>;

  /**
   * Submit the card. Awaited: the button shows progress and a failure has to be reported, because
   * the user pressed something and expects the agent to have heard it.
   */
  submitAction(toolCallId: string, action: string, state: BoundState): Promise<void>;
}

/**
 * A client bound to one chat on a live overseer stub.
 *
 * `getOverseer` is the same accessor the rest of the chat UI uses, so the card rides the existing
 * WebSocket session and reconnects with it rather than holding a stub across renders.
 */
export function createOverseerGenerativeUiClient(
  getOverseer: () => RpcStub<Overseer>,
  chatId: number,
): GenerativeUiClient {
  return {
    async setState(toolCallId, state) {
      await getOverseer().setGenerativeUiState(chatId, toolCallId, state);
    },
    async submitAction(toolCallId, action, state) {
      await getOverseer().submitGenerativeUiAction(chatId, toolCallId, action, state);
    },
  };
}

/** One call a `createRecordingGenerativeUiClient` saw. */
export type RecordedGenerativeUiCall =
  | { kind: "setState"; toolCallId: string; state: BoundState }
  | { kind: "submitAction"; toolCallId: string; action: string; state: BoundState };

/**
 * An in-memory client for tests and the QA harness: records what it was told and resolves.
 *
 * `delay` returns the promise every call awaits, so a test can hold a submission open and assert
 * on the card's in-flight chrome.
 */
export function createRecordingGenerativeUiClient(
  delay: () => Promise<void> = () => Promise.resolve(),
): GenerativeUiClient & { calls: RecordedGenerativeUiCall[] } {
  const calls: RecordedGenerativeUiCall[] = [];
  return {
    calls,
    async setState(toolCallId, state) {
      calls.push({ kind: "setState", toolCallId, state });
      await delay();
    },
    async submitAction(toolCallId, action, state) {
      calls.push({ kind: "submitAction", toolCallId, action, state });
      await delay();
    },
  };
}
