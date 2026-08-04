import { test, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { completedGeneration } from "../../src/conversation.js";
import { readSubagentGenerationIndexes } from "../../src/index.js";
import { ConversationIdAllocator } from "../../src/identifiers.js";
import { SubagentRuntime } from "../../src/runtime.js";
import { retainedChildSessionFile } from "../../src/pane-execution.js";

const worker = {
  name: "worker",
  description: "",
  systemPrompt: "",
  source: "project",
} as any;
const registry = { agents: new Map([["worker", worker]]) } as any;
const ctx = {
  cwd: "/tmp",
  model: { provider: "test", id: "known" },
  modelRegistry: { getAll: () => [{ provider: "test", id: "known" }] },
} as any;
const executor = async (_ctx: any, conversation: any, generation: any) =>
  completedGeneration(conversation, generation, generation.prompt);

const v5 = (overrides: Record<string, unknown> = {}) => ({
  version: 5,
  subagentId: "agile-acorn",
  generation: 1,
  agent: "worker",
  label: "recovered",
  kind: "spawn",
  status: "completed",
  conversationCreatedAt: 10,
  createdAt: 11,
  completedAt: 12,
  prompt: "original prompt",
  requestedConfig: {},
  retainedSessionFile: "/sessions/agile-acorn.jsonl",
  joined: true,
  ...overrides,
});
const custom = (data: unknown) => ({ type: "custom", customType: "subagent-generation-index", data });
const recordsFor = (branch: readonly unknown[], parentSessionFile?: string) => readSubagentGenerationIndexes(branch, parentSessionFile);

test("folds only the supplied branch and keeps the newest valid v5 record per generation", () => {
  const absentBranch = [custom(v5({ subagentId: "amber-acorn", label: "other branch", completedAt: 99 }))];
  const currentBranch = [
    custom(v5({ label: "older", completedAt: 20 })),
    { type: "custom", customType: "unrelated", data: v5() },
    custom(v5({ label: "newest", completedAt: 30, prompt: "newest prompt" })),
  ];

  const indexes = recordsFor(currentBranch);
  const runtime = new SubagentRuntime(registry, 1, executor);
  expect(indexes).toEqual([expect.objectContaining({
    subagentId: "agile-acorn",
    generation: 1,
    label: "newest",
    completedAt: 30,
    prompt: "newest prompt",
  })]);
  expect(runtime.restoreTerminalConversations(indexes)).toBe(1);
  expect(runtime.listConversations().map(item => item.conversationId)).toEqual(["agile-acorn"]);
  expect(absentBranch).toHaveLength(1); // Index folding is pure and receives only the current branch.
});

test("restores valid v5 terminals idempotently with inspectable metadata while retaining v4 safely", () => {
  const retained = temporaryRetainedSession();
  try {
    const runtime = new SubagentRuntime(registry, 1, executor);
    const records = readSubagentGenerationIndexes([
      custom(v5({ retainedSessionFile: retained.sessionFile })),
      custom({
        version: 4,
        subagentId: "amber-acorn",
        generation: 1,
        agent: "worker",
        label: "legacy",
        kind: "spawn",
        status: "interrupted",
        completedAt: 20,
      }),
    ], retained.parentSessionFile);

    expect(runtime.restoreTerminalConversations(records)).toBe(2);
    expect(runtime.restoreTerminalConversations(records)).toBe(0);

    const restored = runtime.listConversations().find(item => item.conversationId === "agile-acorn")!;
    expect(restored).toMatchObject({
      label: "recovered",
      resumeAllowed: true,
      paneOpenable: true,
      generations: [{
        generation: 1,
        prompt: "original prompt",
        joined: true,
        status: { kind: "done", outcome: "completed", completedAt: 12 },
      }],
    });
    expect(runtime.inspectSubagents(["agile-acorn" as any])[0].snapshot).toMatchObject({
      joined: true,
      status: { kind: "done", outcome: "completed", completedAt: 12 },
    });
    expect((runtime as any).conversations.get("agile-acorn").sessionFileForResume()).toBe(retained.sessionFile);
    expect(runtime.conversation("amber-acorn")).toMatchObject({
      label: "legacy",
      resumeAllowed: false,
      generations: [{ status: { kind: "done", outcome: "interrupted" }, joined: false }],
    });
  } finally {
    retained.dispose();
  }
});

test("skips malformed and unknown-agent records and claims restored IDs before allocation", async () => {
  const runtime = new SubagentRuntime(registry, 1, executor);
  (runtime as any).conversationIds = new ConversationIdAllocator(() => 0);
  const records = readSubagentGenerationIndexes([
    custom(v5({ agent: "missing" })),
    custom({ ...v5({ subagentId: "amber-acorn" }), joined: "yes" }),
    custom(v5()),
  ]);

  expect(runtime.restoreTerminalConversations(records)).toBe(1);
  expect(runtime.listConversations().map(item => item.conversationId)).toEqual(["agile-acorn"]);

  const start = runtime.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "new", label: "new" }] as any);
  await start.completion;
  expect(start.starts[0]).toMatchObject({ ok: true, conversationId: "agile-alpaca" });
});
const temporaryRetainedSession = (sidecar?: string) => {
  const directory = mkdtempSync(path.join(tmpdir(), "subagent-recovery-"));
  const parentSessionFile = path.join(directory, "parent.jsonl");
  const sessionFile = retainedChildSessionFile(parentSessionFile, "agile-acorn", 1);
  mkdirSync(path.dirname(sessionFile), { recursive: true });
  writeFileSync(sessionFile, "");
  if (sidecar !== undefined) writeFileSync(`${sessionFile}.exit`, sidecar);
  return { parentSessionFile, sessionFile, dispose: () => rmSync(directory, { recursive: true, force: true }) };
};

const restore = (retained: { parentSessionFile: string; sessionFile: string }, status: "completed" | "error" | "aborted" | "interrupted" = "completed") => {
  const runtime = new SubagentRuntime(registry, 1, executor);
  expect(runtime.restoreTerminalConversations(recordsFor([custom(v5({ retainedSessionFile: retained.sessionFile, status }))], retained.parentSessionFile))).toBe(1);
  return runtime;
};

test("drops retained session files that are not derived from the current parent session", () => {
  const retained = temporaryRetainedSession();
  try {
    const records = recordsFor([custom(v5({ retainedSessionFile: path.join(path.dirname(retained.parentSessionFile), "other.jsonl") }))], retained.parentSessionFile);
    const runtime = new SubagentRuntime(registry, 1, executor);
    expect(runtime.restoreTerminalConversations(records)).toBe(1);
    expect(runtime.conversation("agile-acorn" as any)).toMatchObject({ resumeAllowed: false });
    expect((runtime as any).conversations.get("agile-acorn").sessionFileForResume()).toBeUndefined();
  } finally {
    retained.dispose();
  }
});

test("drops retained session files that are missing even when the path is derived", () => {
  const retained = temporaryRetainedSession();
  try {
    rmSync(retained.sessionFile);
    const records = recordsFor([custom(v5({ retainedSessionFile: retained.sessionFile }))], retained.parentSessionFile);
    const runtime = new SubagentRuntime(registry, 1, executor);
    expect(runtime.restoreTerminalConversations(records)).toBe(1);
    expect(runtime.conversation("agile-acorn" as any)).toMatchObject({ resumeAllowed: false });
    expect((runtime as any).conversations.get("agile-acorn").sessionFileForResume()).toBeUndefined();
  } finally {
    retained.dispose();
  }
});

test("does not restore nested records when the recovered parent is missing", () => {
  const runtime = new SubagentRuntime(registry, 1, executor);
  const records = recordsFor([custom(v5({ subagentId: "amber-acorn", parentConversationId: "agile-acorn" }))]);
  expect(runtime.restoreTerminalConversations(records)).toBe(0);
  expect(runtime.listConversations()).toEqual([]);
});

test("refuses resume and open when a retained session file disappeared", async () => {
  const retained = temporaryRetainedSession();
  try {
    const runtime = restore(retained);
    rmSync(retained.sessionFile);
    const resumed = runtime.startTasks(ctx, [{ kind: "resume", subagentId: "agile-acorn", prompt: "again" }] as any);
    expect(resumed.starts[0]).toMatchObject({ ok: false, error: expect.stringContaining("retained session file is missing") });
    await expect(runtime.openConversationPane(ctx as any, "agile-acorn")).rejects.toThrow("retained pane session file is missing");
  } finally {
    retained.dispose();
  }
});

test("restoration, list, and inspect leave retained completion sidecars unread until join", async () => {
  const cases = [
    { name: "structured output", sidecar: JSON.stringify({ type: "structured_output", value: { answer: 42 } }), output: JSON.stringify({ answer: 42 }) },
    { name: "ping", sidecar: JSON.stringify({ type: "ping", name: "parent", message: "need input" }), output: "need input" },
    { name: "done", sidecar: JSON.stringify({ type: "done" }), output: "" },
  ];

  for (const item of cases) {
    const retained = temporaryRetainedSession(item.sidecar);
    try {
      const runtime = restore(retained);
      const listed = runtime.listConversations()[0]!.generations[0]!;
      const inspected = runtime.inspectSubagents(["agile-acorn" as any])[0]!.snapshot;
      expect(listed.status).toMatchObject({ kind: "done", outcome: "completed" });
      expect(inspected.status).toMatchObject({ kind: "done", outcome: "completed" });
      expect(listed.status).not.toHaveProperty("output");
      expect(inspected.status).not.toHaveProperty("output");

      const join = runtime.bindSubagentJoin(["agile-acorn" as any]);
      await join.completion;
      expect(join.project()[0]!.status).toMatchObject({ kind: "done", outcome: "completed", output: item.output });
      join.markJoined();
      join.release();
    } finally {
      retained.dispose();
    }
  }
});

test("failed, missing, and malformed retained sidecars keep restored terminal output absent", async () => {
  const cases: Array<{ name: string; status: "error" | "interrupted" | "aborted"; sidecar?: string }> = [
    { name: "failed", status: "error", sidecar: JSON.stringify({ type: "failed", exitCode: 1 }) },
    { name: "missing", status: "interrupted" },
    { name: "malformed", status: "aborted", sidecar: "{" },
  ];

  for (const item of cases) {
    const retained = temporaryRetainedSession(item.sidecar);
    try {
      const runtime = restore(retained, item.status);
      expect(runtime.listConversations()[0]!.generations[0]!.status).toMatchObject({ kind: "done", outcome: item.status });
      expect(runtime.inspectSubagents(["agile-acorn" as any])[0]!.snapshot.status).not.toHaveProperty("output");

      const join = runtime.bindSubagentJoin(["agile-acorn" as any]);
      await join.completion;
      expect(join.project()[0]!.status).toMatchObject({ kind: "done", outcome: item.status });
      expect(join.project()[0]!.status).not.toHaveProperty("output");
      join.release();
    } finally {
      retained.dispose();
    }
  }
});

test("repeated joins retain an already hydrated restored output", async () => {
  const retained = temporaryRetainedSession(JSON.stringify({ type: "structured_output", value: "first" }));
  try {
    const runtime = restore(retained);
    const first = runtime.bindSubagentJoin(["agile-acorn" as any]);
    await first.completion;
    expect(first.project()[0]!.status).toMatchObject({ output: "first" });
    first.release();

    writeFileSync(`${retained.sessionFile}.exit`, JSON.stringify({ type: "structured_output", value: "second" }));
    const repeated = runtime.bindSubagentJoin(["agile-acorn" as any]);
    await repeated.completion;
    expect(repeated.project()[0]!.status).toMatchObject({ kind: "done", outcome: "completed", output: "first" });
    repeated.release();
  } finally {
    retained.dispose();
  }
});