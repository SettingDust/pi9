import { test, expect, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { completedGeneration } from "../../src/conversation.js";
import { readActivePaneGenerationLeases, readSubagentGenerationIndexes, registerSubagentMetadataPersistence } from "../../src/index.js";
import { ConversationIdAllocator } from "../../src/identifiers.js";
import { SubagentRuntime, type TerminalRecoveryRecord } from "../../src/runtime.js";
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
const recordsFor = (branch: readonly unknown[], parentSessionFile?: string) =>
  readSubagentGenerationIndexes(branch, parentSessionFile);

test("limits recovery to the twenty newest recoverable conversations", () => {
  const nouns = [
    "acorn", "alpaca", "antelope", "arachnid", "aster", "aurora", "avocado", "axolotl", "badger", "beaver",
    "beetle", "bicep", "birch", "bison", "blimp", "blob", "blossom", "bluebird", "bobcat", "bonsai",
    "bowtie", "branch", "breeze", "brew", "brook",
  ];
  const records = recordsFor(nouns.map((noun, index) => custom(v5({ subagentId: `agile-${noun}`, completedAt: index + 1 }))));
  const runtime = new SubagentRuntime(registry, 30, executor);

  expect(records).toHaveLength(25);
  expect(runtime.restoreTerminalConversations(records, 20)).toBe(20);
  expect(runtime.listConversations().map(item => item.conversationId).sort()).toEqual(
    nouns.slice(5).map(noun => `agile-${noun}`).sort(),
  );
});

test("counts a recovered multi-generation conversation once while retaining every generation", () => {
  const records = recordsFor([
    custom(v5({ subagentId: "agile-acorn", completedAt: 10 })),
    custom(v5({ subagentId: "agile-acorn", generation: 2, kind: "resume", createdAt: 11, completedAt: 20 })),
    custom(v5({ subagentId: "agile-alpaca", completedAt: 15 })),
  ]);
  const runtime = new SubagentRuntime(registry, 30, executor);

  expect(runtime.restoreTerminalConversations(records, 1)).toBe(1);
  expect(runtime.conversation("agile-acorn" as any)).toMatchObject({
    generations: [{ generation: 1 }, { generation: 2, kind: "resume" }],
  });
});

test("keeps an older parent with its newest nested child when the recovery limit fits both", () => {
  const records = recordsFor([
    custom(v5({ subagentId: "agile-acorn", completedAt: 10 })),
    custom(v5({ subagentId: "agile-alpaca", parentConversationId: "agile-acorn", completedAt: 30 })),
    custom(v5({ subagentId: "agile-antelope", completedAt: 20 })),
  ]);
  const runtime = new SubagentRuntime(registry, 30, executor);

  expect(runtime.restoreTerminalConversations(records, 2)).toBe(2);
  expect(runtime.listConversations().map(item => item.conversationId).sort()).toEqual(["agile-acorn", "agile-alpaca"]);
});

test("skips an oversized newest child chain and fills the recovery limit with independent history", () => {
  const records = recordsFor([
    custom(v5({ subagentId: "agile-acorn", completedAt: 10 })),
    custom(v5({ subagentId: "agile-alpaca", parentConversationId: "agile-acorn", completedAt: 30 })),
    custom(v5({ subagentId: "agile-antelope", completedAt: 20 })),
  ]);
  const runtime = new SubagentRuntime(registry, 30, executor);

  expect(runtime.restoreTerminalConversations(records, 1)).toBe(1);
  expect(runtime.listConversations().map(item => item.conversationId)).toEqual(["agile-antelope"]);
});

test("keeps all folded records when no reader conversation limit is supplied", () => {
  const branch = [
    custom(v5({ subagentId: "agile-acorn", completedAt: 10 })),
    custom(v5({ subagentId: "agile-acorn", generation: 2, kind: "resume", createdAt: 11, completedAt: 20 })),
    custom(v5({ subagentId: "agile-alpaca", completedAt: 30 })),
  ];

  expect(recordsFor(branch).map(record => [record.subagentId, record.generation])).toEqual([
    ["agile-acorn", 1],
    ["agile-acorn", 2],
    ["agile-alpaca", 1],
  ]);
});

test("fills a recovery cap with an older valid conversation when the newest record is ineligible", () => {
  const records = recordsFor([
    custom(v5({ subagentId: "agile-acorn", completedAt: 20 })),
    custom(v5({ subagentId: "agile-alpaca", agent: "missing", completedAt: 30 })),
  ]);
  const runtime = new SubagentRuntime(registry, 30, executor);

  expect(runtime.restoreTerminalConversations(records, 1)).toBe(1);
  expect(runtime.listConversations().map(item => item.conversationId)).toEqual(["agile-acorn"]);
});

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
const temporaryRetainedSession = (sidecar?: string, subagentId = "agile-acorn") => {
  const directory = mkdtempSync(path.join(tmpdir(), "subagent-recovery-"));
  const parentSessionFile = path.join(directory, "parent.jsonl");
  const sessionFile = retainedChildSessionFile(parentSessionFile, subagentId, 1);
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

test("active lease persistence retries autonomously and drops stale leases", async () => {
  vi.useFakeTimers();
  try {
    let listener: ((agent: any, kind: any) => void) | undefined;
    let failOnce = true;
    const entries: Array<{ customType: string; data: any }> = [];
    registerSubagentMetadataPersistence({ appendEntry: (customType, data) => {
      if (failOnce) { failOnce = false; throw new Error("temporary append failure"); }
      entries.push({ customType, data });
    } }, { onConversationUpdate: next => { listener = next; return () => {}; } });
    const snapshot = { conversationId: "agile-acorn", label: "recovered", agent: { name: "worker" }, createdAt: 10, requestedConfig: {}, generations: [{ generation: 1, kind: "spawn", createdAt: 11, prompt: "original prompt", joined: false, status: { kind: "running", startedAt: 12 } }] };
    const agent: any = { snapshot: () => snapshot, sessionFileForResume: () => "/sessions/agile-acorn.jsonl", retainedPaneSurface: () => "pane-1" };

    expect(() => listener?.(agent, "status")).toThrow("temporary append failure");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(entries).toEqual([{ customType: "subagent-active-pane-lease", data: expect.objectContaining({ retainedSessionFile: "/sessions/agile-acorn.jsonl", paneSurface: "pane-1", childId: "agile-acorn:1" }) }]);

    let staleListener: ((agent: any, kind: any) => void) | undefined;
    const staleEntries: Array<{ customType: string; data: any }> = [];
    registerSubagentMetadataPersistence({ appendEntry: (customType, data) => { staleEntries.push({ customType, data }); throw new Error("temporary append failure"); } }, { onConversationUpdate: next => { staleListener = next; return () => {}; } });
    const staleSnapshot: any = { ...snapshot, conversationId: "agile-alpaca", generations: [{ ...snapshot.generations[0], status: { kind: "running", startedAt: 12 } }] };
    const staleAgent: any = { snapshot: () => staleSnapshot, sessionFileForResume: () => "/sessions/agile-alpaca.jsonl", retainedPaneSurface: () => "pane-2" };
    expect(() => staleListener?.(staleAgent, "status")).toThrow("temporary append failure");
    staleSnapshot.generations[0].status = { kind: "done", outcome: "completed", completedAt: 13 };
    await vi.advanceTimersByTimeAsync(1_000);
    expect(staleEntries).toHaveLength(1);

    let permanentListener: ((agent: any, kind: any) => void) | undefined;
    const permanentEntries: Array<{ customType: string; data: any }> = [];
    registerSubagentMetadataPersistence({ appendEntry: (customType, data) => {
      permanentEntries.push({ customType, data });
      if (customType === "subagent-active-pane-lease") throw new Error("permanent append failure");
    } }, { onConversationUpdate: next => { permanentListener = next; return () => {}; } });
    const permanentSnapshot: any = { ...snapshot, conversationId: "agile-antelope" };
    const permanentAgent: any = { snapshot: () => permanentSnapshot, sessionFileForResume: () => "/sessions/agile-antelope.jsonl", retainedPaneSurface: () => "pane-3" };

    expect(() => permanentListener?.(permanentAgent, "status")).toThrow("permanent append failure");
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(permanentEntries.filter(entry => entry.customType === "subagent-active-pane-lease")).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(permanentEntries.filter(entry => entry.customType === "subagent-active-pane-lease")).toHaveLength(4);

    permanentSnapshot.generations[0].status = { kind: "done", outcome: "completed", completedAt: 13 };
    permanentListener?.(permanentAgent, "status");
    expect(permanentEntries.at(-1)).toMatchObject({ customType: "subagent-generation-index" });
  } finally { vi.useRealTimers(); }
});

test("active lease reader rejects spoofed sessions and permanently prefers terminal evidence", () => {
  const retained = temporaryRetainedSession();
  try {
    const active = activeLease(retained);
    const spoofed = { ...active, retainedSessionFile: path.join(path.dirname(retained.parentSessionFile), "spoofed.jsonl") };
    expect(readActivePaneGenerationLeases([custom(spoofed)], retained.parentSessionFile)).toEqual([]);
    expect(readActivePaneGenerationLeases([custom(active), custom(v5({ retainedSessionFile: retained.sessionFile })), custom(active)], retained.parentSessionFile)).toEqual([]);
  } finally { retained.dispose(); }
});

test("restores a valid active pane by rebinding its existing controls without scheduling or launching", async () => {
  const retained = temporaryRetainedSession();
  try {
    const recoveredExecutor = vi.fn(executor);
    const runtime = new SubagentRuntime(registry, 1, recoveredExecutor);
    let complete!: (value: any) => void;
    const completion = new Promise(resolve => { complete = resolve; });
    const execution = { surface: "pane-1", send: vi.fn(), interrupt: vi.fn(() => complete({ status: "cancelled" })), observeActivity: vi.fn(), waitForCompletion: vi.fn(() => completion), close: vi.fn() };
    const rebindPaneExecution = vi.fn(async () => execution);

    await expect(runtime.restoreActivePaneConversations([activeLease(retained)], { rebindPaneExecution } as any)).resolves.toEqual([{ ok: true, conversationId: "agile-acorn", generation: 1 }]);
    expect(rebindPaneExecution).toHaveBeenCalledOnce();
    expect(recoveredExecutor).not.toHaveBeenCalled();
    expect(runtime.conversation("agile-acorn")).toMatchObject({ generations: [{ status: { kind: "running" } }] });
    await runtime.steerSubagent("agile-acorn" as any, "continue");
    expect(execution.send).toHaveBeenCalledWith("continue");
    await runtime.cancelSubagent("agile-acorn" as any);
    expect(execution.interrupt).toHaveBeenCalledOnce();
    expect(runtime.conversation("agile-acorn").generations[0]!.status).toMatchObject({ kind: "done", outcome: "aborted" });
  } finally { retained.dispose(); }
});

test("prewritten pane completion settles and hydrates without rebinding an unavailable surface", async () => {
  const retained = temporaryRetainedSession(JSON.stringify({ type: "structured_output", value: "recovered" }));
  try {
    const runtime = new SubagentRuntime(registry, 1, executor);
    const rebindPaneExecution = vi.fn(async () => { throw new Error("surface unavailable"); });
    await expect(runtime.restoreActivePaneConversations([activeLease(retained)], { rebindPaneExecution } as any)).resolves.toEqual([{ ok: true, conversationId: "agile-acorn", generation: 1 }]);
    expect(rebindPaneExecution).not.toHaveBeenCalled();
    const join = runtime.bindSubagentJoin(["agile-acorn" as any]);
    await join.completion;
    expect(join.project()[0]!.status).toMatchObject({ kind: "done", outcome: "completed", output: "recovered" });
    join.release();
  } finally { retained.dispose(); }
});

function activeLease(retained: { sessionFile: string }, subagentId = "agile-acorn", parentConversationId?: string) {
  return { version: 1 as const, subagentId, generation: 1, agent: "worker", label: "recovered", kind: "spawn" as const, conversationCreatedAt: 10, createdAt: 11, startedAt: 12, prompt: "original prompt", requestedConfig: {}, ...(parentConversationId ? { parentConversationId } : {}), retainedSessionFile: retained.sessionFile, paneSurface: "pane-1", childId: `${subagentId}:1`, generations: [{ generation: 1, kind: "spawn" as const, createdAt: 11, startedAt: 12, status: "running" as const, prompt: "original prompt", joined: false }] };
}

function terminal(subagentId: string, parentConversationId?: string): TerminalRecoveryRecord {
  return { version: 5, subagentId, generation: 1, agent: "worker", label: "recovered", kind: "spawn", status: "completed", conversationCreatedAt: 10, createdAt: 11, completedAt: 12, prompt: "original prompt", ...(parentConversationId ? { parentConversationId } : {}), requestedConfig: {}, joined: true };
}

function reboundPane(surface: string) {
  return { surface, send: vi.fn(), interrupt: vi.fn(), close: vi.fn(), wait: vi.fn(), observeActivity: vi.fn(), waitForCompletion: vi.fn(() => new Promise<never>(() => {})) };
}

test("mixed recovery reserves capacity for an active pane before unrelated terminal history", async () => {
  const retained = temporaryRetainedSession();
  try {
    const runtime = new SubagentRuntime(registry, 1, executor, 2);
    const execution = reboundPane("pane-1");
    const rebindPaneExecution = vi.fn(async () => execution);
    const recovered = await runtime.recoverPersistedConversations(
      [terminal("agile-alpaca"), terminal("agile-antelope")],
      [activeLease(retained)], 2, { rebindPaneExecution },
    );

    expect(recovered).toMatchObject({ active: [{ ok: true, conversationId: "agile-acorn" }], terminals: 1 });
    expect(rebindPaneExecution).toHaveBeenCalledOnce();
    expect(runtime.conversation("agile-acorn").generations[0]!.status).toMatchObject({ kind: "running" });
    expect(runtime.listConversations()).toHaveLength(2);
  } finally { retained.dispose(); }
});

test("mixed recovery restores a terminal child after its active lease parent", async () => {
  const retained = temporaryRetainedSession();
  try {
    const runtime = new SubagentRuntime(registry, 1, executor, 2);
    const execution = reboundPane("pane-1");
    const rebindPaneExecution = vi.fn(async () => execution);
    const recovered = await runtime.recoverPersistedConversations(
      [terminal("agile-alpaca", "agile-acorn")],
      [activeLease(retained)], 2, { rebindPaneExecution },
    );

    expect(recovered).toMatchObject({ active: [{ ok: true, conversationId: "agile-acorn" }], terminals: 1 });
    expect(rebindPaneExecution).toHaveBeenCalledOnce();
    expect(runtime.listConversations().map(item => item.conversationId).sort()).toEqual(["agile-acorn", "agile-alpaca"]);
  } finally { retained.dispose(); }
});

test("mixed recovery restores a terminal parent before rebinding its active child", async () => {
  const retained = temporaryRetainedSession(undefined, "agile-alpaca");
  try {
    const runtime = new SubagentRuntime(registry, 1, executor, 2);
    const execution = reboundPane("pane-1");
    const rebindPaneExecution = vi.fn(async () => execution);
    const recovered = await runtime.recoverPersistedConversations(
      [terminal("agile-acorn")],
      [activeLease(retained, "agile-alpaca", "agile-acorn")], 2, { rebindPaneExecution },
    );

    expect(recovered).toMatchObject({ active: [{ ok: true, conversationId: "agile-alpaca" }], terminals: 1 });
    expect(rebindPaneExecution).toHaveBeenCalledOnce();
    expect(runtime.listConversations().map(item => item.conversationId).sort()).toEqual(["agile-acorn", "agile-alpaca"]);
  } finally { retained.dispose(); }
});

test("failed active recovery releases its reserved capacity to terminal history", async () => {
  const retained = temporaryRetainedSession();
  try {
    const runtime = new SubagentRuntime(registry, 1, executor, 1);
    const rebindPaneExecution = vi.fn(async () => { throw new Error("rebind failed"); });
    const recovered = await runtime.recoverPersistedConversations(
      [terminal("agile-alpaca")],
      [activeLease(retained)], 1, { rebindPaneExecution },
    );

    expect(recovered).toMatchObject({ active: [{ ok: false, conversationId: "agile-acorn" }], terminals: 1 });
    expect(rebindPaneExecution).toHaveBeenCalledOnce();
    expect(runtime.listConversations().map(item => item.conversationId)).toEqual(["agile-alpaca"]);
  } finally { retained.dispose(); }
});
