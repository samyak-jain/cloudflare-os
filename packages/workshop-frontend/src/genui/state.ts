/**
 * The card's state machine: local-first edits, debounced mirroring, one-shot submission.
 *
 * "Local-first" is not an optimization here, it is the interaction model. A generated form is a
 * controlled React form whose values live in this hook; the backend is told what they are on a
 * trailing edge, and is never in the path between a keystroke and the character appearing. A
 * dropped or slow mirror write is therefore invisible, which is the right trade for state that is
 * only meaningful once the user presses a button.
 *
 * Submission is the opposite: awaited, reported, and terminal. A card that has been submitted is
 * frozen for good -- the agent has consumed it, and letting the user keep editing a form whose
 * values were already read would be a lie.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GenerativeUiClient } from "./client";
import { setAtPath, type BoundState } from "./bind";

/** How long the card waits for the typing to stop before mirroring state to the backend. */
export const STATE_MIRROR_DEBOUNCE_MS = 400;

/** Where a card is in its one-way trip from editable to consumed. */
export type GenerativeUiCardStatus =
  | { kind: "editable" }
  /** A submission is in flight. Controls are already inert: the values have left. */
  | { kind: "submitting"; action: string }
  /** The agent has the submission. The card is frozen for the rest of its life. */
  | { kind: "submitted"; action: string }
  /** The submission failed to reach the agent. Editable again, so it can be retried. */
  | { kind: "failed"; action: string; error: string };

export type GenerativeUiCardState = {
  state: BoundState;
  status: GenerativeUiCardStatus;
  /** Whether controls should render read-only. Covers submission *and* historical cards. */
  frozen: boolean;
  setBound: (path: string, value: unknown) => void;
  submit: (action: string) => void;
};

export function useGenerativeUiCardState({
  toolCallId,
  stateDefaults,
  client,
  interactive,
  debounceMs = STATE_MIRROR_DEBOUNCE_MS,
}: {
  toolCallId: string;
  stateDefaults: BoundState;
  client: GenerativeUiClient | null;
  /**
   * False for a card the chat has moved past. Such a card renders its recorded state read-only and
   * never calls the client -- there is no live agent turn on the other end of it.
   */
  interactive: boolean;
  debounceMs?: number;
}): GenerativeUiCardState {
  const [state, setState] = useState<BoundState>(stateDefaults);
  const [status, setStatus] = useState<GenerativeUiCardStatus>({ kind: "editable" });

  // Read by the debounce timer and the submit handler, which must both see the newest values
  // without being re-created (and re-scheduled) on every keystroke.
  const stateRef = useRef(state);
  stateRef.current = state;
  const clientRef = useRef(client);
  clientRef.current = client;

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Submission is one-shot, and the button being disabled is not enough to enforce that: two
  // clicks in one tick both see the pre-disable render. This latch is set synchronously, so the
  // second one never reaches the client.
  const submittedRef = useRef(false);

  const flush = useCallback(() => {
    if (timerRef.current === null) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
    // A mirror write is advisory: the local copy already won, and the next edit resends the whole
    // state, so a failure has nothing to report and nothing to retry.
    void clientRef.current?.setState(toolCallId, stateRef.current).catch(() => {});
  }, [toolCallId]);

  // Flush on unmount so the last keystroke before the user scrolls away isn't the one that's lost.
  useEffect(() => flush, [flush]);

  const setBound = useCallback((path: string, value: unknown) => {
    setState((previous) => {
      const next = setAtPath(previous, path, value);
      stateRef.current = next;
      return next;
    });
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void clientRef.current?.setState(toolCallId, stateRef.current).catch(() => {});
    }, debounceMs);
  }, [debounceMs, toolCallId]);

  const submit = useCallback((action: string) => {
    const activeClient = clientRef.current;
    if (!activeClient || submittedRef.current) return;
    submittedRef.current = true;
    // Drop the pending mirror write: the submission carries the same state, and a mirror landing
    // after the card is consumed would be rejected anyway.
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setStatus({ kind: "submitting", action });
    const submitted = stateRef.current;
    void activeClient.submitAction(toolCallId, action, submitted).then(
      () => setStatus({ kind: "submitted", action }),
      (error: unknown) => {
        // Nothing was consumed, so the card goes back to being usable and the latch is released.
        submittedRef.current = false;
        setStatus({
          kind: "failed",
          action,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }, [toolCallId]);

  const frozen = !interactive || status.kind === "submitting" || status.kind === "submitted";

  return useMemo(
    () => ({ state, status, frozen, setBound, submit }),
    [state, status, frozen, setBound, submit],
  );
}
