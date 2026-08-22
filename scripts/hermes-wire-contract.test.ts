import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

import { WORKSHOP_AGENT_TOOL_DEFINITIONS } from "../packages/workshop-backend/src/agent-tool-definitions.ts";
import { makeHermesTurnRequest } from "../packages/workshop-backend/src/hermes-protocol.ts";

function findWorkshopPlatform(): string | undefined {
  let worktrees = dirname(dirname(resolve(".")));
  if (!existsSync(worktrees)) return undefined;
  for (let slot of readdirSync(worktrees)) {
    let candidate = join(worktrees, slot, "workshop-platform");
    if (existsSync(join(candidate, "plugins/platforms/workshop/protocol.py"))) return candidate;
  }
  return undefined;
}

describe("Hermes Workshop wire contract", () => {
  it("is accepted by the actual WorkshopTurnRequest.from_dict parser", () => {
    let platform = findWorkshopPlatform();
    if (!platform) {
      if (process.env.HERMES_CONTRACT_SKIP === "1") return;
      throw new Error(
        "workshop-platform worktree is required; set HERMES_CONTRACT_SKIP=1 only for an " +
        "explicit local opt-out.",
      );
    }
    let tools = Object.values(WORKSHOP_AGENT_TOOL_DEFINITIONS).map((definition) => ({
      ...definition,
      label: definition.name,
      execute: async () => ({ content: [{ type: "text" as const, text: "unused" }], details: {} }),
    })) as Parameters<typeof makeHermesTurnRequest>[0]["tools"];
    let request = makeHermesTurnRequest({
      clientTurnId: "contract-turn-1",
      workspaceId: "workspace-1",
      chatId: "1",
      inputText: "contract test",
      tools,
    });
    let python = spawnSync(
      "python3",
      [
        "-c",
        [
          "import json, sys",
          "from plugins.platforms.workshop.protocol import WorkshopTurnRequest",
          "request = WorkshopTurnRequest.from_dict(json.load(sys.stdin))",
          "print(json.dumps({'tools': len(request.tools), 'digest': request.catalog_version}))",
        ].join("; "),
      ],
      {
        cwd: platform,
        input: JSON.stringify(request),
        encoding: "utf8",
      },
    );
    assert.equal(python.status, 0, python.stderr);
    let parsed = JSON.parse(python.stdout) as { tools: number; digest: string };
    assert.equal(parsed.tools, 13);
    assert.match(parsed.digest, /^[0-9a-f]{64}$/);
  });
});
