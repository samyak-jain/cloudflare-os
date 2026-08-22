/**
 * The object the chat UI feeds and the avatar component reads.
 *
 * `ChatInterface` already owns exactly one `AiChatSubscriber` for the whole workspace. The avatar
 * must not open a second subscription -- a second one would double the DO's push fan-out and, worse,
 * replay history the UI has already consumed. So the controller is a plain sink: the existing
 * subscriber's `stream()` / `message()` / `metadata()` handlers hand it what they already received,
 * and it publishes an `AvatarStateSnapshot` for whoever is rendering.
 *
 * It owns the clock (`performance.now()`) and one timer -- armed only when a held state has a
 * deadline, never as a poll.
 */

import type { AiChatStreamEvent } from "@gadgets/workshop-shared/api";
import { AvatarStateMachine, type AvatarMessageInput, type AvatarTimings } from "./mapping";
import { sameAvatarState, type AvatarStateSnapshot } from "./state";

type Listener = () => void;

export class AvatarController {
  readonly #machine: AvatarStateMachine;
  readonly #listeners = new Set<Listener>();
  readonly #now: () => number;

  #snapshot: AvatarStateSnapshot;
  #timer: ReturnType<typeof setTimeout> | null = null;
  /** The chat the avatar is following. Events for other chats are ignored. */
  #chatId: number | null = null;

  constructor(options: { timings?: Partial<AvatarTimings>; now?: () => number } = {}) {
    this.#machine = new AvatarStateMachine(options.timings);
    this.#now = options.now ?? (() => performance.now());
    this.#snapshot = this.#machine.snapshot(this.#now());
  }

  // ── subscription (useSyncExternalStore) ───────────────────────────────────────────────────────

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  getSnapshot = (): AvatarStateSnapshot => this.#snapshot;

  // ── feed ──────────────────────────────────────────────────────────────────────────────────────

  /**
   * Switches which chat the avatar follows. Called when the selected chat changes; resets the
   * machine so a previous conversation's tail never bleeds into a freshly opened one.
   */
  setChat(chatId: number | null): void {
    if (chatId === this.#chatId) return;
    this.#chatId = chatId;
    this.#machine.reset();
    this.#publish();
  }

  handleStream(chatId: number, event: AiChatStreamEvent): void {
    if (chatId !== this.#chatId) return;
    this.#machine.handleStream(event, this.#now());
    this.#publish();
  }

  handleMessage(chatId: number, msg: AvatarMessageInput): void {
    if (chatId !== this.#chatId) return;
    this.#machine.handleMessage(msg, this.#now());
    this.#publish();
  }

  setAgentActive(chatId: number, active: boolean): void {
    if (chatId !== this.#chatId) return;
    this.#machine.setAgentActive(active, this.#now());
    this.#publish();
  }

  setConnectionLost(lost: boolean): void {
    this.#machine.setConnectionLost(lost);
    this.#publish();
  }

  noteUserComposing(): void {
    this.#machine.noteUserComposing(this.#now());
    this.#publish();
  }

  noteUserMessageSent(): void {
    this.#machine.noteUserMessageSent(this.#now());
    this.#publish();
  }

  destroy(): void {
    this.#clearTimer();
    this.#listeners.clear();
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────────

  #publish(): void {
    const now = this.#now();
    const next = this.#machine.snapshot(now);
    if (!sameAvatarState(next.state, this.#snapshot.state) || next.since !== this.#snapshot.since) {
      this.#snapshot = next;
      for (const listener of this.#listeners) listener();
    }
    this.#arm(now);
  }

  /**
   * Arms a single timer for the next moment a held state expires on its own.
   *
   * `done` and `error` are the only states that end without an event, so this fires at most twice
   * per turn. Everything else is edge-driven.
   */
  #arm(now: number): void {
    this.#clearTimer();
    const delay = this.#machine.nextChangeIn(now);
    if (delay === null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#publish();
    }, Math.max(0, delay) + 1);
  }

  #clearTimer(): void {
    if (this.#timer === null) return;
    clearTimeout(this.#timer);
    this.#timer = null;
  }
}
