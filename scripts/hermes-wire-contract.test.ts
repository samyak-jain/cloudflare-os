import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { createServer } from "vite";
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

function workshopPython(platform: string): string {
  let virtualEnvironment = join(platform, ".venv/bin/python");
  return existsSync(virtualEnvironment) ? virtualEnvironment : "python3";
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
      workshopPython(platform),
      [
        "-c",
        [
          "import json, sys",
          "from plugins.platforms.workshop.protocol import WorkshopTurnRequest",
          "request = WorkshopTurnRequest.from_dict(json.load(sys.stdin))",
          "print(json.dumps({'tools': len(request.tools), 'digest': request.catalog_version}))",
        ].join("\n"),
      ],
      {
        cwd: platform,
        input: JSON.stringify(request),
        encoding: "utf8",
      },
    );
    assert.equal(python.status, 0, python.stderr);
    let parsed = JSON.parse(python.stdout) as { tools: number; digest: string };
    assert.equal(parsed.tools, 14);
    assert.match(parsed.digest, /^[0-9a-f]{64}$/);
  });

  it("consumes real Hermes event envelopes, tool_activity, and an additive future event", async () => {
    let platform = findWorkshopPlatform();
    if (!platform) {
      if (process.env.HERMES_CONTRACT_SKIP === "1") return;
      throw new Error(
        "workshop-platform worktree is required; set HERMES_CONTRACT_SKIP=1 only for an " +
        "explicit local opt-out.",
      );
    }
    let python = spawnSync(
      workshopPython(platform),
      [
        "-c",
        [
          "import json",
          "from plugins.platforms.workshop.protocol import WorkshopEvent",
          "payloads = [",
          "('turn.started', {'catalog_version': 'catalog'}),",
          "('message.start', {'role': 'assistant'}),",
          "('text.delta', {'delta': 'hello '}),",
          "('thinking.delta', {'delta': 'thinking'}),",
          "('tool_activity', {'name': 'memory', 'status': 'started'}),",
          "('tool_activity', {'name': 'memory', 'status': 'completed'}),",
          "('tool_activity', {'name': 'soul', 'status': 'error'}),",
          "('tool_call.start', {'call_id': 'call-1', 'name': 'readFile'}),",
          "('tool_call.arguments.delta', {'call_id': 'call-1', 'delta': '{\\\"workpiece\\\":\\\"app\\\",\\\"filename\\\":\\\"a.txt\\\"}'}),",
          "('tool_call.end', {'call_id': 'call-1', 'arguments': {'workpiece': 'app', 'filename': 'a.txt'}}),",
          "('usage', {'input_tokens': 3, 'output_tokens': 2}),",
          "('error', {'code': 'display_only', 'message': 'non-terminal fixture', 'retryable': False}),",
          "('turn.end', {'status': 'completed', 'stop_reason': 'stop', 'final_text': 'hello'})]",
          "events = [WorkshopEvent.create(turn_id='turn-1', session_id='session-1', seq=i, event=e, payload=p, timestamp=1).to_wire() for i, (e, p) in enumerate(payloads, 1)]",
          "future = {'protocol_version': 1, 'turn_id': 'turn-1', 'session_id': 'session-1', 'seq': 13, 'event': 'future.progress', 'timestamp': 1, 'opaque': {'not': 'for the driver'}}",
          "events.insert(-1, future)",
          "events[-1]['seq'] = 14",
          "print(json.dumps(events))",
        ].join("\n"),
      ],
      { cwd: platform, encoding: "utf8" },
    );
    assert.equal(python.status, 0, python.stderr);
    let events = JSON.parse(python.stdout) as Record<string, unknown>[];
    let activity = events.find(event => event.event === "tool_activity");
    assert.deepEqual(Object.keys(activity!).toSorted(), [
      "event", "name", "protocol_version", "seq", "session_id", "status", "timestamp", "turn_id",
    ]);

    let activityEvents: { name: string; status: string }[] = [];
    let agentEvents: { type: string }[] = [];
    let claims = 0;
    let executions = 0;
    let toolResults = 0;
    let hooks = {
      emit: (event: { type: string }) => agentEvents.push(event),
      emitToolActivity: (name: string, status: string) => activityEvents.push({ name, status }),
      claimToolCall: async () => {
        claims++;
        return { execute: true };
      },
      resolveToolCall: () => {},
      interruptToolCall: () => {},
      waitUntil: () => {},
      onTurnStarted: () => {},
      pauseReasonAfterMessage: () => undefined,
      pauseReasonAfterTool: () => undefined,
    };
    let fetcher: typeof fetch = async (input) => {
      let url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname.includes("/tool-results/")) {
        toolResults++;
        return Response.json({ ok: true });
      }
      let body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    };
    let vite = await createServer({
      configFile: false,
      root: resolve("."),
      server: { middlewareMode: true },
      appType: "custom",
      optimizeDeps: { noDiscovery: true },
    });
    try {
      let driver = await vite.ssrLoadModule("/packages/workshop-backend/src/hermes-driver.ts") as {
        runHermesTurn(options: Record<string, unknown>): Promise<void>;
      };
      await driver.runHermesTurn({
        baseUrl: "https://hermes.test",
        apiKey: "a".repeat(64),
        workspaceId: "workspace-1",
        chatId: "1",
        clientTurnId: "event-contract-turn",
        inputText: "contract test",
        tools: [{
          ...WORKSHOP_AGENT_TOOL_DEFINITIONS.readFile,
          label: "Read file",
          execute: async () => {
            executions++;
            return { content: [{ type: "text", text: "contents" }], details: {} };
          },
        }],
        signal: new AbortController().signal,
        hooks,
        fetch: fetcher,
      });
    } finally {
      await vite.close();
    }

    assert.deepEqual(activityEvents, [
      { name: "memory", status: "started" },
      { name: "memory", status: "completed" },
      { name: "soul", status: "error" },
    ]);
    assert.equal(claims, 1);
    assert.equal(executions, 1);
    assert.equal(toolResults, 1);
    assert.ok(agentEvents.some(event => event.type === "turn_end"));
  });
});
