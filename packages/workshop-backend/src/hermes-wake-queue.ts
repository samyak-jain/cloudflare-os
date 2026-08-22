/** Authenticated autonomous Hermes turn registration. */
export interface HermesWakeRegistration {
  workspaceId: string;
  chatId: number;
  sessionId: string;
  turnId: string;
  eventsUrl: string;
  idempotencyKey: string;
}

/** Durable lifecycle of an accepted wake. */
export type HermesWakeRecord = HermesWakeRegistration & {
  state: "queued" | "running" | "terminal" | "dead_letter";
  acceptedAt: number;
  attempts: number;
  nextAttemptAt: number;
  committedAfterSeq: number;
  terminalProjectionKey?: string;
  lastFailure?: HermesWakeFailure;
};

/** Bounded failure metadata retained for wake health inspection. */
export type HermesWakeFailure = {
  kind: "http" | "protocol" | "transport" | "timeout";
  status?: number;
  code?: string;
};

/** Minimal durable collection used by HermesWakeQueue. */
export interface HermesWakeRecords {
  get(idempotencyKey: string): HermesWakeRecord | undefined;
  put(record: HermesWakeRecord): void;
  list(): Iterable<HermesWakeRecord>;
}

/** Durable per-chat FIFO with idempotent registration and one serialized running turn. */
export class HermesWakeQueue {
  constructor(private records: HermesWakeRecords) {}

  /** Register without overwriting another accepted turn. */
  register(
    wake: HermesWakeRegistration,
    acceptedAt: number,
  ): { record: HermesWakeRecord; created: boolean } {
    let previous = this.records.get(wake.idempotencyKey);
    if (previous) {
      let {
        state: _state, acceptedAt: _acceptedAt, attempts: _attempts,
        nextAttemptAt: _nextAttemptAt, committedAfterSeq: _committedAfterSeq,
        terminalProjectionKey: _terminalProjectionKey, lastFailure: _lastFailure,
        ...registered
      } = previous;
      if (JSON.stringify(registered) !== JSON.stringify(wake)) {
        throw new Error("Hermes wake idempotency key was reused with a different payload.");
      }
      return { record: previous, created: false };
    }
    let existingRecords = [...this.records.list()];
    let conflict = existingRecords.find(
      (record) => record.chatId === wake.chatId && record.turnId === wake.turnId,
    );
    if (conflict) throw new Error("Hermes wake turn was reused with a different idempotency key.");
    let priorOrder = existingRecords.reduce(
      (maximum, record) => Math.max(maximum, record.acceptedAt),
      0,
    );
    let record: HermesWakeRecord = {
      ...wake,
      state: "queued",
      acceptedAt: Math.max(acceptedAt, priorOrder + 1),
      attempts: 0,
      nextAttemptAt: acceptedAt,
      committedAfterSeq: 0,
    };
    this.records.put(record);
    return { record, created: true };
  }

  /** Return the running record, or atomically promote the oldest queued record. */
  dequeue(chatId: number, now = Date.now()): HermesWakeRecord | undefined {
    let records = this.list(chatId);
    let running = records.find((record) => record.state === "running");
    if (running) return running;
    let queued = records.find(
      (record) => record.state === "queued" && record.nextAttemptAt <= now,
    );
    if (!queued) return undefined;
    queued.state = "running";
    this.records.put(queued);
    return queued;
  }

  /** Mark the running turn terminal only after Workshop's projection barrier. */
  complete(chatId: number, turnId: string): boolean {
    let record = this.list(chatId).find(
      (candidate) => candidate.state === "running" && candidate.turnId === turnId,
    );
    if (!record) return false;
    record.state = "terminal";
    this.records.put(record);
    return true;
  }

  /** Requeue a retryable failure, or durably dead-letter poison and exhausted wakes. */
  fail(
    chatId: number,
    turnId: string,
    failure: HermesWakeFailure,
    retryable: boolean,
    nextAttemptAt: number,
  ): HermesWakeRecord | undefined {
    let record = this.list(chatId).find(
      (candidate) => candidate.state === "running" && candidate.turnId === turnId,
    );
    if (!record) return undefined;
    record.attempts += 1;
    record.lastFailure = failure;
    if (!retryable || record.attempts >= 5) {
      record.state = "dead_letter";
      record.nextAttemptAt = 0;
    } else {
      record.state = "queued";
      record.nextAttemptAt = nextAttemptAt;
    }
    this.records.put(record);
    return record;
  }

  /** Record a terminal projection cursor before the wake acknowledgement is completed. */
  projectTerminal(
    chatId: number,
    turnId: string,
    sequence: number,
    projectionKey: string,
  ): boolean {
    let record = this.list(chatId).find(
      (candidate) => candidate.state === "running" && candidate.turnId === turnId,
    );
    if (!record) return false;
    if (record.terminalProjectionKey === projectionKey) return false;
    record.committedAfterSeq = Math.max(record.committedAfterSeq, sequence);
    record.terminalProjectionKey = projectionKey;
    this.records.put(record);
    return true;
  }

  /** Stable accepted order for one chat. */
  list(chatId: number): HermesWakeRecord[] {
    return [...this.records.list()]
      .filter((record) => record.chatId === chatId)
      .toSorted(
        (left, right) =>
          left.acceptedAt - right.acceptedAt ||
          left.idempotencyKey.localeCompare(right.idempotencyKey),
      );
  }
}
