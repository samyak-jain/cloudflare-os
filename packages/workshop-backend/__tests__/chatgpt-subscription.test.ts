import { describe, expect, it } from "vitest";
import { sanitizeGeneratedTitle } from "../src/chatgpt-subscription.js";
import { isSubscriptionNamingEnabled } from "../src/deployment-config.js";

describe("subscription naming configuration", () => {
  it("requires the opt-in and both subscription values", () => {
    const complete = {
      FEATURE_CHATGPT_AUTO_NAMING: "true",
      CHATGPT_REFRESH_TOKEN: "refresh",
      CHATGPT_ACCOUNT_ID: "account",
    } as Cloudflare.Env;
    expect(isSubscriptionNamingEnabled(complete)).toBe(true);
    expect(isSubscriptionNamingEnabled({...complete, CHATGPT_REFRESH_TOKEN: undefined}))
      .toBe(false);
    expect(isSubscriptionNamingEnabled({...complete, FEATURE_CHATGPT_AUTO_NAMING: undefined}))
      .toBe(false);
  });
});

describe("generated title sanitization", () => {
  it("strips multiline decoration, emoji, punctuation, and excess words", () => {
    expect(sanitizeGeneratedTitle('  “Build a Tiny Weather Dashboard Today Please” 😎!!!\n'))
      .toBe("Build a Tiny Weather Dashboard Today");
  });

  it("rejects an empty decorated response", () => {
    expect(sanitizeGeneratedTitle("😎\n")).toBeUndefined();
    expect(sanitizeGeneratedTitle("Too short")).toBeUndefined();
  });
});
