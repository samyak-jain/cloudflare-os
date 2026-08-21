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
});
