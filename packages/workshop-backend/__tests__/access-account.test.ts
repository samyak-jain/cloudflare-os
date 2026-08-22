import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { UserDurableObject } from "../src/user.js";

const users = (env as unknown as {
  TEST_USER: DurableObjectNamespace<UserDurableObject>;
}).TEST_USER;

describe("Cloudflare Access account mapping", () => {
  it("auto-provisions an email-keyed passwordless account and issues a normal session", async () => {
    const email = "new-access-user@example.com";
    const id = users.idFromName(email);

    await runInDurableObject(users.get(id), async (user: UserDurableObject) => {
      const first = await user.loginOrCreateViaAccess(email);
      expect(first.accountCreated).toBe(true);
      await expect(user.authenticate(first.secret)).resolves.toBeUndefined();
      await expect(user.whoami()).resolves.toEqual({
        type: "user",
        id: email,
        name: "new-access-user",
      });
      await expect(user.hasPasswordLogin()).resolves.toBe(false);

      const second = await user.loginOrCreateViaAccess(email);
      expect(second.accountCreated).toBe(false);
      expect(second.secret).not.toBe(first.secret);
      await expect(user.authenticate(second.secret)).resolves.toBeUndefined();
    });
  });

  it("maps a verified email to an existing account without replacing its profile", async () => {
    const email = "existing-access-user@example.com";
    const id = users.idFromName(email);

    await runInDurableObject(users.get(id), async (user: UserDurableObject) => {
      const passwordHash = crypto.getRandomValues(new Uint8Array(32));
      await expect(user.createAccount(email, "Existing Operator", passwordHash))
        .resolves.not.toBeNull();

      const session = await user.loginOrCreateViaAccess(email);
      expect(session.accountCreated).toBe(false);
      await expect(user.authenticate(session.secret)).resolves.toBeUndefined();
      await expect(user.whoami()).resolves.toMatchObject({
        id: email,
        name: "Existing Operator",
      });
      await expect(user.hasPasswordLogin()).resolves.toBe(true);
    });
  });
});
