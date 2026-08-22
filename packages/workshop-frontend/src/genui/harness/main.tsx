/**
 * Development-only QA harness for the generative-UI renderer.
 *
 * Served by `vite dev` at `/genui-harness.html`, and **not** part of the app bundle: vite's default
 * build input is `index.html` alone, so this entry and everything it pulls in are absent from
 * `dist/`.
 *
 * Its job is to put every card state next to the transcript chrome it has to live beside, without
 * a backend or a model. The fake message rows around each card are copied from `ChatInterface`'s
 * own markup on purpose -- a card judged on a blank page looks fine and then turns out to be two
 * pixels too loud in the actual conversation.
 *
 * `window.__genui` is the Playwright-facing API; see `../README.md`.
 */

import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { applyThemeMode, type ResolvedThemeMode } from "../../theme";
import { ComposingUiCard, GenerativeUiCard } from "../GenerativeUiCard";
import { RemoteToolCard } from "../../components/chat/RemoteToolCard";
import { createRecordingGenerativeUiClient } from "../client";
import { FIXTURES, PARTIAL_JSX } from "./fixtures";
import "../../styles.css";

/** Every scene the harness can show, by the name Playwright asks for. */
const SCENES = [
  "sparse", "dense", "composing", "frozen", "historical", "unsupported", "remote-tools", "all",
] as const;
type Scene = typeof SCENES[number];

const client = createRecordingGenerativeUiClient(() => new Promise(() => {}));
const resolvingClient = createRecordingGenerativeUiClient();

/** An assistant line, in the transcript's own type scale, to judge the card against. */
function AgentLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-[860px] text-[14px] leading-[22px] tracking-[-0.25px] text-kumo-default">
      {children}
    </div>
  );
}

/** A user bubble, likewise copied from the transcript. */
function UserLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-end">
      <div className="themed-user-bubble-shadow w-fit max-w-[min(680px,78%)] rounded-[24px] rounded-br-lg border border-transparent bg-kumo-bubble-user px-4 py-2.5 text-[14px] leading-[22px] tracking-[-0.25px] text-kumo-default">
        {children}
      </div>
    </div>
  );
}

/** A collapsed work row, the thing a card most often sits next to. */
function WorkRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="-ml-0.5 flex items-center gap-3 rounded-xl px-1.5 py-1 text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle">
      <span className="flex h-5 w-5 items-center justify-center">
        <span className="h-[3px] w-[3px] rounded-full bg-kumo-inactive" />
      </span>
      <span className="truncate">{children}</span>
    </div>
  );
}

function Scenes({ scene }: { scene: Scene }) {
  const show = (name: Scene) => scene === "all" || scene === name;
  const sparse = FIXTURES[0].result;
  const confirm = FIXTURES[1].result;
  const dense = FIXTURES[2].result;
  const newer = FIXTURES[3].result;

  return (
    <div className="flex flex-col gap-10">
      {show("sparse") && (
        <section data-scene="sparse" className="flex flex-col gap-4">
          <UserLine>ship checkout-api</UserLine>
          <AgentLine>Three commits ahead of production. Pick a target:</AgentLine>
          <GenerativeUiCard toolCallId="sparse-1" result={sparse} client={resolvingClient} interactive />
          <WorkRow>Read 3 files</WorkRow>
        </section>
      )}

      {show("dense") && (
        <section data-scene="dense" className="flex flex-col gap-4">
          <AgentLine>Here is the last day across your zones.</AgentLine>
          <GenerativeUiCard toolCallId="dense-1" result={dense} client={resolvingClient} interactive />
        </section>
      )}

      {show("composing") && (
        <section data-scene="composing" className="flex flex-col gap-4">
          <UserLine>can you give me a form for this?</UserLine>
          <ComposingUiCard jsx={PARTIAL_JSX} />
          <ComposingUiCard />
        </section>
      )}

      {show("frozen") && (
        <section data-scene="frozen" className="flex flex-col gap-4">
          <AgentLine>Confirm before I delete anything:</AgentLine>
          {/* `client` never resolves, so this card sits in the submitting state for screenshots;
              press the button to see it, or read the submitted state below. */}
          <GenerativeUiCard toolCallId="frozen-1" result={confirm} client={client} interactive />
          <AgentLine>And the same card once its submission has been consumed:</AgentLine>
          <SubmittedCard />
        </section>
      )}

      {show("historical") && (
        <section data-scene="historical" className="flex flex-col gap-4">
          <AgentLine>Earlier in the conversation:</AgentLine>
          <GenerativeUiCard
            toolCallId="historical-1"
            result={sparse}
            client={resolvingClient}
            interactive={false}
          />
          <UserLine>actually, do it tomorrow</UserLine>
        </section>
      )}

      {show("unsupported") && (
        <section data-scene="unsupported" className="flex flex-col gap-4">
          <AgentLine>A tree built against a catalog this build doesn&rsquo;t have:</AgentLine>
          <GenerativeUiCard
            toolCallId="newer-1"
            result={newer}
            client={resolvingClient}
            interactive={false}
          />
        </section>
      )}

      {show("remote-tools") && (
        <section data-scene="remote-tools" className="flex flex-col gap-2">
          <AgentLine>Tool calls the workshop doesn&rsquo;t own:</AgentLine>
          <RemoteToolCard toolName="memory" status="running" />
          <RemoteToolCard toolName="spawn_agent" status="done" />
          <RemoteToolCard toolName="skill_invoke" status="error" error="No skill named 'deploy'." />
          <WorkRow>Read 3 files</WorkRow>
        </section>
      )}
    </div>
  );
}

/** A card that has already been submitted, reached the only way a real one can: by submitting. */
function SubmittedCard() {
  useEffect(() => {
    const button = document.querySelector<HTMLButtonElement>('[data-submitted-card] button:last-of-type');
    button?.click();
  }, []);
  return (
    <div data-submitted-card>
      <GenerativeUiCard
        toolCallId="submitted-1"
        result={FIXTURES[1].result}
        client={resolvingClient}
        interactive
      />
    </div>
  );
}

function Harness() {
  const [mode, setMode] = useState<ResolvedThemeMode>("light");
  const [scene, setScene] = useState<Scene>("all");

  useEffect(() => { applyThemeMode(mode); }, [mode]);

  useEffect(() => {
    (window as unknown as { __genui: unknown }).__genui = {
      scenes: () => [...SCENES],
      show: (name: Scene) => {
        if (!SCENES.includes(name)) throw new Error(`no such scene: ${name}`);
        setScene(name);
      },
      theme: (next: ResolvedThemeMode) => setMode(next),
      submissions: () => resolvingClient.calls,
    };
  });

  return (
    <div className="min-h-screen bg-kumo-base px-8 py-6">
      <header className="mb-8 flex flex-wrap items-baseline gap-4">
        <strong className="text-[15px] font-semibold text-kumo-default">
          Generative UI — QA harness
        </strong>
        <span className="text-[12px] text-kumo-inactive">dev only; not in the app bundle</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {SCENES.map((name) => (
            <button
              key={name}
              type="button"
              data-scene-button={name}
              onClick={() => setScene(name)}
              className={`cursor-pointer rounded-lg border px-2.5 py-1 text-[12px] transition-colors ${
                scene === name
                  ? "border-kumo-line bg-kumo-tint text-kumo-default"
                  : "border-kumo-line text-kumo-subtle hover:text-kumo-default"
              }`}
            >
              {name}
            </button>
          ))}
          <button
            type="button"
            data-theme-toggle
            onClick={() => setMode(mode === "dark" ? "light" : "dark")}
            className="cursor-pointer rounded-lg border border-kumo-line px-2.5 py-1 text-[12px] text-kumo-subtle transition-colors hover:text-kumo-default"
          >
            {mode === "dark" ? "☾ dark" : "☀ light"}
          </button>
        </div>
      </header>

      {/* The transcript's own column width, so the cards are measured against the real gutter. */}
      <main className="mx-auto w-full max-w-[920px]">
        <Scenes scene={scene} />
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
