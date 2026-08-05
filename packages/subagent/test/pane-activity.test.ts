import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { createPaneActivityRecorder, projectPaneActivity, readPaneActivity } from "../src/pane-activity.js";

async function activityFile() {
  const directory = await mkdtemp(path.join(tmpdir(), "pane-activity-"));
  return { file: path.join(directory, "activity.json"), dispose: () => rm(directory, { recursive: true, force: true }) };
}

test("writes activity for a Windows-style run id", async () => {
  const activity = await activityFile();
  try {
    const recorder = createPaneActivityRecorder("calm-otter:1", activity.file, () => 100);
    recorder.record("agent_start");

    expect(JSON.parse(await readFile(activity.file, "utf8"))).toMatchObject({ runningChildId: "calm-otter:1", phase: "active" });
    expect(readPaneActivity(activity.file, "calm-otter:1")).toMatchObject({ runningChildId: "calm-otter:1", phase: "active" });
  } finally {
    await activity.dispose();
  }
});

test("projects completed tools cumulatively in execution order", async () => {
  const activity = await activityFile();
  try {
    let now = 0;
    const recorder = createPaneActivityRecorder("calm-otter:1", activity.file, () => ++now);
    recorder.record("tool_execution_start", { toolCallId: "first", toolName: "read" });
    recorder.record("tool_execution_end", { toolCallId: "first", toolName: "read" });
    recorder.record("tool_execution_start", { toolCallId: "second", toolName: "bash" });
    recorder.record("tool_execution_end", { toolCallId: "second", toolName: "bash" });

    expect(projectPaneActivity(readPaneActivity(activity.file, "calm-otter:1"))?.toolHistory).toEqual([
      expect.objectContaining({ id: "first", name: "read", completedAt: expect.any(Number) }),
      expect.objectContaining({ id: "second", name: "bash", completedAt: expect.any(Number) }),
    ]);
  } finally {
    await activity.dispose();
  }
});

test("projects legacy v1 single-tool sidecars", () => {
  expect(projectPaneActivity({
    version: 1,
    runningChildId: "calm-otter:1",
    sequence: 4,
    updatedAt: 40,
    latestEvent: "tool_execution_end",
    phase: "active",
    toolCallId: "legacy-tool",
    toolName: "read",
    toolStartedAt: 20,
    toolEndedAt: 40,
  })?.toolHistory).toEqual([{ id: "legacy-tool", name: "read", startedAt: 20, completedAt: 40 }]);
});
