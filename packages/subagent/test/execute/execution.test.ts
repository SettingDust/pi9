import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test, vi } from "vitest";
import { Conversation, completedRun } from "../../src/conversation.js";
import { DEFAULT_EXECUTE_RUN_DEPENDENCIES, executeRun, resolveModel, resolveTaskCwd } from "../../src/execute.js";
import type { PaneExecutionHandle } from "../../src/pane-execution.js";

const config = { name: "worker", description: "", systemPrompt: "BASE", source: "project" } as any;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function model(provider: string, id: string) {
  return { provider, id } as any;
}

function registry(...models: any[]) {
  return { getAll: () => models } as any;
}

async function paneFixture(skills: string[] = []) {
  const root = await mkdtemp(path.join(tmpdir(), "pi9-pane-execute-"));
  roots.push(root);
  const parentSession = path.join(root, "parent.jsonl");
  const childDir = parentSession.slice(0, -".jsonl".length);
  const childSession = path.join(childDir, "child.jsonl");
  await writeFile(parentSession, "{}\n");

  const handle: PaneExecutionHandle = {
    surface: "surface-1",
    send: vi.fn(),
    interrupt: vi.fn(),
    close: vi.fn(),
    wait: vi.fn(),
  };
  const launchPaneExecution = vi.fn(async () => handle);
  const observePaneCompletion = vi.fn(async () => ({ status: "completed", completion: { type: "done" } } as const));
  const sessionManager = vi.fn(() => ({
    getSessionFile: () => childSession,
    getHeader: () => ({ type: "session", version: 3, id: "child", timestamp: "2026-01-01T00:00:00.000Z", cwd: root, parentSession }),
  }));
  const dependencies = {
    ...DEFAULT_EXECUTE_RUN_DEPENDENCIES,
    getAgentDir: () => path.join(root, "agent"),
getPiInvocation: () => ({ command: "C:\\runtime\\node.exe", args: ["C:\\pi\\cli.js"] }),
    sessionManager: sessionManager as any,
    loadExtensionPaths: async () => [path.join(root, "inherited.ts")],
    launchPaneExecution,
    observePaneCompletion,
    readSessionFile: (() => `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "finished" }] } })}\n`) as any,
    ownExtensionPath: path.join(root, "subagent.ts"),
  };
  const agent = new Conversation(
    "amber-acorn" as any,
    "adapt-ably" as any,
    config,
    { kind: "spawn", agent: "worker", prompt: "first", skills },
    () => {},
  );
  const ctx = {
    cwd: root,
    modelRegistry: registry(),
    sessionManager: { getSessionFile: () => parentSession },
  } as any;

  return { root, parentSession, childDir, childSession, handle, launchPaneExecution, observePaneCompletion, sessionManager, dependencies, agent, ctx };
}

test("spawns a pane-owned run with a seeded child session under the parent", async () => {
  const f = await paneFixture(["review", "review"]);

  const result = await executeRun(f.ctx, f.agent, f.agent.requireCurrentRun(), undefined, f.dependencies);

  expect(result.status).toMatchObject({ kind: "done", outcome: "completed", output: "finished" });
  expect(f.sessionManager).toHaveBeenCalledWith(f.root, f.childDir, { parentSession: f.parentSession });
  expect(f.agent.snapshot().sessionFile).toBe(f.childSession);
  await expect(import("node:fs/promises").then(fs => fs.readFile(f.childSession, "utf8"))).resolves.toContain('"version":3');
  expect(f.launchPaneExecution).toHaveBeenCalledWith(expect.objectContaining({
    cwd: f.root,
    sessionFile: f.childSession,
    prompt: expect.stringContaining("call the subagent_done tool"),
    systemPrompt: "BASE",
    skills: ["review"],
    env: expect.objectContaining({ PI_SUBAGENT_SESSION: f.childSession }),
piInvocation: { command: "C:\\runtime\\node.exe", args: ["C:\\pi\\cli.js"] },
  }));
  expect(f.observePaneCompletion).toHaveBeenCalledWith({ handle: f.handle, onTick: expect.any(Function) });
});

test("resumes the same session in a new pane", async () => {
  const f = await paneFixture();
  f.agent.setSessionFile(f.childSession);
  f.agent.bindExecution(f.handle);
  completedRun(f.agent, "adapt-ably" as any, "first result");
  const resume = f.agent.beginResume("balance-boldly" as any, "continue");
  f.sessionManager.mockClear();

  const result = await executeRun(f.ctx, f.agent, resume, undefined, f.dependencies);

  expect(result.status).toMatchObject({ kind: "done", outcome: "completed", output: "finished" });
  expect(f.sessionManager).not.toHaveBeenCalled();
  expect(f.launchPaneExecution).toHaveBeenCalledWith(expect.objectContaining({
    sessionFile: f.childSession,
    prompt: expect.stringContaining("continue"),
  }));
});

test("maps pane completion variants and cancellation into run outcomes", async () => {
  const structured = await paneFixture();
  structured.observePaneCompletion.mockResolvedValueOnce({ status: "completed", completion: { type: "structured_output", value: { ok: true } } } as any);
  await expect(executeRun(structured.ctx, structured.agent, structured.agent.requireCurrentRun(), undefined, structured.dependencies))
    .resolves.toMatchObject({ status: { outcome: "completed", output: '{"ok":true}' } });

  const ping = await paneFixture();
  ping.observePaneCompletion.mockResolvedValueOnce({ status: "completed", completion: { type: "ping", name: "question", message: "need input" } } as any);
  await expect(executeRun(ping.ctx, ping.agent, ping.agent.requireCurrentRun(), undefined, ping.dependencies))
    .resolves.toMatchObject({ status: { outcome: "completed", output: "need input" } });
const failed = await paneFixture();
  failed.observePaneCompletion.mockResolvedValueOnce({ status: "completed", completion: { type: "failed", exitCode: 7 } } as any);
  await expect(executeRun(failed.ctx, failed.agent, failed.agent.requireCurrentRun(), undefined, failed.dependencies))
    .resolves.toMatchObject({ status: { outcome: "error", error: "Pane Pi exited with code 7." } });

  const cancelled = await paneFixture();
  cancelled.observePaneCompletion.mockResolvedValueOnce({ status: "cancelled" } as any);
  await expect(executeRun(cancelled.ctx, cancelled.agent, cancelled.agent.requireCurrentRun(), undefined, cancelled.dependencies))
    .resolves.toMatchObject({ status: { outcome: "interrupted", error: "Agent interrupted." } });
});

test("terminalizes pane launch and observation failures", async () => {
  const launchFailure = await paneFixture();
  launchFailure.launchPaneExecution.mockRejectedValueOnce(new Error("mux unavailable"));
  await expect(executeRun(launchFailure.ctx, launchFailure.agent, launchFailure.agent.requireCurrentRun(), undefined, launchFailure.dependencies))
    .resolves.toMatchObject({ status: { outcome: "error", error: "mux unavailable" } });

  const observationFailure = await paneFixture();
  observationFailure.observePaneCompletion.mockRejectedValueOnce(new Error("pane failed"));
  await expect(executeRun(observationFailure.ctx, observationFailure.agent, observationFailure.agent.requireCurrentRun(), undefined, observationFailure.dependencies))
    .resolves.toMatchObject({ status: { outcome: "error", error: "pane failed" } });
});

test("resolves canonical and unique bare model references", () => {
  const parent = model("parent-provider", "parent-model");
  const qualified = model("other-provider", "shared");
  const unique = model("other-provider", "other-model");
  const models = registry(qualified, unique);

  expect(resolveModel("other-provider/shared", parent, models)).toEqual({ ok: true, value: qualified });
  expect(resolveModel("other-model", parent, models)).toEqual({ ok: true, value: unique });
});

test("resolves canonical references whose model IDs contain slashes", () => {
  const canonical = model("openrouter", "anthropic/claude-3-haiku");
  const bareCollision = model("parent-provider", "openrouter/anthropic/claude-3-haiku");
  const parent = model("parent-provider", "parent-model");
  expect(resolveModel("openrouter/anthropic/claude-3-haiku", parent, registry(bareCollision, canonical))).toEqual({ ok: true, value: canonical });
});

test("uses the parent provider to disambiguate a bare model ID", () => {
  const parent = model("parent-provider", "parent-model");
  const preferred = model("parent-provider", "shared");
  const other = model("other-provider", "shared");
  expect(resolveModel("shared", parent, registry(other, preferred))).toEqual({ ok: true, value: preferred });
});

test("rejects ambiguous, malformed, and unknown model references", () => {
  const first = model("first-provider", "shared");
  const second = model("second-provider", "shared");
  expect(resolveModel("shared", model("other", "parent"), registry(first, second))).toMatchObject({ ok: false, error: expect.stringContaining("Ambiguous model") });
  expect(resolveModel("provider/", undefined, registry())).toMatchObject({ ok: false, error: expect.stringContaining("Invalid model") });
  expect(resolveModel("missing", undefined, registry())).toEqual({ ok: false, error: "Unknown model: missing" });
});

test("inherits the parent model only when no model is requested", () => {
  const parent = model("parent-provider", "parent-model");
  expect(resolveModel(undefined, parent, registry())).toEqual({ ok: true, value: parent });
});

test("terminalizes an invalid model before allocating a pane", async () => {
  const parent = model("parent-provider", "parent-model");
  const agent = new Conversation("amber-acorn" as any, "adapt-ably" as any, { ...config, model: "missing" }, { kind: "spawn", agent: "worker", prompt: "first" }, () => {});
  await expect(executeRun({ cwd: "/unvalidated-parent", model: parent, modelRegistry: registry(parent) } as any, agent, agent.requireCurrentRun()))
    .resolves.toMatchObject({ status: { outcome: "error", error: "Unknown model: missing" } });
});

test("resolves and validates requested working directories", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "run-agent-cwd-"));
  roots.push(root);
  const relative = path.join("nested", "task");
  const absolute = path.join(root, "absolute");
  await mkdir(path.join(root, relative), { recursive: true });
  await mkdir(absolute);
  await writeFile(path.join(root, "file.txt"), "not a directory");

  expect(resolveTaskCwd(root, relative)).toEqual({ ok: true, value: path.join(root, relative) });
  expect(resolveTaskCwd(path.join(root, "unused"), absolute)).toEqual({ ok: true, value: absolute });
  expect(resolveTaskCwd(root, "missing")).toMatchObject({ ok: false, error: expect.stringContaining("does not exist") });
  expect(resolveTaskCwd(root, "file.txt")).toMatchObject({ ok: false, error: expect.stringContaining("not a directory") });
});

test("does not revalidate the inherited parent working directory", () => {
  const parentCwd = path.join(tmpdir(), "run-agent-parent-does-not-need-to-exist");
  expect(resolveTaskCwd(parentCwd, undefined)).toEqual({ ok: true, value: parentCwd });
});