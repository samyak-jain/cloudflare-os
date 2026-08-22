/**
 * Development-only QA harness for the avatar runtime.
 *
 * Served by `vite dev` at `/avatar-harness.html`. It is **not** part of the app bundle: vite's
 * default build input is `index.html` alone, so this entry and everything it pulls in are absent
 * from `dist/`.
 *
 * Its job is to make every avatar state reachable without a model, a backend, or a real turn --
 * and to reach them *through the real mapping layer*, by feeding synthetic `AiChatStreamEvent`s
 * into a real `AvatarController`. A harness that force-set the state would screenshot poses the
 * event stream might never actually produce.
 *
 * `window.__avatar` is the Playwright-facing API; see `../README.md` for how it is driven.
 */

import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AiChatStreamEvent } from "@gadgets/workshop-shared/api";
import { AvatarController } from "../controller";
import ChatAvatar from "../ChatAvatar";
import { describeAvatarState, type AvatarState, type AvatarWorkKind } from "../state";

const CHAT_ID = 1;

/** The tool whose `toolCallStarted` produces each working kind. */
const TOOL_FOR_KIND: Record<AvatarWorkKind, string> = {
  read: "readFile",
  write: "editFile",
  browse: "webFetch",
  execute: "executeCode",
};

type StateButton = { label: string; drive: (c: AvatarController) => void };

/**
 * Every state, reached only through inputs the real chat can produce.
 *
 * Each entry resets first, so a screenshot of one state never carries a latch from the last.
 */
const BUTTONS: StateButton[] = [
  { label: "idle", drive: () => {} },
  {
    label: "listening",
    drive: (c) => c.handleMessage(CHAT_ID, { type: "message", author: { type: "user" } }),
  },
  {
    label: "thinking",
    drive: (c) => {
      c.setAgentActive(CHAT_ID, true);
      c.handleStream(CHAT_ID, { type: "reasoningDelta", delta: "..." });
    },
  },
  {
    label: "talking",
    drive: (c) => {
      c.setAgentActive(CHAT_ID, true);
      c.handleStream(CHAT_ID, { type: "textDelta", delta: "..." });
    },
  },
  ...(["read", "write", "browse", "execute"] as const).map((work) => ({
    label: `working:${work}`,
    drive: (c: AvatarController) => {
      c.setAgentActive(CHAT_ID, true);
      c.handleStream(CHAT_ID, {
        type: "toolCallStarted",
        toolCallId: `qa-${work}`,
        toolName: TOOL_FOR_KIND[work] as never,
      });
    },
  })),
  {
    label: "error",
    drive: (c) => {
      c.setAgentActive(CHAT_ID, true);
      c.handleStream(CHAT_ID, { type: "textDelta", delta: "..." });
      c.handleMessage(CHAT_ID, { type: "error" });
      c.setAgentActive(CHAT_ID, false);
    },
  },
  {
    label: "done",
    drive: (c) => {
      c.setAgentActive(CHAT_ID, true);
      c.handleStream(CHAT_ID, { type: "textDelta", delta: "..." });
      c.setAgentActive(CHAT_ID, false);
    },
  },
  { label: "paused", drive: (c) => c.setConnectionLost(true) },
];

/**
 * A scripted turn: the event sequence a real tool-using turn produces, at realistic spacing.
 *
 * Used to watch the transitions rather than the endpoints -- the endpoints are what the buttons
 * above are for.
 */
const SCRIPT: { at: number; run: (c: AvatarController) => void; note: string }[] = [
  { at: 0, note: "user sends", run: (c) => c.handleMessage(CHAT_ID, { type: "message", author: { type: "user" } }) },
  { at: 400, note: "agent starts", run: (c) => c.setAgentActive(CHAT_ID, true) },
  ...burst(900, 1800, 120, { type: "reasoningDelta", delta: "hm " }, "reasoning"),
  ...burst(2000, 3600, 60, { type: "textDelta", delta: "word " }, "narration"),
  { at: 3700, note: "readFile starts", run: (c) => c.handleStream(CHAT_ID, { type: "toolCallStarted", toolCallId: "s1", toolName: "readFile" as never }) },
  { at: 5200, note: "readFile input done", run: (c) => c.handleStream(CHAT_ID, { type: "toolCallFinished", toolCallId: "s1" }) },
  { at: 6400, note: "editFile starts", run: (c) => c.handleStream(CHAT_ID, { type: "toolCallStarted", toolCallId: "s2", toolName: "editFile" as never }) },
  ...burst(6600, 8200, 100, { type: "editPreviewDelta", toolCallId: "s2", delta: "x" }, "edit preview"),
  { at: 8400, note: "executeCode starts", run: (c) => c.handleStream(CHAT_ID, { type: "toolCallStarted", toolCallId: "s3", toolName: "executeCode" as never }) },
  ...burst(9600, 11200, 60, { type: "textDelta", delta: "word " }, "wrap-up narration"),
  { at: 11400, note: "final message", run: (c) => c.handleMessage(CHAT_ID, { type: "message", author: { type: "agent" } }) },
  { at: 11500, note: "turn ends", run: (c) => c.setAgentActive(CHAT_ID, false) },
];

function burst(from: number, to: number, every: number, event: AiChatStreamEvent, note: string) {
  const out: { at: number; run: (c: AvatarController) => void; note: string }[] = [];
  for (let at = from; at <= to; at += every) {
    out.push({ at, note, run: (c) => c.handleStream(CHAT_ID, event) });
  }
  return out;
}

function Harness() {
  const controller = useMemo(() => new AvatarController(), []);
  const [state, setState] = useState<AvatarState>({ kind: "idle" });
  const [note, setNote] = useState("");
  const [dark, setDark] = useState(false);

  useEffect(() => {
    controller.setChat(CHAT_ID);
    return controller.subscribe(() => setState(controller.getSnapshot().state));
  }, [controller]);

  const go = (button: StateButton) => {
    controller.setConnectionLost(false);
    controller.setChat(null);
    controller.setChat(CHAT_ID);
    button.drive(controller);
    setNote(button.label);
  };

  const runScript = () => {
    controller.setConnectionLost(false);
    controller.setChat(null);
    controller.setChat(CHAT_ID);
    for (const step of SCRIPT) {
      setTimeout(() => {
        step.run(controller);
        setNote(`${step.at} ms — ${step.note}`);
      }, step.at);
    }
  };

  // The Playwright-facing surface. Declared here so it closes over the live controller.
  useEffect(() => {
    (window as unknown as { __avatar: unknown }).__avatar = {
      go: (label: string) => {
        const button = BUTTONS.find((b) => b.label === label);
        if (button === undefined) throw new Error(`no such state button: ${label}`);
        go(button);
      },
      script: runScript,
      state: () => controller.getSnapshot().state,
      labels: () => BUTTONS.map((b) => b.label),
    };
  });

  const bg = dark ? "#1b1d2b" : "#faf9fb";
  const fg = dark ? "#e8e4f2" : "#2b2733";

  return (
    <div style={{ minHeight: "100vh", background: bg, color: fg, font: "13px/1.5 ui-sans-serif, system-ui", padding: 24 }}>
      <header style={{ display: "flex", alignItems: "baseline", gap: 16, marginBottom: 20 }}>
        <strong style={{ fontSize: 16 }}>Lena avatar — QA harness</strong>
        <span style={{ opacity: 0.65 }}>dev only; not in the app bundle</span>
        <label style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={dark} onChange={(e) => setDark(e.target.checked)} />
          dark backdrop
        </label>
      </header>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 20 }}>
        {BUTTONS.map((button) => (
          <button
            key={button.label}
            type="button"
            data-state-button={button.label}
            onClick={() => go(button)}
            style={btn(dark, note === button.label)}
          >
            {button.label}
          </button>
        ))}
        <button type="button" data-state-button="script" onClick={runScript} style={btn(dark, false)}>
          ▶ scripted turn
        </button>
      </div>

      <div id="avatar-stage" style={{ display: "flex", alignItems: "flex-end", gap: 32, marginBottom: 20 }}>
        {[140, 96, 64].map((size) => (
          <figure key={size} style={{ margin: 0, textAlign: "center" }}>
            <ChatAvatar controller={controller} size={size} />
            <figcaption style={{ marginTop: 8, opacity: 0.6, fontSize: 11 }}>{size}px</figcaption>
          </figure>
        ))}
      </div>

      <p data-avatar-readout style={{ margin: 0, fontFamily: "ui-monospace, monospace" }}>
        state: <strong>{describeAvatarState(state)}</strong>
        {note !== "" && <span style={{ opacity: 0.6 }}>{"  ·  "}{note}</span>}
      </p>
    </div>
  );
}

function btn(dark: boolean, active: boolean): React.CSSProperties {
  return {
    padding: "6px 12px",
    borderRadius: 8,
    cursor: "pointer",
    border: `1px solid ${dark ? "#3b3c58" : "#dcd7e6"}`,
    background: active ? (dark ? "#3b3c58" : "#e9e3f5") : "transparent",
    color: "inherit",
    font: "inherit",
  };
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
