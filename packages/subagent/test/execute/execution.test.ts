import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test, vi } from "vitest";
import { DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Conversation } from "../../src/conversation.js";
import { completedRun } from "../../src/conversation.js";
import { DEFAULT_EXECUTE_RUN_DEPENDENCIES, resolveModel, resolveTaskCwd, executeRun } from "../../src/execute.js";

const config = { name: "worker", description: "", systemPrompt: "", source: "project" } as any;
const savedHome = process.env.HOME;
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

function finishedSession(overrides: Record<string, unknown> = {}) {
  return {
    messages: [{ role: "assistant", content: [{ type: "text", text: "finished" }] }],
    subscribe: () => () => {}, prompt: async () => {}, abort: vi.fn(), dispose: vi.fn(), bindExtensions: vi.fn(),
    ...overrides,
  } as any;
}

function spawning(skills: string[], systemPrompt = "BASE") {
  return new Conversation(
    "amber-acorn" as any,
    "adapt-ably" as any,
    { ...config, systemPrompt },
    { kind: "spawn", agent: "worker", prompt: "first", skills },
    () => {},
  );
}
function resumable(messages: any[], prompt: () => Promise<void>, abort = vi.fn()) {
  const agent = new Conversation("amber-acorn" as any, "adapt-ably" as any, config, { kind: "spawn", agent: "worker", prompt: "first" }, () => {});
  const session = { messages, subscribe: () => () => {}, prompt, abort } as any;
  agent.bindSession(session); completedRun(agent, "adapt-ably" as any, "first");
  const attempt = agent.beginResume("balance-boldly" as any, "continue");
  return { agent, attempt, session, abort };
}

test("resume completes with the final assistant text", async () => {
  const f = resumable([{ role: "assistant", content: [{ type: "text", text: "finished" }] }], async () => {});
  await expect(executeRun({} as any, f.agent, f.attempt)).resolves.toMatchObject({ status: { kind: "done", outcome: "completed", output: "finished" } });
});

test("child session lifecycle observers span finalized tool execution events", async () => {
  const listeners: Array<(event: any) => void> = [];
  const session = {
    messages: [{ role: "assistant", content: [{ type: "text", text: "finished" }] }],
    subscribe(listener: (event: any) => void) { listeners.push(listener); return () => { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); }; },
    async prompt() {
      const start = { type: "tool_execution_start", toolCallId: "child-call", toolName: "subagent", args: { action: "inspect", runIds: ["adapt-ably"] } };
      const end = { type: "tool_execution_end", toolCallId: "child-call", toolName: "subagent", result: { details: { action: "inspect", runs: [{ runId: "adapt-ably", status: "completed" }] } } };
      for (const listener of [...listeners]) listener(start);
      for (const listener of [...listeners]) listener(end);
    },
    abort: vi.fn(),
  } as any;
  const agent = new Conversation("amber-acorn" as any, "adapt-ably" as any, config, { kind: "spawn", agent: "worker", prompt: "first" }, () => {});
  agent.bindSession(session); completedRun(agent, "adapt-ably" as any, "first");
  const attempt = agent.beginResume("balance-boldly" as any, "continue");
  const observed: any[] = [];

  await executeRun({} as any, agent, attempt, undefined, {
    ...DEFAULT_EXECUTE_RUN_DEPENDENCIES,
    childSessionEvent: (_agent: any, _run: any, event: any) => observed.push(event),
  } as any);

  expect(observed.map(event => event.type)).toEqual(["tool_execution_start", "tool_execution_end"]);
  expect(listeners).toHaveLength(0);
});

test("stores child sessions beneath the parent session file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi9-subagent-parent-"));
  const parentSession = path.join(root, "2026-07-18T04-14-22-620Z_019f736e-b39c-7fc0-a34e-6ef57fecec5c.jsonl");
  const childDir = parentSession.slice(0, -".jsonl".length);
  const manager = DEFAULT_EXECUTE_RUN_DEPENDENCIES.sessionManager(process.cwd(), childDir, { parentSession });
  const sessionFile = manager.getSessionFile();

  try {
    expect(manager).toBeInstanceOf(SessionManager);
    expect(manager.isPersisted()).toBe(true);
    expect(path.dirname(sessionFile!)).toBe(childDir);
    expect(manager.getHeader()?.parentSession).toBe(parentSession);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discovers requested skills through Pi ResourceLoader instead of the low-level scanner", async () => {
  const skill = { name: "resource-only", filePath: "/skills/resource-only/SKILL.md", baseDir: "/skills/resource-only" };
  let loaderOptions: any;
  class ResourceLoader {
    constructor(options: any) { loaderOptions = options; }
    async reload() {}
    getExtensions() { return { extensions: [], errors: [], runtime: {} }; }
    getSkills() { return { skills: [skill], diagnostics: [] }; }
    getPrompts() { return { prompts: [], diagnostics: [] }; }
    getThemes() { return { themes: [], diagnostics: [] }; }
    getAgentsFiles() { return { agentsFiles: [] }; }
    getSystemPrompt() { return loaderOptions.systemPromptOverride?.() ?? loaderOptions.systemPrompt; }
    getAppendSystemPrompt() { return []; }
    extendResources() {}
  }
  const session = finishedSession();
  let resourceLoader: any;
  const parentSession = path.join("C:", "Users", "WINDOWS", ".pi", "agent", "sessions", "--E--Projects-pi-dust-harness--", "2026-07-18T04-14-22-620Z_019f736e-b39c-7fc0-a34e-6ef57fecec5c.jsonl");
  const createSessionManager = vi.fn(() => ({}));
  const agent = spawning(["resource-only"]);

  const result = await executeRun({
    cwd: process.cwd(),
    modelRegistry: registry(),
    sessionManager: { getSessionFile: () => parentSession },
  } as any, agent, agent.requireCurrentRun(), undefined, {
    ...DEFAULT_EXECUTE_RUN_DEPENDENCIES,
    ResourceLoader: ResourceLoader as any,
    getAgentDir: () => "/tmp/pi-agent",
    settingsManager: (() => ({ setProjectTrusted() {} })) as any,
    sessionManager: createSessionManager as any,
    loadExtensionPaths: async () => [],
    readSkillFile: (() => "---\nname: resource-only\ndescription: test\n---\n\nRESOURCE BODY") as any,
    createAgentSession: (async (options: any) => { resourceLoader = options.resourceLoader; return { session }; }) as any,
  });

  expect(result.status).toMatchObject({ kind: "done", outcome: "completed" });
  expect(createSessionManager).toHaveBeenCalledWith(
    process.cwd(),
    parentSession.slice(0, -".jsonl".length),
    { parentSession },
  );
  expect(resourceLoader.getSystemPrompt()).toContain("RESOURCE BODY");
  expect(resourceLoader.getSkills().skills).toEqual([]);
  expect(session.bindExtensions).not.toHaveBeenCalled();
});

test("loads requested skills from Pi's standard ~/.agents discovery path with shared trust settings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "subagent-native-skills-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "pi-agent");
  const skillDir = path.join(home, ".agents", "skills", "native-only");
  await mkdir(skillDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), "---\nname: native-only\ndescription: Native discovery\n---\n\nNATIVE BODY");
  process.env.HOME = home;

  let loaderSettings: any;
  let sessionSettings: any;
  let resourceLoader: any;
  class RecordingLoader extends DefaultResourceLoader {
    constructor(options: any) { super(options); loaderSettings = options.settingsManager; }
  }
  const agent = spawning(["native-only"]);
  const result = await executeRun({ cwd, modelRegistry: registry(), isProjectTrusted: () => true } as any, agent, agent.requireCurrentRun(), undefined, {
    ...DEFAULT_EXECUTE_RUN_DEPENDENCIES,
    ResourceLoader: RecordingLoader,
    getAgentDir: () => agentDir,
    settingsManager: SettingsManager.create,
    sessionManager: (() => ({})) as any,
    loadExtensionPaths: async () => [],
    createAgentSession: (async (options: any) => {
      sessionSettings = options.settingsManager;
      resourceLoader = options.resourceLoader;
      return { session: finishedSession() };
    }) as any,
  });

  expect(result.status).toMatchObject({ kind: "done", outcome: "completed" });
  expect(loaderSettings).toBe(sessionSettings);
  expect(loaderSettings.isProjectTrusted()).toBe(true);
  expect(resourceLoader.getSystemPrompt()).toContain("NATIVE BODY");
  await rm(root, { recursive: true, force: true });
});

test("validates extension-discovered skills after bindExtensions", async () => {
  const skill = { name: "late", filePath: "/skills/late/SKILL.md", baseDir: "/skills/late" };
  let skills: any[] = [];
  class ResourceLoader {
    async reload() {}
    getExtensions() { return { extensions: [{ handlers: new Map([["resources_discover", [{}]]]) }], errors: [], runtime: {} }; }
    getSkills() { return { skills, diagnostics: [] }; }
    getPrompts() { return { prompts: [], diagnostics: [] }; }
    getThemes() { return { themes: [], diagnostics: [] }; }
    getAgentsFiles() { return { agentsFiles: [] }; }
    getSystemPrompt() { return undefined; }
    getAppendSystemPrompt() { return []; }
    extendResources() {}
  }
  let resourceLoader: any;
  const session = finishedSession({ bindExtensions: async () => { skills = [skill]; } });
  const agent = spawning(["late"]);
  const result = await executeRun({ cwd: process.cwd(), modelRegistry: registry() } as any, agent, agent.requireCurrentRun(), undefined, {
    ...DEFAULT_EXECUTE_RUN_DEPENDENCIES,
    ResourceLoader: ResourceLoader as any,
    getAgentDir: () => "/tmp/pi-agent",
    settingsManager: (() => ({ setProjectTrusted() {} })) as any,
    sessionManager: (() => ({})) as any,
    loadExtensionPaths: async () => [],
    readSkillFile: (() => "---\nname: late\ndescription: test\n---\n\nLATE BODY") as any,
    createAgentSession: (async (options: any) => { resourceLoader = options.resourceLoader; return { session }; }) as any,
  });

  expect(result.status).toMatchObject({ kind: "done", outcome: "completed" });
  expect(resourceLoader.getSystemPrompt()).toContain("LATE BODY");
});

test("disposes a new session when an extension-discovered skill is still unavailable", async () => {
  const dispose = vi.fn();
  class ResourceLoader {
    async reload() {}
    getExtensions() { return { extensions: [{ handlers: new Map([["resources_discover", [{}]]]) }], errors: [], runtime: {} }; }
    getSkills() { return { skills: [], diagnostics: [] }; }
    getPrompts() { return { prompts: [], diagnostics: [] }; }
    getThemes() { return { themes: [], diagnostics: [] }; }
    getAgentsFiles() { return { agentsFiles: [] }; }
    getSystemPrompt() { return undefined; }
    getAppendSystemPrompt() { return []; }
    extendResources() {}
  }
  const agent = spawning(["missing"]);
  const result = await executeRun({ cwd: process.cwd(), modelRegistry: registry() } as any, agent, agent.requireCurrentRun(), undefined, {
    ...DEFAULT_EXECUTE_RUN_DEPENDENCIES,
    ResourceLoader: ResourceLoader as any,
    getAgentDir: () => "/tmp/pi-agent",
    settingsManager: (() => ({ setProjectTrusted() {} })) as any,
    sessionManager: (() => ({})) as any,
    loadExtensionPaths: async () => [],
    createAgentSession: (async () => ({ session: finishedSession({ dispose }) })) as any,
  });

  expect(result.status).toMatchObject({ kind: "done", outcome: "error", error: "Unknown skill: missing" });
  expect(dispose).toHaveBeenCalledOnce();
});

test.each([
  { label: "unknown", skills: [] as any[], read: () => "", error: "Unknown skill: missing" },
  { label: "unreadable", skills: [{ name: "missing", filePath: "/skills/missing/SKILL.md", baseDir: "/skills/missing" }], read: () => { throw new Error("permission denied"); }, error: "Could not load requested skill: permission denied" },
])("fails $label requested skills before prompting", async ({ skills, read, error }) => {
  let createCalled = false;
  class ResourceLoader {
    async reload() {}
    getExtensions() { return { extensions: [], errors: [], runtime: {} }; }
    getSkills() { return { skills, diagnostics: [] }; }
    getPrompts() { return { prompts: [], diagnostics: [] }; }
    getThemes() { return { themes: [], diagnostics: [] }; }
    getAgentsFiles() { return { agentsFiles: [] }; }
    getSystemPrompt() { return undefined; }
    getAppendSystemPrompt() { return []; }
    extendResources() {}
  }
  const agent = spawning(["missing"]);
  const result = await executeRun({ cwd: process.cwd(), modelRegistry: registry() } as any, agent, agent.requireCurrentRun(), undefined, {
    ...DEFAULT_EXECUTE_RUN_DEPENDENCIES,
    ResourceLoader: ResourceLoader as any,
    getAgentDir: () => "/tmp/pi-agent",
    settingsManager: (() => ({ setProjectTrusted() {} })) as any,
    sessionManager: (() => ({})) as any,
    loadExtensionPaths: async () => [],
    readSkillFile: read as any,
    createAgentSession: (async () => { createCalled = true; return { session: finishedSession() }; }) as any,
  });

  expect(result.status).toMatchObject({ kind: "done", outcome: "error", error });
  expect(createCalled).toBe(false);
});

test("assistant errors and prompt failures terminalize the run as errors", async () => {
  const modelError = resumable([{ role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "error", errorMessage: "model failed" }], async () => {});
  await expect(executeRun({} as any, modelError.agent, modelError.attempt)).resolves.toMatchObject({ status: { kind: "done", outcome: "error", error: "model failed" } });
  const thrown = resumable([], async () => { throw new Error("transport failed"); });
  await expect(executeRun({} as any, thrown.agent, thrown.attempt)).resolves.toMatchObject({ status: { kind: "done", outcome: "error", error: "transport failed" } });
});

test("cancellation aborts the SDK session and records interruption", async () => {
  let reject!: (error: Error) => void;
  const f = resumable([], () => new Promise<void>((_, r) => { reject = r; }));
  const controller = new AbortController();
  const result = executeRun({} as any, f.agent, f.attempt, controller.signal);
  await vi.waitFor(() => expect(reject).toBeTypeOf("function"));
  controller.abort(); reject(new Error("cancelled"));
  await expect(result).resolves.toMatchObject({ status: { kind: "done", outcome: "interrupted", error: "cancelled" } });
  expect(f.abort).toHaveBeenCalled();
});

function model(provider: string, id: string) {
  return { provider, id } as any;
}

function registry(...models: any[]) {
  return { getAll: () => models } as any;
}

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

  expect(resolveModel("openrouter/anthropic/claude-3-haiku", parent, registry(bareCollision, canonical))).toEqual({
    ok: true,
    value: canonical,
  });
});

test("treats the complete reference as a bare model ID when it is not canonical", () => {
  const slashId = model("gateway", "anthropic/claude-3-haiku");
  expect(resolveModel("anthropic/claude-3-haiku", undefined, registry(slashId))).toEqual({
    ok: true,
    value: slashId,
  });
});

test("uses the parent provider to disambiguate a bare model ID", () => {
  const parent = model("parent-provider", "parent-model");
  const preferred = model("parent-provider", "shared");
  const other = model("other-provider", "shared");

  expect(resolveModel("shared", parent, registry(other, preferred))).toEqual({ ok: true, value: preferred });
});

test("rejects an ambiguous bare model ID without a parent-provider match", () => {
  const first = model("first-provider", "shared");
  const second = model("second-provider", "shared");
  const parent = model("unmatched-provider", "parent-model");

  expect(resolveModel("shared", parent, registry(first, second))).toEqual({
    ok: false,
    error: "Ambiguous model \"shared\": matches first-provider/shared, second-provider/shared. Use a provider-qualified model reference.",
  });
});

test("inherits the parent model only when no model is requested", () => {
  const parent = model("parent-provider", "parent-model");
  expect(resolveModel(undefined, parent, registry())).toEqual({ ok: true, value: parent });
});

test.each([
  "",
  "   ",
  "/",
  "/model",
  "provider/",
  "provider//model",
])("rejects malformed model %j", requested => {
  expect(resolveModel(requested, undefined, registry())).toMatchObject({
    ok: false,
    error: expect.stringContaining("Invalid model"),
  });
});

test.each(["missing", "provider/missing", "provider/model/extra"])("rejects unknown model %j without falling back", requested => {
  const parent = model("parent-provider", "parent-model");
  expect(resolveModel(requested, parent, registry(parent))).toEqual({
    ok: false,
    error: `Unknown model: ${requested}`,
  });
});

test("does not reinterpret an unknown qualified reference as a different bare model ID", () => {
  const modelWithSameSuffix = model("known-provider", "known-model");
  expect(resolveModel("unknown-provider/known-model", undefined, registry(modelWithSameSuffix))).toEqual({
    ok: false,
    error: "Unknown model: unknown-provider/known-model",
  });
});

test("RunAttempt terminalizes an invalid requested model before session allocation", async () => {
  const parent = model("parent-provider", "parent-model");
  const invalidConfig = { ...config, model: "missing" };
  const agent = new Conversation("amber-acorn" as any, "adapt-ably" as any, invalidConfig, { kind: "spawn", agent: "worker", prompt: "first" }, () => {});

  await expect(executeRun({ cwd: "/unvalidated-parent", model: parent, modelRegistry: registry(parent) } as any, agent, agent.requireCurrentRun())).resolves.toMatchObject({
    status: { kind: "done", outcome: "error", error: "Unknown model: missing" },
  });
});

test("resolves and validates relative and absolute requested working directories", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "run-agent-cwd-"));
  const relative = path.join("nested", "task");
  const absolute = path.join(root, "absolute");
  await mkdir(path.join(root, relative), { recursive: true });
  await mkdir(absolute);

  expect(resolveTaskCwd(root, relative)).toEqual({ ok: true, value: path.join(root, relative) });
  expect(resolveTaskCwd(path.join(root, "unused"), absolute)).toEqual({ ok: true, value: absolute });
});

test("does not revalidate the inherited parent working directory", () => {
  const parentCwd = path.join(tmpdir(), "run-agent-parent-does-not-need-to-exist");
  expect(resolveTaskCwd(parentCwd, undefined)).toEqual({ ok: true, value: parentCwd });
});

test("rejects missing working directories and files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "run-agent-invalid-cwd-"));
  const missing = path.join(root, "missing");
  const file = path.join(root, "file.txt");
  await writeFile(file, "not a directory");

  expect(resolveTaskCwd(root, "missing")).toEqual({
    ok: false,
    error: `Working directory does not exist: ${missing}`,
  });
  expect(resolveTaskCwd(root, "file.txt")).toEqual({
    ok: false,
    error: `Working directory is not a directory: ${file}`,
  });
});


test("preserves cancellation during session creation and disposes the late session", async () => {
  let finishCreate!: (value: any) => void;
  const dispose = vi.fn();
  const createStarted = new Promise<void>(resolve => {
    finishCreate = value => { resolve(); return value; };
  });
  let resolveSession!: (value: any) => void;
  const pendingSession = new Promise<any>(resolve => { resolveSession = resolve; });
  class ResourceLoader {
    async reload() {}
    getExtensions() { return { extensions: [], errors: [], runtime: {} }; }
    getSkills() { return { skills: [], diagnostics: [] }; }
    getPrompts() { return { prompts: [], diagnostics: [] }; }
    getThemes() { return { themes: [], diagnostics: [] }; }
    getAgentsFiles() { return { agentsFiles: [] }; }
    getSystemPrompt() { return undefined; }
    getAppendSystemPrompt() { return []; }
    extendResources() {}
  }
  const agent = spawning([]);
  const execution = executeRun({ cwd: process.cwd(), modelRegistry: registry() } as any, agent, agent.requireCurrentRun(), undefined, {
    ...DEFAULT_EXECUTE_RUN_DEPENDENCIES,
    ResourceLoader: ResourceLoader as any,
    getAgentDir: () => "/tmp/pi-agent",
    settingsManager: (() => ({ setProjectTrusted() {} })) as any,
    sessionManager: (() => ({})) as any,
    loadExtensionPaths: async () => [],
    createAgentSession: (async () => { finishCreate(undefined); return pendingSession; }) as any,
  });

  await createStarted;
  await agent.abort("Run cancelled.");
  resolveSession({ session: finishedSession({ dispose }) });

  await expect(execution).resolves.toMatchObject({ status: { kind: "done", outcome: "aborted", error: "Run cancelled." } });
  expect(dispose).toHaveBeenCalledOnce();
});

test("deduplicates requested skills before injection", async () => {
  const skill = { name: "review", filePath: "/skills/review/SKILL.md", baseDir: "/skills/review" };
  let resourceLoader: any;
  class ResourceLoader {
    async reload() {}
    getExtensions() { return { extensions: [], errors: [], runtime: {} }; }
    getSkills() { return { skills: [skill], diagnostics: [] }; }
    getPrompts() { return { prompts: [], diagnostics: [] }; }
    getThemes() { return { themes: [], diagnostics: [] }; }
    getAgentsFiles() { return { agentsFiles: [] }; }
    getSystemPrompt() { return undefined; }
    getAppendSystemPrompt() { return []; }
    extendResources() {}
  }
  const agent = spawning(["review", "review"]);
  const result = await executeRun({ cwd: process.cwd(), modelRegistry: registry() } as any, agent, agent.requireCurrentRun(), undefined, {
    ...DEFAULT_EXECUTE_RUN_DEPENDENCIES,
    ResourceLoader: ResourceLoader as any,
    getAgentDir: () => "/tmp/pi-agent",
    settingsManager: (() => ({ setProjectTrusted() {} })) as any,
    sessionManager: (() => ({})) as any,
    loadExtensionPaths: async () => [],
    readSkillFile: (() => "---\nname: review\ndescription: test\n---\n\nREVIEW BODY") as any,
    createAgentSession: (async (options: any) => { resourceLoader = options.resourceLoader; return { session: finishedSession() }; }) as any,
  });

  expect(result.status).toMatchObject({ kind: "done", outcome: "completed" });
  expect(resourceLoader.getSystemPrompt().match(/<skill name="review"/g)).toHaveLength(1);
});
