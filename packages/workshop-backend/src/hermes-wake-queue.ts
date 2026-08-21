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
  state: "queued" | "running" | "terminal";
  acceptedAt: number;
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
      let { state: _state, acceptedAt: _acceptedAt, ...registered } = previous;
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
    };
    this.records.put(record);
    return { record, created: true };
  }

  /** Return the running record, or atomically promote the oldest queued record. */
  dequeue(chatId: number): HermesWakeRecord | undefined {
    let records = this.list(chatId);
    let running = records.find((record) => record.state === "running");
    if (running) return running;
    let queued = records.find((record) => record.state === "queued");
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
