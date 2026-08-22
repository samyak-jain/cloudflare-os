#!/usr/bin/env node

import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

const authPath = process.argv[2];
if (!authPath) {
  console.error("usage: node scripts/verify-chatgpt-subscription.mjs <codex-auth.json>");
  process.exit(2);
}

const auth = JSON.parse(await readFile(authPath, "utf8"));
const refreshToken = auth.tokens?.refresh_token;
const accountId = auth.tokens?.account_id;
if (typeof refreshToken !== "string" || typeof accountId !== "string") {
  throw new Error("auth file does not contain tokens.refresh_token and tokens.account_id");
}

const tokenResponse = await fetch(TOKEN_URL, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  }),
});
if (!tokenResponse.ok) {
  throw new Error(`subscription token refresh failed (${tokenResponse.status})`);
}
const refreshed = await tokenResponse.json();
if (typeof refreshed.access_token !== "string") {
  throw new Error("subscription token refresh returned no access token");
}

// Codex refresh tokens rotate. Persist the replacement before using the access token so running
// this verifier cannot strand the CLI with the now-consumed token. Preserve fields Codex owns.
auth.tokens.access_token = refreshed.access_token;
if (typeof refreshed.refresh_token === "string") auth.tokens.refresh_token = refreshed.refresh_token;
if (typeof refreshed.id_token === "string") auth.tokens.id_token = refreshed.id_token;
auth.last_refresh = new Date().toISOString();
const temporaryPath = join(dirname(authPath), `.auth.json.verify-${process.pid}`);
await writeFile(temporaryPath, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
await rename(temporaryPath, authPath);

const response = await fetch(RESPONSES_URL, {
  method: "POST",
  headers: {
    authorization: `Bearer ${refreshed.access_token}`,
    "chatgpt-account-id": accountId,
    originator: "codex_cli_rs",
    "openai-beta": "responses=experimental",
    accept: "text/event-stream",
    "content-type": "application/json",
  },
  body: JSON.stringify({
    model: "gpt-5.6-luna",
    store: false,
    stream: true,
    instructions: "Follow the user's request exactly and answer concisely.",
    input: [{ role: "user", content: [{ type: "input_text", text: "Respond with OK" }] }],
    text: { verbosity: "low" },
    include: ["reasoning.encrypted_content"],
    tool_choice: "auto",
    parallel_tool_calls: true,
  }),
});
if (!response.ok) throw new Error(`luna response failed (${response.status})`);

let output = "";
for (const block of (await response.text()).split("\n\n")) {
  const data = block.split("\n").find(line => line.startsWith("data: "))?.slice(6);
  if (!data || data === "[DONE]") continue;
  const event = JSON.parse(data);
  if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
    output += event.delta;
  }
}
if (output.trim() !== "OK") throw new Error("luna returned an unexpected response");
console.log("OK: refreshed subscription auth and received OK from gpt-5.6-luna");
