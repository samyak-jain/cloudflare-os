import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { exports } from "cloudflare:workers";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { PublicApi } from "@gadgets/workshop-shared/api";

const TEAM_DOMAIN = "team.cloudflareaccess.com";
const APP_AUD = "workshop-test-audience";

let signingKey: CryptoKeyPair;
let forgedSigningKey: CryptoKeyPair;
let signingJwk: JsonWebKey;
let signingKid: string;

function generateSigningKey(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"]) as Promise<CryptoKeyPair>;
}

function base64Url(value: string | ArrayBuffer): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function accessAssertion(
    email: string,
    pair: CryptoKeyPair = signingKey): Promise<string> {
  const header = base64Url(JSON.stringify({ alg: "RS256", kid: signingKid, typ: "JWT" }));
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
  return `${header}.${payload}.${base64Url(signature)}`;
}

function apiRequest(headers: HeadersInit = {}): Request {
  return new Request("https://workshop.invalid/api", {
    headers: { Upgrade: "websocket", ...headers },
  });
}

async function connect(assertion: string): Promise<RpcStub<PublicApi>> {
  const response = await exports.default.fetch(apiRequest({
    "cf-access-jwt-assertion": assertion,
    origin: "https://workshop.invalid",
  }));
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new TypeError("Expected a WebSocket response.");
  socket.accept();
  return newWebSocketRpcSession<PublicApi>(socket);
}

beforeAll(async () => {
  [signingKey, forgedSigningKey] = await Promise.all([
    generateSigningKey(),
    generateSigningKey(),
  ]);
  signingKid = `rpc-${crypto.randomUUID()}`;
  signingJwk = {
    ...await crypto.subtle.exportKey("jwk", signingKey.publicKey),
    kid: signingKid,
    alg: "RS256",
    use: "sig",
  };
});

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => Response.json({ keys: [signingJwk] }, {
    headers: { "cache-control": "max-age=3600" },
  })));
});

afterEach(() => vi.unstubAllGlobals());

describe("Cloudflare Access RPC bootstrap", () => {
  it("authenticates through the real WebSocket path and provisions a normalized account", async () => {
    const rawEmail = `Access-${crypto.randomUUID()}@Example.COM`;
    const email = rawEmail.toLowerCase();

    using publicApi = await connect(await accessAssertion(rawEmail));
    await expect(publicApi.getServerConfig()).resolves.toMatchObject({
      accessAuthEnabled: true,
      authVendors: [],
      passwordAuthEnabled: false,
    });
    using authenticated = await publicApi.authenticateFromCfAccess();
    await expect(authenticated.whoami()).resolves.toEqual({
      type: "user",
      id: email,
      name: email.split("@", 1)[0],
    });
    await expect(authenticated.hasPasswordLogin()).resolves.toBe(false);
  });

  it("keeps password login and signup closed on an Access deployment", async () => {
    using publicApi = await connect(await accessAssertion(`access-${crypto.randomUUID()}@example.com`));

    await expect(publicApi.login("attacker", new Uint8Array([1])))
      .rejects.toThrow("This deployment requires Cloudflare Access authentication.");
    await expect(publicApi.createAccount("attacker", "Attacker", new Uint8Array([1])))
      .rejects.toThrow("This deployment requires Cloudflare Access authentication.");
  });

  it("rejects a cross-origin request even with a valid assertion", async () => {
    const response = await exports.default.fetch(apiRequest({
      "cf-access-jwt-assertion": await accessAssertion("person@example.com"),
      origin: "https://evil.example",
    }));
    expect(response.status).toBe(403);
  });

  it("rejects a cross-origin HTTP-batch request before RPC parsing", async () => {
    const response = await exports.default.fetch(new Request("https://workshop.invalid/api", {
      method: "POST",
      headers: {
        "cf-access-jwt-assertion": await accessAssertion("person@example.com"),
        origin: "https://evil.example",
      },
      body: "[]",
    }));
    expect(response.status).toBe(403);
  });

  it("rejects a request with no Origin even with a valid assertion", async () => {
    const response = await exports.default.fetch(apiRequest({
      "cf-access-jwt-assertion": await accessAssertion("person@example.com"),
    }));
    expect(response.status).toBe(403);
  });

  it("rejects a same-origin request with no assertion", async () => {
    const response = await exports.default.fetch(apiRequest({ origin: "https://workshop.invalid" }));
    expect(response.status).toBe(403);
  });

  it("rejects a forged assertion with a real kid", async () => {
    const response = await exports.default.fetch(apiRequest({
      "cf-access-jwt-assertion": await accessAssertion("person@example.com", forgedSigningKey),
      origin: "https://workshop.invalid",
    }));
    expect(response.status).toBe(403);
  });

  it("rejects a cookie-only request", async () => {
    const response = await exports.default.fetch(apiRequest({
      cookie: `CF_Authorization=${await accessAssertion("person@example.com")}`,
      origin: "https://workshop.invalid",
    }));
    expect(response.status).toBe(403);
  });
});
