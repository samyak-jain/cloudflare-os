import { createWorkshopLogger } from "./observability.js";

/** Cloudflare Access settings required to verify an assertion. */
export type AccessEnv = Readonly<{
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_APP_AUD?: string;
}>;

/** Claims retained from a fully-verified Cloudflare Access JWT. */
export type AccessJwtPayload = Readonly<Record<string, unknown> & {
  aud?: string | string[];
  email?: string;
  exp?: number;
  iss?: string;
  nbf?: number;
  sub?: string;
}>;

type AccessConfig = Readonly<{
  audience: string;
  issuer: string;
  teamDomain: string;
}>;

type CachedCerts = {
  expiresAt: number;
  keys: Map<string, CryptoKey>;
  lastMissRefreshAt?: number;
};

type AccessCertCacheOptions = {
  fetcher?: typeof fetch;
  now?: () => number;
};

const DEFAULT_CERT_TTL_SECONDS = 300;
const MIN_CERT_TTL_SECONDS = 60;
const MAX_CERT_TTL_SECONDS = 86_400;
const NBF_CLOCK_SKEW_SECONDS = 60;
const UNKNOWN_KID_REFRESH_INTERVAL_MS = 30_000;
const TEAM_DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+cloudflareaccess\.com$/;
const logger = createWorkshopLogger("workshop.access");
const loggedConfigurationErrors = new Set<string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configuredAccess(env: AccessEnv): AccessConfig | null {
  const rawTeamDomain = env.ACCESS_TEAM_DOMAIN?.trim();
  const audience = env.ACCESS_APP_AUD?.trim();
  if (!rawTeamDomain && !audience) return null;
  if (!rawTeamDomain || !audience) {
    throw new Error("ACCESS_TEAM_DOMAIN and ACCESS_APP_AUD must be configured together.");
  }

  const teamDomain = rawTeamDomain.toLowerCase();
  if (!TEAM_DOMAIN_PATTERN.test(teamDomain)) {
    throw new Error("ACCESS_TEAM_DOMAIN must be a cloudflareaccess.com hostname without a scheme or path.");
  }

  return {
    audience,
    issuer: `https://${teamDomain}`,
    teamDomain,
  };
}

function cacheTtlSeconds(response: Response): number {
  const cacheControl = response.headers.get("cache-control") ?? "";
  const match = cacheControl.match(/(?:^|,)\s*max-age=(\d+)/i);
  const seconds = match ? Number(match[1]) : DEFAULT_CERT_TTL_SECONDS;
  return Math.max(MIN_CERT_TTL_SECONDS,
      Math.min(Number.isSafeInteger(seconds) ? seconds : DEFAULT_CERT_TTL_SECONDS,
          MAX_CERT_TTL_SECONDS));
}

function logConfigurationErrorOnce(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (loggedConfigurationErrors.has(message)) return;
  loggedConfigurationErrors.add(message);
  logger.error("invalid Cloudflare Access configuration", {
    event: "auth.access.configuration.invalid",
    error,
  });
}

async function importCerts(value: unknown): Promise<Map<string, CryptoKey>> {
  if (!isRecord(value) || !Array.isArray(value.keys)) {
    throw new Error("Cloudflare Access certs response did not contain a JWK set.");
  }

  const keys = new Map<string, CryptoKey>();
  for (const candidate of value.keys) {
    if (!isRecord(candidate) || candidate.kty !== "RSA" || typeof candidate.kid !== "string" ||
        candidate.kid.length === 0 || typeof candidate.n !== "string" ||
        typeof candidate.e !== "string" || (candidate.use !== undefined && candidate.use !== "sig") ||
        (candidate.alg !== undefined && candidate.alg !== "RS256")) {
      continue;
    }
    if (keys.has(candidate.kid)) {
      throw new Error("Cloudflare Access certs response contained a duplicate key ID.");
    }
    const jwk: JsonWebKey = {
      e: candidate.e,
      kty: "RSA",
      n: candidate.n,
    };
    const key = await crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"]);
    keys.set(candidate.kid, key);
  }
  if (keys.size === 0) {
    throw new Error("Cloudflare Access certs response contained no usable RS256 keys.");
  }
  return keys;
}

/**
 * Isolate-local cache of Cloudflare Access signing keys. A cache miss for an unfamiliar `kid`
 * triggers one immediate refetch so a rotated key is accepted before the ordinary TTL expires;
 * repeated unknown IDs are throttled to avoid turning attacker-controlled JWT headers into an
 * unbounded cert-endpoint fetch loop.
 */
export class AccessCertCache {
  readonly #entries = new Map<string, CachedCerts>();
  readonly #fetcher: typeof fetch;
  readonly #now: () => number;
  readonly #refreshes = new Map<string, Promise<CachedCerts>>();

  constructor(options: AccessCertCacheOptions = {}) {
    this.#fetcher = options.fetcher ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  async #refresh(teamDomain: string, missRefresh: boolean): Promise<CachedCerts> {
    const pending = this.#refreshes.get(teamDomain);
    if (pending) return pending;

    const refresh = (async () => {
      const response = await this.#fetcher(
          `https://${teamDomain}/cdn-cgi/access/certs`,
          { headers: { accept: "application/json" } });
      if (!response.ok) {
        throw new Error(`Cloudflare Access cert fetch failed with status ${response.status}.`);
      }
      const previous = this.#entries.get(teamDomain);
      const refreshed: CachedCerts = {
        expiresAt: this.#now() + cacheTtlSeconds(response) * 1000,
        keys: await importCerts(await response.json()),
        lastMissRefreshAt: missRefresh ? this.#now() : previous?.lastMissRefreshAt,
      };
      this.#entries.set(teamDomain, refreshed);
      return refreshed;
    })();
    this.#refreshes.set(teamDomain, refresh);
    try {
      return await refresh;
    } finally {
      this.#refreshes.delete(teamDomain);
    }
  }

  /** Returns the key selected by `kid`, refreshing expired or rotated cert sets as needed. */
  async get(teamDomain: string, kid: string): Promise<CryptoKey | null> {
    const now = this.#now();
    let entry = this.#entries.get(teamDomain);
    let refreshed = false;
    if (!entry || now >= entry.expiresAt) {
      entry = await this.#refresh(teamDomain, false);
      refreshed = true;
    }

    const key = entry.keys.get(kid);
    if (key) return key;
    if (refreshed || (entry.lastMissRefreshAt !== undefined &&
        now - entry.lastMissRefreshAt < UNKNOWN_KID_REFRESH_INTERVAL_MS)) {
      return null;
    }

    entry = await this.#refresh(teamDomain, true);
    return entry.keys.get(kid) ?? null;
  }
}

const certCache = new AccessCertCache();

function decodeBase64Url(encoded: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("Invalid JWT encoding.");
  const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/") +
      "=".repeat((4 - encoded.length % 4) % 4);
  const decoded = atob(base64);
  return Uint8Array.from(decoded, character => character.charCodeAt(0));
}

function decodeJsonSegment(encoded: string): Record<string, unknown> {
  const decoded = JSON.parse(new TextDecoder().decode(decodeBase64Url(encoded))) as unknown;
  if (!isRecord(decoded)) throw new Error("JWT segment was not an object.");
  return decoded;
}

function validAudience(claim: unknown, expected: string): boolean {
  return claim === expected ||
      (Array.isArray(claim) && claim.some(value => value === expected));
}

type VerifyAccessOptions = {
  certCache?: AccessCertCache;
  now?: () => number;
};

/**
 * Verifies one Access assertion with WebCrypto and returns claims only after every signature and
 * claim check succeeds. Missing configuration, malformed tokens, unsupported algorithms, and
 * verification failures all return null so callers can fail closed without exposing internals.
 */
export async function verifyAccessJwtAssertion(
    assertion: string | null,
    env: AccessEnv,
    options: VerifyAccessOptions = {}): Promise<AccessJwtPayload | null> {
  let config: AccessConfig | null;
  try {
    config = configuredAccess(env);
  } catch (error) {
    logConfigurationErrorOnce(error);
    return null;
  }
  if (!config || !assertion) return null;

  try {
    const segments = assertion.split(".");
    if (segments.length !== 3) return null;
    const [protectedSegment, payloadSegment, signatureSegment] = segments;
    const protectedHeader = decodeJsonSegment(protectedSegment);
    if (protectedHeader.alg !== "RS256" || typeof protectedHeader.kid !== "string" ||
        protectedHeader.kid.length === 0) {
      return null;
    }

    const payload = decodeJsonSegment(payloadSegment) as AccessJwtPayload;
    const key = await (options.certCache ?? certCache).get(config.teamDomain, protectedHeader.kid);
    if (!key) return null;
    const verified = await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        decodeBase64Url(signatureSegment),
        new TextEncoder().encode(`${protectedSegment}.${payloadSegment}`));
    if (!verified) return null;

    // Read the clock after the potentially remote cert refresh and signature verification. A
    // token that expires while those complete must not be accepted using a stale pre-fetch time.
    const now = Math.floor((options.now ?? Date.now)() / 1000);
    if (payload.iss !== config.issuer || !validAudience(payload.aud, config.audience) ||
        typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || now >= payload.exp ||
        (payload.nbf !== undefined && (typeof payload.nbf !== "number" ||
          !Number.isFinite(payload.nbf) || now + NBF_CLOCK_SKEW_SECONDS < payload.nbf))) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

/** Returns verified Cloudflare Access claims from the assertion header, or null if untrusted. */
export function verifyCfAccessJwt(
    request: Request,
    env: AccessEnv,
    options?: VerifyAccessOptions): Promise<AccessJwtPayload | null> {
  return verifyAccessJwtAssertion(request.headers.get("cf-access-jwt-assertion"), env, options);
}

/** True when either Access setting is present; a partial pair is enabled but cannot verify. */
export function hasAccessConfiguration(env: AccessEnv): boolean {
  return Boolean(env.ACCESS_TEAM_DOMAIN?.trim() || env.ACCESS_APP_AUD?.trim());
}

/** Returns a privacy-preserving limiter key derived only from verified Access claims. */
export async function accessRateLimitKey(payload: AccessJwtPayload): Promise<string | null> {
  if (typeof payload.sub === "string" && payload.sub.length > 0) return `access-sub:${payload.sub}`;
  if (typeof payload.email !== "string" || payload.email.length === 0) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload.email));
  return `access-email:${new Uint8Array(digest).toHex()}`;
}
