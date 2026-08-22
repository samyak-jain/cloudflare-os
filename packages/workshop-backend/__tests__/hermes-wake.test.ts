import { describe, expect, it, vi } from "vitest";

import { handleHermesWake } from "../src/hermes-wake";

const TOKEN = "wake-token";
const BODY = {
  workspace_id: "workspace-1",
  chat_id: "7",
  session_id: "session-1",
  turn_id: "turn-1",
  events_url: "https://hermes.test/api/workshop/v1/turns/turn-1/events",
  idempotency_key: "spawn-1",
};

function request(body: unknown = BODY, token = TOKEN): Request {
  return new Request("https://workshop.test/api/hermes/wake", {
    method: "POST",
    headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json"},
    body: JSON.stringify(body),
  });
}

function fixture() {
  let acceptHermesWake = vi.fn(async () => {});
  let namespace = {
    idFromString: vi.fn((id: string) => id),
    get: vi.fn(() => ({acceptHermesWake})),
  };
  let env = {
    HERMES_BASE_URL: "https://hermes.test",
    WORKSHOP_WAKE_TOKEN: TOKEN,
  } as Cloudflare.Env;
  let ctx = {exports: {OverseerDurableObject: namespace}} as unknown as ExecutionContext;
  return {acceptHermesWake, env, ctx};
}

describe("Hermes wake endpoint", () => {
  it("acknowledges only after the existing turn is registered", async () => {
    let {acceptHermesWake, env, ctx} = fixture();
    let response = await handleHermesWake(request(), env, ctx);
    expect(response.status).toBe(202);
    expect(acceptHermesWake).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      chatId: 7,
      sessionId: "session-1",
      turnId: "turn-1",
      eventsUrl: BODY.events_url,
      idempotencyKey: "spawn-1",
    });
  });

  it("rejects the wrong wake token without touching storage", async () => {
    let {acceptHermesWake, env, ctx} = fixture();
    let response = await handleHermesWake(request(BODY, "wrong"), env, ctx);
    expect(response.status).toBe(401);
    expect(acceptHermesWake).not.toHaveBeenCalled();
  });

  it("rejects an event URL that could exfiltrate the Workshop API key", async () => {
    let {acceptHermesWake, env, ctx} = fixture();
    let response = await handleHermesWake(request({
      ...BODY,
      events_url: "https://attacker.test/api/workshop/v1/turns/turn-1/events",
    }), env, ctx);
    expect(response.status).toBe(400);
    expect(acceptHermesWake).not.toHaveBeenCalled();
  });
});
