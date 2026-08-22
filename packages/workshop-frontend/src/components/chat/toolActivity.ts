import type { RemoteToolStatus } from "./RemoteToolCard";

/** One generic card projected from a redacted remote-agent local-tool lifecycle. */
export type ToolActivityCardState = {
  key: number;
  toolName: string;
  status: RemoteToolStatus;
};

/** Minimal provisional chat state changed by a display-only local-tool lifecycle. */
export type ToolActivityProjectionState = {
  toolActivities: ToolActivityCardState[];
  nextToolActivityKey: number;
};

/**
 * Project a name/status-only lifecycle without inventing an executable call identity.
 *
 * Hermes deliberately omits call IDs, so an end updates the latest running card with the same
 * name. A missing start can happen when a subscriber attaches mid-turn; in that case the terminal
 * status still gets an honest standalone card.
 */
export function projectToolActivity(
  state: ToolActivityProjectionState,
  toolName: string,
  status: "started" | "completed" | "error",
): void {
  let displayStatus: RemoteToolStatus = status === "started" ? "running" :
    status === "completed" ? "done" : "error";
  if (status !== "started") {
    let active = state.toolActivities.findLast(
      activity => activity.toolName === toolName && activity.status === "running",
    );
    if (active) {
      active.status = displayStatus;
      return;
    }
  }
  state.toolActivities.push({
    key: state.nextToolActivityKey++,
    toolName,
    status: displayStatus,
  });
}
