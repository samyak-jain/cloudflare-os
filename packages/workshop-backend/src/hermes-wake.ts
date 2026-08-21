import type { HermesWakeRegistration } from "./overseer";

function constantTimeEqual(left: string, right: string): boolean {
  let leftBytes = new TextEncoder().encode(left);
  let rightBytes = new TextEncoder().encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  let length = Math.max(leftBytes.length, rightBytes.length);
  for (let i = 0; i < length; i++) {
    difference |= (leftBytes[i] ?? 0) ^ (rightBytes[i] ?? 0);
  }
  return difference === 0;
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`${field} is not a valid Hermes identifier.`);
  }
  return value;
}

/** Authenticate, validate, and durably register a Hermes autonomous-turn wake. */
export async function handleHermesWake(req: Request, env: Cloudflare.Env,
                                       ctx: ExecutionContext): Promise<Response> {
  if (req.method !== "POST") return new Response("Method Not Allowed", {status: 405});
  if (!env.WORKSHOP_WAKE_TOKEN) {
    return Response.json({error: "Hermes wake is not configured."}, {status: 503});
  }
  let authorization = req.headers.get("Authorization") ?? "";
  if (!constantTimeEqual(authorization, `Bearer ${env.WORKSHOP_WAKE_TOKEN}`)) {
    return Response.json({error: "Unauthorized"}, {status: 401});
  }

  try {
    let raw: unknown = await req.json();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Wake body must be an object.");
    }
    let body = raw as Record<string, unknown>;
    let expected = new Set([
      "workspace_id", "chat_id", "session_id", "turn_id", "events_url", "idempotency_key",
    ]);
    if (Object.keys(body).some(key => !expected.has(key)) || Object.keys(body).length !== 6) {
      throw new Error("Wake body has missing or unsupported fields.");
    }
    let workspaceId = identifier(body.workspace_id, "workspace_id");
    let chatIdText = identifier(body.chat_id, "chat_id");
    if (!/^\d+$/.test(chatIdText)) throw new Error("chat_id must be a decimal chat number.");
    let chatId = Number(chatIdText);
    if (!Number.isSafeInteger(chatId)) throw new Error("chat_id is outside the safe integer range.");
    let sessionId = identifier(body.session_id, "session_id");
    let turnId = identifier(body.turn_id, "turn_id");
    let idempotencyKey = identifier(body.idempotency_key, "idempotency_key");
    if (typeof body.events_url !== "string" || !env.HERMES_BASE_URL) {
      throw new Error("events_url or HERMES_BASE_URL is missing.");
    }
    let eventsUrl = new URL(body.events_url);
    let hermesBase = new URL(env.HERMES_BASE_URL);
    let expectedPath = `/api/workshop/v1/turns/${encodeURIComponent(turnId)}/events`;
    if (eventsUrl.origin !== hermesBase.origin || eventsUrl.pathname !== expectedPath ||
        eventsUrl.username || eventsUrl.password) {
      throw new Error("events_url must name this turn on the configured Hermes origin.");
    }

    let wake: HermesWakeRegistration = {
      workspaceId, chatId, sessionId, turnId, eventsUrl: eventsUrl.toString(), idempotencyKey,
    };
    let namespace = ctx.exports.OverseerDurableObject;
    let stub = namespace.get(namespace.idFromString(workspaceId));
    await stub.acceptHermesWake(wake);
    return Response.json({accepted: true}, {status: 202});
  } catch (error) {
    let message = error instanceof Error ? error.message : `${error}`;
    let status = /not valid|must |missing|unsupported|outside|events_url|Invalid URL/.test(message)
      ? 400 : 409;
    return Response.json({error: message}, {status});
  }
}
