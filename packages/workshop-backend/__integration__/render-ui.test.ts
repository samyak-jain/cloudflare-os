import {runInDurableObject} from "cloudflare:test";
import {exports} from "cloudflare:workers";
import {newWebSocketRpcSession, type RpcStub} from "capnweb";
import type {
  AuthenticatedApi,
  GenerativeUiResult,
  Overseer,
  PublicApi,
} from "@gadgets/workshop-shared/api";
import {describe, expect, it} from "vitest";
import {
  MAX_RENDER_UI_SOURCE_BYTES,
  parseRenderUIJsx,
  RENDER_UI_CATALOG_VERSION,
  validateRenderUINode,
} from "../src/render-ui";
import type {OverseerDurableObject} from "../src/overseer";

const PASSWORD_HASH = new Uint8Array([4, 8, 15, 16, 23, 42]);

async function connect(): Promise<RpcStub<PublicApi>> {
  let response = await exports.default.fetch(new Request("https://workshop.invalid/api", {
    headers: {Upgrade: "websocket"},
  }));
  expect(response.status).toBe(101);
  let socket = response.webSocket;
  if (!socket) throw new Error("Expected WebSocket upgrade.");
  socket.accept();
  return newWebSocketRpcSession<PublicApi>(socket);
}

async function createWorkspace(): Promise<{
  publicApi: RpcStub<PublicApi>;
  authenticated: RpcStub<AuthenticatedApi>;
  workspace: RpcStub<Overseer>;
}> {
  let publicApi = await connect();
  let username = `renderui${crypto.randomUUID().replaceAll("-", "")}`;
  let token = await publicApi.createAccount(username, username, PASSWORD_HASH);
  if (!token) throw new Error("Failed to create renderUI test account.");
  let authenticated = await publicApi.authenticate(token);
  let workspace = await authenticated.newGadget();
  return {publicApi, authenticated, workspace};
}

describe("literal-only renderUI parser", () => {
  it("parses JSX and returns only the validated wire tree", async () => {
    let result = await parseRenderUIJsx(
        `<Card title="Profile"><Stack gap="sm">
          <Heading level={2}>Account</Heading>
          <Input label="Name" value={bind("form.name")} />
          <Badge tone="success">admin</Badge>
          <Badge tone="success">active</Badge>
          <Button action="save">Save</Button>
        </Stack></Card>`,
        {form: {name: "Ada"}});

    expect(result.catalogVersion).toBe(RENDER_UI_CATALOG_VERSION);
    expect(result.stateDefaults).toEqual({form: {name: "Ada"}});
    expect(result.tree).toMatchObject({
      type: "Card",
      props: {title: "Profile"},
      children: [{
        type: "Stack",
        props: {gap: "sm"},
        children: [
          {type: "Heading", props: {level: 2}, children: ["Account"]},
          {type: "Input", props: {label: "Name", value: {$bind: "form.name"}}, children: []},
          {type: "Badge", props: {tone: "success"}, children: ["admin"]},
          {type: "Badge", props: {tone: "success"}, children: ["active"]},
          {type: "Button", props: {action: "save"}, children: ["Save"]},
        ],
      }],
    });
    expect(JSON.stringify(result)).not.toContain("function");
  });

  it("accepts the documented v1 prop spellings, aliases, and array bind paths", async () => {
    let result = await parseRenderUIJsx(`<Stack gap="lg">
      <Row align="BASELINE" justify="between" wrap={false}>
        <Card title="Deploy" description="Production">
          <Text label="Ready" tone="BRAND" size="lg" strong mono />
          <Input value={bind("form.url")} label="URL" description="Public endpoint" type="url" />
          <Select value={bind("form.region")} options={["iad", {value:"syd",label:"Sydney"}]} />
          <Checkbox checked={bind("flags.0")} description="Required">Confirm</Checkbox>
          <Slider value={bind("replicas.0")} min="1" max="10" step="1" valueLabel="replicas" />
        </Card>
      </Row>
      <Table columns={["name", {key:"count",label:"Count",align:"right"}]}
        data={[{name:"edge",count:3}]} />
      <ProgressBar value="30" max="100" valueLabel="30%" showValue />
      <Callout tone="success" title="Healthy" label="All checks passed" />
      <KeyValue entries={[{label:"Region",value:"iad"}]} />
      <Button action="deploy" label="Deploy" variant="PRIMARY" />
    </Stack>`, {
      form: {url: "https://example.com", region: "iad"},
      flags: [true],
      replicas: [3],
    });

    expect(result.tree.children).toHaveLength(6);
    expect(result.tree.children[0]).toMatchObject({
      type: "Row", props: {align: "baseline", justify: "between", wrap: false},
    });
    expect(result.tree.children[2]).toMatchObject({
      type: "ProgressBar", props: {value: 30, max: 100, showValue: true},
    });
  });

  it("rejects unknown components and lists the catalog", async () => {
    await expect(parseRenderUIJsx(`<Marquee>Hi</Marquee>`)).rejects.toThrow(
        /Unknown renderUI component.*Allowed components:.*Stack.*KeyValue/s);
  });

  it("rejects unknown and invalid props with allowed values", async () => {
    await expect(parseRenderUIJsx(`<Text color="purple">Hi</Text>`)).rejects.toThrow(
        /unknown prop.*Allowed props: label, tone, size, strong, mono/s);
    await expect(parseRenderUIJsx(`<Badge tone="sparkly">Hi</Badge>`)).rejects.toThrow(
        /must be one of/);
  });

  it.each(["onClick", "onMouseEnter", "dangerouslySetInnerHTML"])(
      "rejects handler-smuggling prop %s", async (prop) => {
        await expect(parseRenderUIJsx(
            `<Button action="save" ${prop}={() => 1}>Save</Button>`))
            .rejects.toThrow(/forbidden prop.*never allowed/s);
      });

  it("rejects oversized source before parsing", async () => {
    let source = `<Text>${"x".repeat(MAX_RENDER_UI_SOURCE_BYTES)}</Text>`;
    await expect(parseRenderUIJsx(source)).rejects.toThrow(/source limit/);
  });

  it("structurally rejects the model-authored oversized-tree generator", async () => {
    await expect(parseRenderUIJsx(
        `<Stack>{Array.from({length: 3000}, (_, i) =>
          <Text>{String(i).padEnd(100, "x")}</Text>)}</Stack>`))
        .rejects.toThrow(/CallExpression is not allowed/);
  });

  it("structurally rejects the TextEncoder-stubbing 19.8MB-tree exploit", async () => {
    await expect(parseRenderUIJsx(
        `(() => {
          globalThis.TextEncoder = class { encode() { return {byteLength: 0}; } };
          return <Stack>{Array.from({length: 280}, () =>
            <Text>{"y".repeat(1000)}</Text>)}</Stack>;
        })()`))
        .rejects.toThrow(/CallExpression is not allowed/);
  });

  it("authoritatively rejects hostile props and schemas in the parent", async () => {
    expect(() => validateRenderUINode({
      type: "Text",
      props: {dangerouslySetInnerHTML: "<img onerror=alert(1)>", onClick: "javascript:alert(1)"},
      children: ["hi"],
    })).toThrow(/forbidden prop.*dangerouslySetInnerHTML/);
    expect(() => validateRenderUINode({
      type: "Badge", props: {tone: "sparkly"}, children: [],
    })).toThrow(/must be one of/);

    await expect(parseRenderUIJsx(`(() => {
      const realKeys = Object.keys, realEntries = Object.entries;
      const evil = {
        dangerouslySetInnerHTML: {schema: {type: "scalar"}, optional: true},
        onClick: {schema: {type: "scalar"}, optional: true},
        label: {schema: {type: "string", maxLength: 4096}, optional: true},
      };
      Object.keys = value => value && value.dangerouslySetInnerHTML !== undefined
        ? [] : realKeys(value);
      Object.entries = value => value && value.tone && value.strong && value.mono
        ? realEntries(evil) : realEntries(value);
      return <Text label="visible" dangerouslySetInnerHTML="bad" onClick="bad">hi</Text>;
    })()`)).rejects.toThrow(/CallExpression is not allowed/);
  });

  it.each([
    `import("cloudflare:workers")`,
    `import.meta.url`,
    `require("node:fs")`,
    `import x from "somewhere"`,
  ])("rejects module access: %s", async (source) => {
    await expect(parseRenderUIJsx(source)).rejects.toThrow(/not allowed|expected exactly one/);
  });

  it("rejects dynamic import hidden in a template interpolation", async () => {
    let tick = String.fromCharCode(96);
    let source = "<Text label={" + tick +
      "${Object.keys(await import(\"cloudflare:workers\"))}" + tick + "} />";
    await expect(parseRenderUIJsx(source)).rejects.toThrow(/TemplateLiteral is not allowed/);
  });

  it.each([
    ["identifier", "<Text label={value} />"],
    ["member expression", "<Text label={globalThis.secret} />"],
    ["ordinary call", "<Text label={String(1)} />"],
    ["function", "<Text label={function () {}} />"],
    ["arrow", "<Text label={() => 1} />"],
    ["operator", "<Text label={1 + 2} />"],
    ["conditional", "<Text label={true ? 'a' : 'b'} />"],
    ["array spread", "<Select options={['a', ...items]} />"],
    ["object spread", "<Table rows={[{...row}]} />"],
    ["raw bind marker", "<Input value={{$bind:'name'}} />"],
    ["non-literal bind path", "<Input value={bind(path)} />"],
  ])("rejects non-literal syntax: %s", async (_name, source) => {
    await expect(parseRenderUIJsx(source)).rejects.toThrow(/not allowed|use bind|string literal/);
  });

  it("structurally rejects an emoji-adjacent import expression", async () => {
    await expect(parseRenderUIJsx(`(async () => {
      let padding = "🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉";
      let module = await import("cloudflare:workers");
      return <Text label={padding + String(module)} />;
    })()`)).rejects.toThrow(/CallExpression is not allowed/);
  });

  it("does not scan inert JSX text as executable code", async () => {
    let result = await parseRenderUIJsx(
        `<Text>You can import data, call require(x), or discuss while (true) here.</Text>`);
    expect(result.tree.children).toEqual([
      "You can import data, call require(x), or discuss while (true) here.",
    ]);
  });

  it("rejects unknown, mistyped, and non-bindable state paths", async () => {
    await expect(parseRenderUIJsx(
        `<Input value={bind("form.missing")} />`, {form: {name: "Ada"}}))
        .rejects.toThrow(/Unknown renderUI state path.*Allowed bind paths: form.missing/s);
    await expect(parseRenderUIJsx(
        `<Checkbox checked={bind("form.name")} />`, {form: {name: "Ada"}}))
        .rejects.toThrow(/state\.form\.name must be a boolean/);
    await expect(parseRenderUIJsx(
        `<Text tone={bind("tone")}>Hi</Text>`, {tone: "info"}))
        .rejects.toThrow(/Text\.tone cannot be bound/);
    await expect(parseRenderUIJsx(
        `<Input value={bind("form.name")} />`,
        {form: {name: "Ada"}, junk: "model-authored"}))
        .rejects.toThrow(/Unknown renderUI state path "junk"/);
  });

  it("structurally rejects a sync loop without running it", async () => {
    await expect(parseRenderUIJsx(
        `<Stack>{(() => { while (1) {} })()}</Stack>`))
        .rejects.toThrow(/CallExpression is not allowed/);
  });

  it("enforces depth, syntax, and component-node budgets while walking", async () => {
    let deep = "<Stack>".repeat(70) + "x" + "</Stack>".repeat(70);
    await expect(parseRenderUIJsx(deep)).rejects.toThrow(/maximum depth/);

    let wide = "<Stack>" + "<Row/>".repeat(5_001) + "</Stack>";
    await expect(parseRenderUIJsx(wide)).rejects.toThrow(/5000-node limit/);

    let syntaxHeavy = "<Table rows={[" + "0,".repeat(19_999) + "0]} />";
    await expect(parseRenderUIJsx(syntaxHeavy)).rejects.toThrow(/syntax budget/);
  });
});

describe("renderUI durable state and actions", () => {
  it("writes state, submits an action, and freezes the consumed tool result", async () => {
    let {publicApi, authenticated, workspace} = await createWorkspace();
    using _publicApi = publicApi;
    using _authenticated = authenticated;
    using _workspace = workspace;

    let chatId = await workspace.newChat("Show a profile form", null);
    let metadata = await workspace.getMetadata();
    let native = exports.OverseerDurableObject.get(
        exports.OverseerDurableObject.idFromString(metadata.id));
    let result = await runInDurableObject(native, async (instance) => {
      let impl = (instance as OverseerDurableObject & {
        impl: {
          renderUI(chatId: number, jsx: string, state: Record<string, unknown>):
              Promise<GenerativeUiResult>;
          addChatMessages(chatId: number, author: {type: "gadget"; id: string; name: string},
              messages: unknown[]): void;
        };
      }).impl;
      let output = await impl.renderUI(
          chatId,
          `<Stack><Input value={bind("form.name")} />` +
            `<Button action="save">Save</Button></Stack>`,
          {form: {name: "Ada"}});
      impl.addChatMessages(chatId, {type: "gadget", id: "test-gadget", name: "Test"}, [{
        type: "message",
        message: "",
        toolCalls: [{
          toolCallId: "render-call-1",
          toolName: "renderUI",
          input: {jsx: "test", state: {form: {name: "Ada"}}},
          output,
        }],
      }]);
      return output;
    });
    expect(result.stateDefaults).toEqual({form: {name: "Ada"}});

    await workspace.setGenerativeUiState(
        chatId, "render-call-1", {form: {name: "Grace"}});
    let before = await workspace.getChatHistory(chatId);
    let rendered = before.messages.find(message =>
      message.type === "message" && message.toolCalls?.some(call => call.toolName === "renderUI"));
    if (!rendered) throw new Error("Missing injected renderUI message.");
    expect(rendered.type === "message" && rendered.toolCalls?.[0]).toMatchObject({
      toolName: "renderUI",
      output: {stateDefaults: {form: {name: "Grace"}}},
    });

    let reset = await runInDurableObject(native, async (instance) => {
      let impl = (instance as OverseerDurableObject & {
        impl: {
          renderUI(chatId: number, jsx: string, state: Record<string, unknown>):
              Promise<GenerativeUiResult>;
        };
      }).impl;
      return impl.renderUI(
          chatId, `<Slider value={bind("form.name")} min={0} max={10} />`,
          {form: {name: 5}});
    });
    expect(reset.stateDefaults).toEqual({form: {name: 5}});

    await workspace.submitGenerativeUiAction(
        chatId, "render-call-1", "save", {form: {name: "Grace"}});
    let after = await workspace.getChatHistory(chatId);
    let frozen = after.messages.find(message => message.sequence === rendered.sequence);
    expect(frozen?.type === "message" && frozen.toolCalls?.[0]).toMatchObject({
      toolName: "renderUI",
      output: {consumed: true},
    });
    expect(after.messages.at(-1)).toMatchObject({
      author: {type: "gadget", id: "renderUI", name: "Interface submission"},
      type: "generativeUiAction",
      toolCallId: "render-call-1",
      action: "save",
      state: {form: {name: "Grace"}},
    });

    // A debounce that was already queued when submission started is ignored after consumption.
    await workspace.setGenerativeUiState(chatId, "render-call-1", {form: {name: "Late"}});
    let final = await workspace.getChatHistory(chatId);
    let stillFrozen = final.messages.find(message => message.sequence === rendered.sequence);
    expect(stillFrozen?.type === "message" && stillFrozen.toolCalls?.[0]).toMatchObject({
      output: {consumed: true, stateDefaults: {form: {name: "Grace"}}},
    });
  });
});
