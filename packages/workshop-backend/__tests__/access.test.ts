import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AccessCertCache,
  accessRateLimitKey,
  resetAccessConfigurationErrorsForTest,
  verifyAccessJwtAssertion,
  verifyCfAccessJwt,
} from "../src/access.js";

const NOW_MS = 1_800_000_000_000;
const NOW_SECONDS = NOW_MS / 1000;
const accessEnv = {
  ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
  ACCESS_APP_AUD: "workshop-audience",
};

type TestKey = {
  kid: string;
  pair: CryptoKeyPair;
  jwk: JsonWebKey;
};

let firstKey: TestKey;
let secondKey: TestKey;

beforeAll(async () => {
  const generate = async (kid: string): Promise<TestKey> => {
    const pair = await crypto.subtle.generateKey(
        { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256" },
        true,
        ["sign", "verify"]);
    return {
      kid,
      pair,
      jwk: { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid, alg: "RS256", use: "sig" },
    };
  };
  [firstKey, secondKey] = await Promise.all([generate("key-1"), generate("key-2")]);
});

beforeEach(() => {
  resetAccessConfigurationErrorsForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function base64Url(value: string | ArrayBuffer): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function token({
  key = firstKey,
  kid = key.kid,
  alg = "RS256",
  claims = {},
}: {
  key?: TestKey;
  kid?: string;
  alg?: string;
  claims?: Record<string, unknown>;
} = {}): Promise<string> {
  const header = base64Url(JSON.stringify({ alg, kid, typ: "JWT" }));
  const payload = base64Url(JSON.stringify({
    aud: accessEnv.ACCESS_APP_AUD,
    email: "person@example.com",
    exp: NOW_SECONDS + 300,
    iss: `https://${accessEnv.ACCESS_TEAM_DOMAIN}`,
    nbf: NOW_SECONDS - 30,
    sub: "user-1",
    ...claims,
  }));
  const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5", key.pair.privateKey, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64Url(signature)}`;
}

function certCache(...sets: JsonWebKey[][]): { cache: AccessCertCache; fetcher: ReturnType<typeof vi.fn> } {
  let next = 0;
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ keys: sets[Math.min(next++, sets.length - 1)] }), {
    headers: { "cache-control": "public, max-age=3600", "content-type": "application/json" },
  }));
  return {
    cache: new AccessCertCache({ fetcher: fetcher as typeof fetch, now: () => NOW_MS }),
    fetcher,
  };
}

async function verify(assertion: string, cache: AccessCertCache) {
  return verifyAccessJwtAssertion(assertion, accessEnv, { certCache: cache, now: () => NOW_MS });
}

describe("Cloudflare Access JWT verification", () => {
  it("binds the default fetcher to the workerd global scope", async () => {
    // workerd's native fetch throws the same error when called with another receiver. Use a strict
    // double so this remains a deterministic regression test even in runtimes with permissive fetch.
    const defaultFetcher = vi.fn<typeof fetch>(function(this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation: incorrect `this` reference");
      return Promise.resolve(Response.json({ keys: [firstKey.jwk] }, {
        headers: { "cache-control": "max-age=3600" },
      }));
    });
    vi.stubGlobal("fetch", defaultFetcher);
    const cache = new AccessCertCache({ now: () => NOW_MS });

    await expect(verify(await token(), cache)).resolves.not.toBeNull();
    expect(defaultFetcher).toHaveBeenCalledOnce();
  });

  it("accepts a valid RS256 assertion and an audience array containing the configured AUD", async () => {
    const { cache, fetcher } = certCache([firstKey.jwk]);
    const assertion = await token({ claims: { aud: ["another-app", accessEnv.ACCESS_APP_AUD] } });

    await expect(verify(assertion, cache)).resolves.toMatchObject({
      email: "person@example.com",
      sub: "user-1",
    });
    await expect(verify(assertion, cache)).resolves.not.toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
      { headers: { accept: "application/json" } },
    );
  });

  it.each([
    ["wrong audience", { aud: "other-audience" }],
    ["wrong issuer", { iss: "https://other.cloudflareaccess.com" }],
    ["expired", { exp: NOW_SECONDS }],
    ["not yet valid beyond clock skew", { nbf: NOW_SECONDS + 61 }],
    ["missing expiration", { exp: undefined }],
  ])("rejects a token with %s", async (_name, claims) => {
    const { cache } = certCache([firstKey.jwk]);
    await expect(verify(await token({ claims }), cache)).resolves.toBeNull();
  });

  it("rejects a bad signature even when the declared kid exists", async () => {
    const { cache } = certCache([firstKey.jwk]);
    await expect(verify(await token({ key: secondKey, kid: firstKey.kid }), cache))
      .resolves.toBeNull();
  });

  it("allows up to 60 seconds of clock skew for nbf while keeping exp strict", async () => {
    const { cache } = certCache([firstKey.jwk]);
    await expect(verify(await token({ claims: { nbf: NOW_SECONDS + 60 } }), cache))
      .resolves.not.toBeNull();
    await expect(verify(await token({ claims: { exp: NOW_SECONDS } }), cache))
      .resolves.toBeNull();
  });

  it("rejects any declared algorithm other than RS256 before fetching certs", async () => {
    const { cache, fetcher } = certCache([firstKey.jwk]);
    await expect(verify(await token({ alg: "HS256" }), cache)).resolves.toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects an unknown kid", async () => {
    const { cache, fetcher } = certCache([firstKey.jwk]);
    await expect(verify(await token({ kid: "missing-key" }), cache)).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("refreshes a still-live cert cache when a rotated kid appears", async () => {
    const { cache, fetcher } = certCache([firstKey.jwk], [secondKey.jwk]);
    await expect(verify(await token(), cache)).resolves.not.toBeNull();
    await expect(verify(await token({ key: secondKey }), cache)).resolves.not.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("throttles repeated unknown-kid refreshes", async () => {
    const { cache, fetcher } = certCache([firstKey.jwk], [firstKey.jwk]);
    await expect(verify(await token(), cache)).resolves.not.toBeNull();
    await expect(verify(await token({ kid: "missing-1" }), cache)).resolves.toBeNull();
    await expect(verify(await token({ kid: "missing-2" }), cache)).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("clamps short cache headers to 60 seconds, then refreshes a reused kid", async () => {
    let now = NOW_MS;
    let next = 0;
    const rotatedJwk = { ...secondKey.jwk, kid: firstKey.kid };
    const fetcher = vi.fn(async () => Response.json({
      keys: next++ === 0 ? [firstKey.jwk] : [rotatedJwk],
    }, { headers: { "cache-control": "max-age=1" } }));
    const cache = new AccessCertCache({ fetcher: fetcher as typeof fetch, now: () => now });

    await expect(verifyAccessJwtAssertion(await token(), accessEnv,
      { certCache: cache, now: () => now })).resolves.not.toBeNull();
    now += 1000;
    await expect(verifyAccessJwtAssertion(await token(), accessEnv,
      { certCache: cache, now: () => now })).resolves.not.toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
    now += 59_000;
    await expect(verifyAccessJwtAssertion(
      await token({ key: secondKey, kid: firstKey.kid }), accessEnv,
      { certCache: cache, now: () => now })).resolves.not.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("is feature-off with absent vars and never trusts the cookie as an assertion", async () => {
    const { cache, fetcher } = certCache([firstKey.jwk]);
    const assertion = await token();
    await expect(verifyAccessJwtAssertion(assertion, {}, { certCache: cache, now: () => NOW_MS }))
      .resolves.toBeNull();
    const cookieOnly = new Request("https://workshop.example/api", {
      headers: { cookie: `CF_Authorization=${assertion}` },
    });
    await expect(verifyCfAccessJwt(cookieOnly, accessEnv, { certCache: cache, now: () => NOW_MS }))
      .resolves.toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("logs malformed Access configuration once but keeps token failures quiet", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { cache } = certCache([firstKey.jwk]);
    const malformed = {
      ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      ACCESS_APP_AUD: accessEnv.ACCESS_APP_AUD,
    };

    await expect(verifyAccessJwtAssertion(await token(), malformed,
      { certCache: cache, now: () => NOW_MS })).resolves.toBeNull();
    await expect(verifyAccessJwtAssertion(await token(), malformed,
      { certCache: cache, now: () => NOW_MS })).resolves.toBeNull();
    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0][0]).toMatchObject({
      component: "workshop.access",
      event: "auth.access.configuration.invalid",
      message: "invalid Cloudflare Access configuration",
    });

    error.mockClear();
    await expect(verifyAccessJwtAssertion("not-a-jwt", accessEnv,
      { certCache: cache, now: () => NOW_MS })).resolves.toBeNull();
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("fails closed when only one Access variable is configured", async () => {
    const { cache, fetcher } = certCache([firstKey.jwk]);
    const assertion = await token();
    await expect(verifyAccessJwtAssertion(assertion,
      { ACCESS_TEAM_DOMAIN: accessEnv.ACCESS_TEAM_DOMAIN },
      { certCache: cache, now: () => NOW_MS })).resolves.toBeNull();
    await expect(verifyAccessJwtAssertion(assertion,
      { ACCESS_APP_AUD: accessEnv.ACCESS_APP_AUD },
      { certCache: cache, now: () => NOW_MS })).resolves.toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("accessRateLimitKey", () => {
  it("uses the verified subject and hashes email only as a fallback", async () => {
    await expect(accessRateLimitKey({ sub: "user-1", email: "person@example.com" }))
      .resolves.toBe("access-sub:user-1");
    const emailKey = await accessRateLimitKey({ email: "person@example.com" });
    expect(emailKey).toMatch(/^access-email:[0-9a-f]{64}$/);
    expect(emailKey).not.toContain("person@example.com");
  });
});
