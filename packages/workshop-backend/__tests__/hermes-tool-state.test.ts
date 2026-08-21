import { describe, expect, it } from "vitest";

import {
  HermesToolCallStateMachine,
  hermesToolCallKey,
  type HermesToolCallRecord,
} from "../src/hermes-tool-state";

function fixture() {
  let rows = new Map<string, HermesToolCallRecord>();
  return {
    rows,
    machine: new HermesToolCallStateMachine({
      get: (key) => rows.get(key),
      put: (record) => {
        rows.set(hermesToolCallKey(record.turnId, record.callId), record);
      },
    }),
  };
}

describe("Hermes durable tool claims", () => {
  it("writes the executing claim before granting execution", async () => {
    let { rows, machine } = fixture();
    await expect(machine.claim(7, "turn-1", "call-1", "writeFile")).resolves.toEqual({
      execute: true,
    });
    expect(rows.get(hermesToolCallKey("turn-1", "call-1"))).toMatchObject({
      state: "executing",
      toolName: "writeFile",
    });
  });

  it("serializes two racing deliveries on the in-memory claim waiter", async () => {
    let { machine } = fixture();
    await machine.claim(7, "turn-1", "call-1", "createGadget");
    let duplicate = machine.claim(7, "turn-1", "call-1", "createGadget");
    let result = {
      result: "created",
      isError: false,
      content: [{ type: "text" as const, text: "created" }],
    };
    machine.resolve("turn-1", "call-1", result);
    await expect(duplicate).resolves.toEqual({ execute: false, result });
  });

  it("replays a tagged mutation after restart but never re-executes executeCode", async () => {
    let { rows, machine } = fixture();
    await machine.claim(7, "turn-1", "write", "writeFile");
    await machine.claim(7, "turn-1", "code", "executeCode");
    let restarted = new HermesToolCallStateMachine({
      get: (key) => rows.get(key),
      put: (record) => {
        rows.set(hermesToolCallKey(record.turnId, record.callId), record);
      },
    });
    await expect(restarted.claim(7, "turn-1", "write", "writeFile")).resolves.toEqual({
      execute: true,
    });
    await expect(restarted.claim(7, "turn-1", "code", "executeCode")).resolves.toMatchObject({
      execute: false,
      result: { isError: true, result: "execution state unknown after crash" },
    });
  });
});
