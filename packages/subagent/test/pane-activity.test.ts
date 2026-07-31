import { mkdtemp, rm } from "node:fs/promises";
import { unlinkSync, writeFileSync } from "node:fs";
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
    recorder.record("turn_start");
    recorder.record("tool_execution_start", { toolCallId: "call-1", toolName: "read" });
    const started = readPaneActivity(file, "run-1")!;
    activity.observePane(started);
    activity.observePane(started);
    const usage = {
      input: 11,
      output: 7,
      cacheRead: 3,
      cacheWrite: 2,
      totalTokens: 23,
      cost: { input: 0.11, output: 0.07, cacheRead: 0.03, cacheWrite: 0.02, total: 0.23 },
    };
    recorder.record("message_end", { usage });
    const firstUsage = readPaneActivity(file, "run-1")!;
    activity.observePane(firstUsage);
    expect(activity.usage).toEqual(usage);

    const compactedUsage = {
      input: 4,
      output: 2,
      cacheRead: 1,
      cacheWrite: 0,
      totalTokens: 7,
      cost: { input: 0.04, output: 0.02, cacheRead: 0.01, cacheWrite: 0, total: 0.07 },
    };
    recorder.record("message_end", { usage: compactedUsage });
    const compacted = readPaneActivity(file, "run-1")!;
    activity.observePane(compacted);
    expect(compacted.usage).toEqual(compactedUsage);
    expect(activity.usage).toEqual(compactedUsage);

    recorder.record("turn_end", { turnIndex: 0 });
    recorder.record("subagent_done");
    const done = readPaneActivity(file, "run-1")!;
    expect(done).toMatchObject({ latestEvent: "subagent_done", turnIndex: 0, usage: compactedUsage });
    activity.observePane(done);
    expect(activity.snapshot().turns).toBe(1);
    expect(activity.usage).toEqual(compactedUsage);

    recorder.record("session_shutdown");
    const shutdown = readPaneActivity(file, "run-1")!;
    expect(shutdown).toMatchObject({ latestEvent: "session_shutdown", turnIndex: 0, usage: compactedUsage });
    activity.observePane(shutdown);
    expect(activity.snapshot().turns).toBe(1);
    expect(activity.usage).toEqual(compactedUsage);

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

test("keeps later records eligible after a failed publish", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi9-pane-activity-retry-"));
  const blocker = path.join(root, "blocked");
  const file = path.join(blocker, "activity.json");
  writeFileSync(blocker, "not a directory");
  const recorder = createPaneActivityRecorder("run-retry", file);

  try {
    recorder.record("message_update", { messageEventType: "text_delta" });
    expect(readPaneActivity(file, "run-retry")).toBeUndefined();

    unlinkSync(blocker);
    recorder.record("message_end", { messageEventType: "text_delta" });
    expect(readPaneActivity(file, "run-retry")).toMatchObject({
      sequence: 2,
      latestEvent: "message_end",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});