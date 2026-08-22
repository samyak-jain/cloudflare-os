import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  normalizeAccessEmail,
  normalizeUsername,
  UserDurableObject,
} from "../src/user.js";

const users = (env as unknown as {
  TEST_USER: DurableObjectNamespace<UserDurableObject>;
}).TEST_USER;

describe("Cloudflare Access account mapping", () => {
  it("auto-provisions an email-keyed passwordless account without creating a session", async () => {
    const email = "new-access-user@example.com";
    const id = users.idFromName(email);

    await runInDurableObject(users.get(id), async (user: UserDurableObject) => {
      await expect(user.provisionViaAccess(email)).resolves.toBe(true);
      await expect(user.whoami()).resolves.toEqual({
        type: "user",
        id: email,
        name: "new-access-user",
      });
      await expect(user.hasPasswordLogin()).resolves.toBe(false);
      await expect(user.authenticate(new Uint8Array(32).toBase64())).rejects.toThrow();

      await expect(user.provisionViaAccess(email)).resolves.toBe(false);
    });
  });

  it("maps a verified email to an existing account without replacing its profile", async () => {
    const email = "existing-access-user@example.com";
    const id = users.idFromName(email);

    await runInDurableObject(users.get(id), async (user: UserDurableObject) => {
      await user.provisionViaAccess(email);
      await user.setOwnDisplayName("Existing Operator");

      await expect(user.provisionViaAccess(email)).resolves.toBe(false);
      await expect(user.whoami()).resolves.toMatchObject({
        id: email,
        name: "Existing Operator",
      });
      await expect(user.hasPasswordLogin()).resolves.toBe(false);
    });
  });

  it("lowercases and NFC-normalizes email keys into a namespace disjoint from usernames", async () => {
    const rawEmail = "Ope\u0301rator@Example.COM";
    const email = "opérator@example.com";
    expect(normalizeAccessEmail(rawEmail)).toBe(email);
    expect(() => normalizeUsername(email)).toThrow();
    expect(() => normalizeAccessEmail("operator")).toThrow();

    const id = users.idFromName(email);
    await runInDurableObject(users.get(id), async (user: UserDurableObject) => {
      await user.provisionViaAccess(rawEmail);
      await expect(user.whoami()).resolves.toMatchObject({ id: email, name: "opérator" });
    });
  });
});
