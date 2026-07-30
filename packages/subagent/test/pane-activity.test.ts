import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { RunActivity } from "../src/activity.js";
import { createPaneActivityRecorder, readPaneActivity } from "../src/pane-activity.js";

test("records pane activity atomically and projects each sequence once", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi9-pane-activity-"));
  const file = path.join(root, "activity.json");
  let now = 10;
  const recorder = createPaneActivityRecorder("run-1", file, () => ++now);
  const updates: string[] = [];
  const activity = new RunActivity(kind => updates.push(kind));

  try {
    recorder.record("turn_start", { turnIndex: 1 });
    recorder.record("tool_execution_start", { toolCallId: "call-1", toolName: "read" });
    const started = readPaneActivity(file, "run-1")!;
    activity.observePane(started);
    activity.observePane(started);

    expect(activity.snapshot()).toMatchObject({
      phase: "executing_tool",
      toolHistory: [{ id: "call-1", name: "read" }],
    });
    expect(updates.filter(kind => kind === "tool")).toHaveLength(1);

    recorder.record("tool_execution_end", { toolCallId: "call-1", toolName: "read" });
    activity.observePane(readPaneActivity(file, "run-1")!);
    expect(activity.snapshot().toolHistory[0].completedAt).toBeTypeOf("number");
    expect(readPaneActivity(file, "other-run")).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});