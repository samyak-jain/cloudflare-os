import { describe, expect, it } from "vitest";

import {
  HermesWakeQueue,
  type HermesWakeRecord,
  type HermesWakeRegistration,
} from "../src/hermes-wake-queue";

function wake(id: string): HermesWakeRegistration {
  return {
    workspaceId: "workspace-1",
    chatId: 7,
    sessionId: "session-1",
    turnId: `turn-${id}`,
    eventsUrl: `https://hermes.test/api/workshop/v1/turns/turn-${id}/events`,
    idempotencyKey: `wake-${id}`,
  };
}

function fixture() {
  let records = new Map<string, HermesWakeRecord>();
  return {
    records,
    queue: new HermesWakeQueue({
      get: (key) => records.get(key),
      put: (record) => {
        records.set(record.idempotencyKey, record);
      },
      list: () => records.values(),
    }),
  };
}

describe("Hermes durable wake queue", () => {
  it("retains two accepted wakes and dequeues them serially", () => {
    let { queue } = fixture();
    queue.register(wake("a"), 1);
    queue.register(wake("b"), 2);
    expect(queue.dequeue(7)?.turnId).toBe("turn-a");
    expect(queue.dequeue(7)?.turnId).toBe("turn-a");
    expect(queue.complete(7, "turn-a")).toBe(true);
    expect(queue.dequeue(7)?.turnId).toBe("turn-b");
  });

  it("keeps a 202-retried registration idempotent after terminal acknowledgement", () => {
    let { queue, records } = fixture();
    queue.register(wake("a"), 1);
    queue.dequeue(7);
    queue.complete(7, "turn-a");
    expect(queue.register(wake("a"), 10)).toMatchObject({
      created: false,
      record: { state: "terminal", acceptedAt: 1 },
    });
    expect(records.size).toBe(1);
  });

  it("skips a sleeping retry and advances the next ready wake", () => {
    let { queue } = fixture();
    queue.register(wake("a"), 1);
    queue.register(wake("b"), 2);
    queue.dequeue(7, 2);
    expect(queue.fail(7, "turn-a", { kind: "transport" }, true, 100)).toMatchObject({
      state: "queued",
      attempts: 1,
      nextAttemptAt: 100,
    });
    expect(queue.dequeue(7, 3)?.turnId).toBe("turn-b");
  });

  it("dead-letters permanent poison immediately and retryable failures after five attempts", () => {
    let { queue } = fixture();
    queue.register(wake("poison"), 1);
    queue.dequeue(7, 1);
    expect(queue.fail(7, "turn-poison", { kind: "http", status: 404 }, false, 0))
      .toMatchObject({ state: "dead_letter", attempts: 1 });

    queue.register(wake("retry"), 2);
    for (let attempt = 1; attempt <= 5; attempt++) {
      queue.dequeue(7, attempt + 2);
      let failed = queue.fail(
        7, "turn-retry", { kind: "http", status: 503 }, true, attempt + 2,
      );
      expect(failed?.state).toBe(attempt === 5 ? "dead_letter" : "queued");
    }
  });
});
