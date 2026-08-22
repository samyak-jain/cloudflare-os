import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  classifyHermesFailure, HermesProtocolError, type HermesToolResult,
} from "../src/hermes-driver";
import { hermesToolCallKey, type HermesToolCallRecord } from "../src/hermes-tool-state";
import {
  HermesWakeQueue, type HermesWakeRecord, type HermesWakeRegistration,
} from "../src/hermes-wake-queue";

type Collection<T> = {
  get(key: string | number): T | undefined;
  put(record: T): void;
  list(): Iterable<T>;
};

type OverseerProbe = {
  impl: {
    storage: {
      chats: Collection<{chatId: number; sequence: number}>;
      chatMeta: Collection<Record<string, unknown>>;
      hermesChats: Collection<Record<string, unknown>>;
      hermesToolResults: Collection<HermesToolCallRecord>;
      hermesWakes: Collection<HermesWakeRecord>;
    };
    claimHermesToolCall(
      chatId: number, turnId: string, callId: string, toolName: string, sessionId: string,
    ): Promise<{execute: true} | {execute: false; result: HermesToolResult}>;
    resolveHermesToolCall(turnId: string, callId: string, result: HermesToolResult): void;
    recordHermesTurnStarted(chatId: number, turnId: string, sessionId: string): void;
    recordHermesTerminal(chatId: number, turnId: string, sequence: number): void;
    commitHermesTerminalProjection(
      chatId: number, turnId: string, sequence: number,
      author: {type: "agent"; id: string; name: string},
      messages: {type: "message"; message: string}[], totalTokens: number,
      gatewayLogId: undefined, gatewayRoute: undefined, estimatedCost: number,
    ): boolean;
    resumeHermesWakes(): Promise<void>;
  };
};

function impl(instance: unknown): OverseerProbe["impl"] {
  return (instance as OverseerProbe).impl;
}

function wake(workspaceId: string, suffix: string, acceptedAt = 1): HermesWakeRecord {
  return {
    workspaceId,
    chatId: 7,
    sessionId: `session-${suffix}`,
    turnId: `turn-${suffix}`,
    eventsUrl: `https://hermes.test/api/workshop/v1/turns/turn-${suffix}/events`,
    idempotencyKey: `wake-${suffix}`,
    state: "queued",
    acceptedAt,
    attempts: 0,
    nextAttemptAt: acceptedAt,
    committedAfterSeq: 0,
  };
}

const RESULT: HermesToolResult = {
  result: "done",
  isError: false,
  content: [{type: "text", text: "done"}],
};

describe("Hermes durability in the real Overseer Durable Object", () => {
  it("commits a tool claim before granting execution and serializes racing deliveries", async () => {
    let id = exports.OverseerDurableObject.newUniqueId();
    let stub = exports.OverseerDurableObject.get(id);
    await runInDurableObject(stub, async instance => {
      let overseer = impl(instance);
      let first = await overseer.claimHermesToolCall(
        7, "turn-race", "call-race", "writeFile", "session-1",
      );
      expect(first).toEqual({execute: true});
      expect(overseer.storage.hermesToolResults.get(
        hermesToolCallKey("turn-race", "call-race"),
      )).toMatchObject({state: "executing"});

    });
    let duplicate = runInDurableObject(stub, instance =>
      impl(instance).claimHermesToolCall(
        7, "turn-race", "call-race", "writeFile", "session-1",
      ));
    await new Promise(resolve => setTimeout(resolve, 10));
    await runInDurableObject(stub, instance => {
      impl(instance).resolveHermesToolCall("turn-race", "call-race", RESULT);
    });
    await expect(duplicate).resolves.toEqual({execute: false, result: RESULT});
  });

  it("turns an executeCode claim interrupted after object restart instead of replaying it", async () => {
    let id = exports.OverseerDurableObject.newUniqueId();
    await runInDurableObject(exports.OverseerDurableObject.get(id), instance =>
      impl(instance).claimHermesToolCall(
        7, "turn-crash", "call-code", "executeCode", "session-1",
      ));
    await abortAllDurableObjects();
    await runInDurableObject(exports.OverseerDurableObject.get(id), async instance => {
      await expect(impl(instance).claimHermesToolCall(
        7, "turn-crash", "call-code", "executeCode", "session-1",
      )).resolves.toMatchObject({
        execute: false,
        result: {isError: true, result: "execution state unknown after crash"},
      });
    });
  });

  it("retains an old-epoch executeCode row until that old turn becomes terminal", async () => {
    let id = exports.OverseerDurableObject.newUniqueId();
    await runInDurableObject(exports.OverseerDurableObject.get(id), async instance => {
      let overseer = impl(instance);
      overseer.storage.hermesChats.put({
        chatId: 7, modelId: "hermes", initiatorUserId: "user",
        initiator: {type: "user", id: "user", name: "User"},
      });
      overseer.recordHermesTurnStarted(7, "turn-old", "session-old");
      await overseer.claimHermesToolCall(
        7, "turn-old", "call-code", "executeCode", "session-old",
      );
      overseer.recordHermesTurnStarted(7, "turn-new", "session-new");
      expect(overseer.storage.hermesToolResults.get(
        hermesToolCallKey("turn-old", "call-code"),
      )).toBeDefined();
      overseer.recordHermesTerminal(7, "turn-new", 10);
      expect(overseer.storage.hermesToolResults.get(
        hermesToolCallKey("turn-old", "call-code"),
      )).toBeDefined();
      overseer.recordHermesTurnStarted(7, "turn-old", "session-old");
      overseer.recordHermesTerminal(7, "turn-old", 11);
      expect(overseer.storage.hermesToolResults.get(
        hermesToolCallKey("turn-old", "call-code"),
      )).toBeUndefined();
    });
  });

  it("does not append a terminal assistant projection twice after restart", async () => {
    let id = exports.OverseerDurableObject.newUniqueId();
    let userId = exports.UserDurableObject.newUniqueId().toString();
    let setup = async (instance: unknown) => {
      let overseer = impl(instance);
      overseer.storage.chatMeta.put({
        id: 7, title: "Hermes", started: new Date(1), lastActive: new Date(1),
      });
      overseer.storage.hermesChats.put({
        chatId: 7, sessionId: "session-1", currentTurnId: "turn-1",
        modelId: "hermes", initiatorUserId: userId,
        initiator: {type: "user", id: "user", name: "User"},
      });
      overseer.storage.hermesWakes.put({...wake(id.toString(), "1"), state: "running"});
      return overseer;
    };
    await runInDurableObject(exports.OverseerDurableObject.get(id), async instance => {
      let overseer = await setup(instance);
      expect(overseer.commitHermesTerminalProjection(
        7, "turn-1", 9, {type: "agent", id: "hermes", name: "Hermes"},
        [{type: "message", message: "one projection"}], 1, undefined, undefined, 0,
      )).toBe(true);
    });
    await abortAllDurableObjects();
    await runInDurableObject(exports.OverseerDurableObject.get(id), async instance => {
      let overseer = impl(instance);
      expect(overseer.commitHermesTerminalProjection(
        7, "turn-1", 9, {type: "agent", id: "hermes", name: "Hermes"},
        [{type: "message", message: "one projection"}], 1, undefined, undefined, 0,
      )).toBe(false);
      expect([...overseer.storage.chats.list()].filter(row => row.chatId === 7)).toHaveLength(1);
      await overseer.resumeHermesWakes();
      expect(overseer.storage.hermesWakes.get("wake-1")).toMatchObject({state: "terminal"});
    });
  });

  it("dead-letters poison once and lets a later ready wake advance", async () => {
    let id = exports.OverseerDurableObject.newUniqueId();
    await runInDurableObject(exports.OverseerDurableObject.get(id), instance => {
      let overseer = impl(instance);
      let queue = new HermesWakeQueue(overseer.storage.hermesWakes);
      queue.register(wake(id.toString(), "poison") satisfies HermesWakeRegistration, 1);
      queue.register(wake(id.toString(), "next") satisfies HermesWakeRegistration, 2);
      expect(queue.dequeue(7, 2)?.turnId).toBe("turn-poison");
      let classification = new HermesProtocolError("poison");
      let {metadata, retryable} = classifyHermesFailure(classification);
      expect(queue.fail(7, "turn-poison", metadata, retryable, 0))
        .toMatchObject({state: "dead_letter", attempts: 1});
      expect(queue.dequeue(7, 2)?.turnId).toBe("turn-next");
    });
  });

  it("retains a durably accepted wake across an object restart", async () => {
    let id = exports.OverseerDurableObject.newUniqueId();
    let userId = exports.UserDurableObject.newUniqueId().toString();
    let registration = wake(id.toString(), "accepted") satisfies HermesWakeRegistration;
    await runInDurableObject(exports.OverseerDurableObject.get(id), instance => {
      let overseer = impl(instance);
      overseer.storage.chatMeta.put({
        id: 7, title: "Hermes", started: new Date(1), lastActive: new Date(1),
        activeAgent: {type: "agent", id: "busy", name: "Busy"},
      });
      overseer.storage.hermesChats.put({
        chatId: 7, sessionId: "session-accepted", modelId: "hermes",
        initiatorUserId: userId,
        initiator: {type: "user", id: "user", name: "User"},
      });
    });
    await exports.OverseerDurableObject.get(id).acceptHermesWake(registration);
    await expect(exports.OverseerDurableObject.get(id).getHermesWakeHealth(7)).resolves.toEqual([
      expect.objectContaining({idempotencyKey: "wake-accepted", attempts: 0}),
    ]);
    // Model a retryable transport detachment after the 202 barrier. Its future due time keeps
    // constructor recovery from needing a configured model while still proving the accepted row
    // survives a real object restart.
    await runInDurableObject(exports.OverseerDurableObject.get(id), instance => {
      let records = impl(instance).storage.hermesWakes;
      let record = records.get("wake-accepted");
      if (!record) throw new Error("accepted wake disappeared");
      records.put({...record, state: "queued", nextAttemptAt: Date.now() + 60_000});
    });
    await abortAllDurableObjects();
    await expect(exports.OverseerDurableObject.get(id).getHermesWakeHealth(7)).resolves.toEqual([
      expect.objectContaining({
        idempotencyKey: "wake-accepted",
        state: "queued",
        attempts: 0,
      }),
    ]);
  });
});
