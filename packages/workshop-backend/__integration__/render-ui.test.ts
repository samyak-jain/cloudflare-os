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
  MAX_RENDER_UI_DATA_BYTES,
  MAX_RENDER_UI_MEMBER_DEPTH,
  MAX_RENDER_UI_SOURCE_BYTES,
  MAX_RENDER_UI_STRING_LENGTH,
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

describe("bounded renderUI expression interpreter", () => {
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

  it("maps static data into JSX and prop arrays with scoped item/index parameters", async () => {
    let result = await parseRenderUIJsx(`<Card title={data.title || "People"}>
      <Stack>
        {data.rows.map((row, index) => row.active && <Row>
          <Text label={index === 0 ? \`First: \${row.name}\` : "Person: " + row.name} />
          <Badge tone={row.score >= 10 ? "success" : "warning"}>{row.tags[0]}</Badge>
        </Row>)}
      </Stack>
      <Table columns={["name", "score"]}
        rows={data.rows.map(row => ({name: row.name, score: row.score}))} />
      <Text label={\`Total: \${data.rows.length}\`} />
    </Card>`, {}, {
      title: "Roster",
      rows: [
        {name: "Ada", active: true, score: 12, tags: ["admin"]},
        {name: "Grace", active: false, score: 9, tags: ["member"]},
        {name: "Linus", active: true, score: 7, tags: ["member"]},
      ],
    });

    expect(result.tree).toMatchObject({
      type: "Card",
      props: {title: "Roster"},
      children: [{
        type: "Stack",
        children: [
          {type: "Row", children: [
            {type: "Text", props: {label: "First: Ada"}},
            {type: "Badge", props: {tone: "success"}, children: ["admin"]},
          ]},
          {type: "Row", children: [
            {type: "Text", props: {label: "Person: Linus"}},
            {type: "Badge", props: {tone: "warning"}, children: ["member"]},
          ]},
        ],
      }, {
        type: "Table",
        props: {rows: [{name: "Ada", score: 12}, {name: "Grace", score: 9},
          {name: "Linus", score: 7}]},
      }, {type: "Text", props: {label: "Total: 3"}}],
    });
  });

  it("supports nested maps over materialized arrays and lexical callback scope", async () => {
    let result = await parseRenderUIJsx(`<Stack>
      {data.groups.map(group => <Card title={group.name}>
        {group.items.map((item, index) => <Text>{\`\${group.name}.\${index}: \${item}\`}</Text>)}
      </Card>)}
    </Stack>`, {}, {groups: [{name: "A", items: ["x", "y"]}]});
    expect(result.tree.children).toMatchObject([{
      type: "Card", props: {title: "A"},
      children: [
        {type: "Text", children: ["A.0: x"]},
        {type: "Text", children: ["A.1: y"]},
      ],
    }]);
  });

  it("supports chained maps and every whitelisted comparison", async () => {
    let chained = await parseRenderUIJsx(
        `<Stack>{data.map(value => value).map((value, index) =>
          <Text label={index + ": " + value} />)}</Stack>`, {}, ["a", "b"]);
    expect(chained.tree.children).toMatchObject([
      {type: "Text", props: {label: "0: a"}},
      {type: "Text", props: {label: "1: b"}},
    ]);

    for (let [operator, left, right, expected] of [
      ["===", 1, 1, "yes"], ["!==", 1, 2, "yes"], ["<", 1, 2, "yes"],
      [">", 2, 1, "yes"], ["<=", "a", "a", "yes"], [">=", "b", "a", "yes"],
    ] as const) {
      let result = await parseRenderUIJsx(
          `<Text label={data.left ${operator} data.right ? "yes" : "no"} />`,
          {}, {left, right});
      expect(result.tree.props.label).toBe(expected);
    }

    let negative = await parseRenderUIJsx(
        `<Stack><Slider value={bind("value")} min={-10} max={10} />
          <Table rows={[{delta: -5}]} /></Stack>`, {value: 0});
    expect(negative.tree.children).toMatchObject([
      {type: "Slider", props: {min: -10}},
      {type: "Table", props: {rows: [{delta: -5}]}},
    ]);
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

  it("rejects non-whitelisted collection builders", async () => {
    await expect(parseRenderUIJsx(
        `<Stack>{Array.from({length: 3000}, (_, i) =>
          <Text>{String(i).padEnd(100, "x")}</Text>)}</Stack>`))
        .rejects.toThrow(/CallExpression is not allowed/);
  });

  it("rejects the old TextEncoder-stubbing exploit before any code can run", async () => {
    await expect(parseRenderUIJsx(
        `(() => {
          globalThis.TextEncoder = class { encode() { return {byteLength: 0}; } };
          return <Stack>{Array.from({length: 280}, () =>
            <Text>{"y".repeat(1000)}</Text>)}</Stack>;
        })()`))
        .rejects.toThrow(/CallExpression is not allowed/);
  });

  it("rejects a .map attempt to build the old 19.8MB tree at the emitted-node cap", async () => {
    let items = Array.from({length: 5_000}, () => 0);
    await expect(parseRenderUIJsx(
        `<Stack>{data.items.map(item => <Text>{item}</Text>)}</Stack>`,
        {}, {items})).rejects.toThrow(/5000-node limit/);
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
      "${import(\"cloudflare:workers\")}" + tick + "} />";
    await expect(parseRenderUIJsx(source)).rejects.toThrow(/ImportExpression is not allowed/);
  });

  it("validates unselected conditional branches before evaluation", async () => {
    await expect(parseRenderUIJsx(
        `<Text label={false ? import("cloudflare:workers") : "safe"} />`))
        .rejects.toThrow(/ImportExpression is not allowed/);
  });

  it.each([
    ["unknown global", "<Text label={globalThis.secret} />"],
    ["ordinary call", "<Text label={String(1)} />"],
    ["function", "<Text label={function () {}} />"],
    ["standalone arrow", "<Text label={() => 1} />"],
    ["block-bodied map arrow", "<Stack>{data.map(item => { return <Text/>; })}</Stack>"],
    ["extra map argument", "<Stack>{data.map(item => <Text/>, data)}</Stack>"],
    ["spread map argument", "<Stack>{data.items.map(...data.callbacks)}</Stack>"],
    ["member call", "<Text label={data.name.toString()} />"],
    ["new", "<Text label={new Date()} />"],
    ["assignment", "<Text label={(data.name = 'x')} />"],
    ["update", "<Text label={data.count++} />"],
    ["sequence", "<Text label={(data.a, data.b)} />"],
    ["this", "<Text label={this.name} />"],
    ["tagged template", "<Text label={data.tag`x`} />"],
    ["array spread", "<Select options={['a', ...data.items]} />"],
    ["object spread", "<Table rows={[{...data.row}]} />"],
    ["raw bind marker", "<Input value={{$bind:'name'}} />"],
    ["non-literal bind path", "<Input value={bind(path)} />"],
  ])("rejects non-whitelisted syntax: %s", async (_name, source) => {
    await expect(parseRenderUIJsx(source, {}, {name: "n", count: 1, a: 1, b: 2,
      items: [], row: {}, tag: "x"})).rejects.toThrow(
          /not allowed|requires|must be|Unknown identifier|bind\(\)|raw \$bind/);
  });

  it("rejects prototype keys in object literals and every member-access spelling", async () => {
    await expect(parseRenderUIJsx(
        `<Table rows={[{__proto__: {polluted: true}}]} />`))
        .rejects.toThrow(/object key "__proto__" is forbidden/);
    await expect(parseRenderUIJsx(`<Text label={data["__proto__"]} />`, {}, {}))
        .rejects.toThrow(/member key "__proto__" is forbidden/);
    await expect(parseRenderUIJsx(`<Text label={data.constructor} />`, {}, {}))
        .rejects.toThrow(/member key "constructor" is forbidden/);
    await expect(parseRenderUIJsx(`<Text label={data[data.key]} />`, {}, {key: "name"}))
        .rejects.toThrow(/computed member access requires a literal/);
    await expect(parseRenderUIJsx(
        `<Table rows={[{"prototype": "bad"}]} />`))
        .rejects.toThrow(/object key "prototype" is forbidden/);
  });

  it("does not expose bound state as an iterable expression scope", async () => {
    await expect(parseRenderUIJsx(
        `<Stack>{state.items.map(item => <Text>{item}</Text>)}</Stack>`,
        {items: ["a"]} as unknown as Record<string, unknown>))
        .rejects.toThrow(/Unknown identifier "state"/);
    await expect(parseRenderUIJsx(
        `<Stack>{bind("items").map(item => <Text>{item}</Text>)}</Stack>`,
        {items: ["a"]} as unknown as Record<string, unknown>))
        .rejects.toThrow(/bind\(\) is allowed only as a bindable prop/);
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

  it("enforces source-data, string, member, syntax, map, and component budgets", async () => {
    await expect(parseRenderUIJsx(`<Text>ok</Text>`, {},
        "x".repeat(MAX_RENDER_UI_DATA_BYTES))).rejects.toThrow(/data exceeds/);
    await expect(parseRenderUIJsx(`<Text label={data + "x"} />`, {},
        "x".repeat(MAX_RENDER_UI_STRING_LENGTH))).rejects.toThrow(/string exceeds/);

    let memberChain = "data" + ".next".repeat(MAX_RENDER_UI_MEMBER_DEPTH + 1);
    await expect(parseRenderUIJsx(`<Text label={${memberChain}} />`, {}, {}))
        .rejects.toThrow(/member access exceeds/);

    await expect(parseRenderUIJsx(
        `<Stack>{data.map(item => <Divider />)}</Stack>`, {},
        Array.from({length: 10_001}, () => null)))
        .rejects.toThrow(/10000-iteration total limit/);

    let expressionData = Array.from({length: 10_000}, () => 0);
    await expect(parseRenderUIJsx(
        `<Table rows={data.map(item => ({a:item,b:item,c:item,d:item,e:item,
          f:item,g:item,h:item,i:item,j:item}))} />`, {}, expressionData))
        .rejects.toThrow(/100000-evaluation expression budget/);

    let deep = "<Stack>".repeat(70) + "x" + "</Stack>".repeat(70);
    await expect(parseRenderUIJsx(deep)).rejects.toThrow(/maximum depth/);

    let wide = "<Stack>" + "<Row/>".repeat(5_001) + "</Stack>";
    await expect(parseRenderUIJsx(wide)).rejects.toThrow(/5000-node limit/);

    let syntaxHeavy = "<Table rows={[" + "0,".repeat(19_999) + "0]} />";
    await expect(parseRenderUIJsx(syntaxHeavy)).rejects.toThrow(/syntax budget/);
  });

  it("terminates a large nested map at the emitted-node cap", async () => {
    let groups = Array.from({length: 80}, () => ({items: Array.from({length: 80}, () => 0)}));
    await expect(parseRenderUIJsx(
        `<Stack>{data.groups.map(group =>
          group.items.map(item => <Divider />))}</Stack>`, {}, {groups}))
        .rejects.toThrow(/5000-node limit/);
  });

  it("rejects a nested map before its iteration product can exceed the cap", async () => {
    let groups = Array.from({length: 101}, () => ({items: Array.from({length: 100}, () => 0)}));
    await expect(parseRenderUIJsx(
        `<Table rows={data.groups.map(group =>
          group.items.map(item => ({value: item})))} />`, {}, {groups}))
        .rejects.toThrow(/10000-iteration product limit/);
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
