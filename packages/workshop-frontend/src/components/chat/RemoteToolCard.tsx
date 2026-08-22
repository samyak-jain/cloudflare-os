/**
 * The card for a tool the workshop doesn't own.
 *
 * `AiToolCall` is a closed union the UI switches on to draw a purpose-built row per tool, which
 * works exactly as long as every tool is a workshop tool. Under a remote agent it isn't: the
 * agent runs its own tools on its own side (memory, spawning children, its skills) and those calls
 * arrive in the chat log as rows with names this build has never heard of. The per-tool switch has
 * nothing to say about them.
 *
 * So they get one honest, generic row: what ran, and how it went. Not silence -- a turn that
 * visibly did something for eight seconds and shows nothing for it reads as a bug -- and not a
 * fake summary either, since the only thing known about the call is its name.
 */

import { CircleNotch, Lightning } from "@phosphor-icons/react";

/** How far along a remote tool call is, as the transcript can tell. */
export type RemoteToolStatus = "running" | "done" | "error";

/**
 * Splits an agent tool name into words for display: `spawn_agent` → `spawn agent`.
 *
 * The name is still shown verbatim in monospace -- it is an identifier, and dressing it up as
 * prose would misrepresent how much the UI knows -- but the spacing lets it wrap.
 */
export function formatRemoteToolName(toolName: string): string {
  return toolName.replace(/[_-]+/g, " ").trim() || toolName;
}

export function RemoteToolCard({
  toolName,
  status,
  error,
}: {
  toolName: string;
  status: RemoteToolStatus;
  /** The tool's error, when it failed. Shown truncated: it is the agent's text, not the UI's. */
  error?: string;
}) {
  return (
    <div className="group/work -ml-0.5 min-w-0 max-w-[860px]">
      <div className="flex min-w-0 items-center gap-3 rounded-xl px-1.5 py-1 text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle">
        <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
          <Lightning size={15} className="text-kumo-inactive" />
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="min-w-0 truncate">
            {status === "running" ? "Running" : "Ran"}{" "}
            <span className="font-mono text-[13px] text-kumo-default">
              {formatRemoteToolName(toolName)}
            </span>
          </span>
          {/* Success gets no mark at all: every other row in the transcript reports completion by
              being in the past tense, and a row of green ticks down the side of a turn is louder
              than the work it describes. Failure gets the same pill the work rows use. */}
          {status === "running" && (
            <CircleNotch
              size={13}
              weight="bold"
              aria-label="running"
              className="flex-shrink-0 text-kumo-inactive motion-safe:animate-spin"
            />
          )}
          {status === "error" && (
            <span className="flex-shrink-0 rounded-full bg-kumo-danger-tint px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.04em] text-kumo-danger">
              Error
            </span>
          )}
        </span>
      </div>
      {status === "error" && error && (
        <div className="ml-8 mt-0.5 line-clamp-2 text-[12px] leading-4 text-kumo-subtle">
          {error}
        </div>
      )}
    </div>
  );
}
