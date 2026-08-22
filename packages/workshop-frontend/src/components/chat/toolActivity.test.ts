import { describe, expect, it } from "vitest";
import { projectToolActivity, type ToolActivityProjectionState } from "./toolActivity";

function state(): ToolActivityProjectionState {
  return { toolActivities: [], nextToolActivityKey: 1 };
}

describe("projectToolActivity", () => {
  it("projects a lifecycle onto one generic activity card", () => {
    let projection = state();
    projectToolActivity(projection, "memory", "started");
    expect(projection.toolActivities).toEqual([
      { key: 1, toolName: "memory", status: "running" },
    ]);

    projectToolActivity(projection, "memory", "completed");
    expect(projection.toolActivities).toEqual([
      { key: 1, toolName: "memory", status: "done" },
    ]);
  });

  it("keeps overlapping same-name lifecycles distinct without inventing a call id", () => {
    let projection = state();
    projectToolActivity(projection, "spawn_agent", "started");
    projectToolActivity(projection, "spawn_agent", "started");
    projectToolActivity(projection, "spawn_agent", "error");

    expect(projection.toolActivities).toEqual([
      { key: 1, toolName: "spawn_agent", status: "running" },
      { key: 2, toolName: "spawn_agent", status: "error" },
    ]);
  });
});
