import { afterEach, describe, expect, it, vi } from "vitest";
import { exports } from "cloudflare:workers";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { PublicApi } from "@gadgets/workshop-shared/api";

const TEAM_DOMAIN = "team.cloudflareaccess.com";
const APP_AUD = "workshop-test-audience";

function base64Url(value: string | ArrayBuffer): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function accessFixture(email: string): Promise<{ assertion: string; jwk: JsonWebKey }> {
  const pair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"]);
  const kid = `rpc-${crypto.randomUUID()}`;
  const header = base64Url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64Url(JSON.stringify({
    aud: [APP_AUD],
    email,
    exp: now + 300,
    iss: `https://${TEAM_DOMAIN}`,
    nbf: now - 30,
    sub: `subject-${crypto.randomUUID()}`,
  }));
  const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5", pair.privateKey,
      new TextEncoder().encode(`${header}.${payload}`));
  return {
    assertion: `${header}.${payload}.${base64Url(signature)}`,
    jwk: { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid, alg: "RS256", use: "sig" },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("Cloudflare Access RPC bootstrap", () => {
  it("authenticates through the real WebSocket path and provisions a normal account", async () => {
    const email = `access-${crypto.randomUUID()}@example.com`;
    const { assertion, jwk } = await accessFixture(email);
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ keys: [jwk] }, {
      headers: { "cache-control": "max-age=3600" },
    }));
    vi.stubGlobal("fetch", fetcher);

    const response = await exports.default.fetch(new Request("https://workshop.invalid/api", {
      headers: {
        "cf-access-jwt-assertion": assertion,
        origin: "https://workshop.invalid",
        Upgrade: "websocket",
      },
    }));
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) throw new TypeError("Expected a WebSocket response.");
    socket.accept();

    using publicApi: RpcStub<PublicApi> = newWebSocketRpcSession<PublicApi>(socket);
    using authenticated = await publicApi.authenticateFromCfAccess();
    await expect(authenticated.whoami()).resolves.toEqual({
      type: "user",
      id: email,
      name: email.split("@", 1)[0],
    });
    await expect(authenticated.hasPasswordLogin()).resolves.toBe(false);
    expect(fetcher).toHaveBeenCalledWith(
      `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`,
      { headers: { accept: "application/json" } },
    );
  });
});
