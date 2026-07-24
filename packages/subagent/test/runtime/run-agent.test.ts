import { afterEach, test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

import { DefaultRunAgentDependencies, RunAttempt } from "../../src/runtime/run-agent.js";
import { Agent, type AgentUpdateListener } from "../../src/domain/agent.js";
import { toResult } from "../../src/domain/agent-result.js";

const noop: AgentUpdateListener = () => {};

const SAVED_TIMING = process.env.PI_SUBAGENT_DEBUG_TIMING;
const SAVED_TIMING_FILE = process.env.PI_SUBAGENT_DEBUG_TIMING_FILE;
const SAVED_HOME = process.env.HOME;
afterEach(() => {
  FakeResourceLoader.skills = [];
  if (SAVED_TIMING === undefined) delete process.env.PI_SUBAGENT_DEBUG_TIMING;
  else process.env.PI_SUBAGENT_DEBUG_TIMING = SAVED_TIMING;
  if (SAVED_TIMING_FILE === undefined) delete process.env.PI_SUBAGENT_DEBUG_TIMING_FILE;
  else process.env.PI_SUBAGENT_DEBUG_TIMING_FILE = SAVED_TIMING_FILE;
  if (SAVED_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = SAVED_HOME;
});

const baseConfig = {
  retainConversation: false,
  name: "helper",
  description: "d",
  systemPrompt: "s",
  source: "project" as const,
};

const baseCtx = (cwd: string = process.cwd()) => ({ cwd, modelRegistry: { getAll: () => [] } } as any);

class FakeResourceLoader {
  static skills: any[] = [];
  constructor(readonly options: any = {}) {}
  async reload() {}
  getExtensions(): any { return { extensions: [], errors: [], runtime: {} }; }
  getSkills(): any { return { skills: FakeResourceLoader.skills, diagnostics: [] }; }
  getPrompts() { return { prompts: [], diagnostics: [] }; }
  getThemes() { return { themes: [], diagnostics: [] }; }
  getAgentsFiles() { return { agentsFiles: [] }; }
  getSystemPrompt() { return undefined; }
  getAppendSystemPrompt() { return []; }
  extendResources(_paths: any) {}
}

const withSkills = (skills: any[]) => {
  FakeResourceLoader.skills = skills;
  return class extends FakeResourceLoader {};
};

const makeBaseDeps = (overrides: any = {}) => ({
  ResourceLoader: FakeResourceLoader,
  getAgentDir: () => "/tmp/pi-agent",
  createAgentSession: async () => ({ session: { messages: [{ role: "assistant", content: [{ type: "text", text: "final" }] }], subscribe: () => () => {}, prompt: async () => {}, abort: () => {} } }),
  sessionManager: (cwd: string) => ({ cwd }),
  settingsManager: (cwd: string, agentDir: string) => ({ cwd, agentDir }),
  readSkillFile: () => "---\nname: test\ndescription: Test skill\n---\n\nFull skill instructions.",
  loadExtensionPaths: async () => [],
  ...overrides,
});

test("run-agent skips before prompting when signal aborts during setup", async () => {
  const controller = new AbortController();
  let createCalled = false;
  let promptCalled = false;
  const session = {
    messages: [{ role: "assistant", content: [{ type: "text", text: "should not prompt" }] }],
    subscribe: () => () => {},
    prompt: async () => { promptCalled = true; },
    abort: () => {},
  };
  const dependencies = makeBaseDeps({
    ResourceLoader: class extends FakeResourceLoader { async reload() { controller.abort(); } },
    createAgentSession: async () => { createCalled = true; return { session }; },
  });
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work" }, noop);

  const result = toResult(await RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), controller.signal, dependencies));

  assert.equal(result.status, "skipped");
  assert.match(result.error ?? "", /Agent skipped/);
  assert.equal(createCalled, false);
  assert.equal(promptCalled, false);
  if (agent.status.kind !== "done") throw new Error("expected done");
  assert.equal(agent.status.outcome, "skipped");
});

test("run-agent fully cleans up when cancellation lands after session creation but before ownership", async () => {
  const controller = new AbortController();
  let abortCalls = 0;
  let disposeCalls = 0;
  let promptCalls = 0;
  const session = {
    messages: [] as any[],
    subscribe: () => () => {},
    prompt: async () => { promptCalls += 1; },
    abort: () => { abortCalls += 1; },
    dispose: () => { disposeCalls += 1; },
    bindExtensions: async () => { controller.abort(); },
  };
  const dependencies = makeBaseDeps({ createAgentSession: async () => ({ session }) });
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work" }, noop);

  const result = toResult(await RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), controller.signal, dependencies));

  assert.equal(result.status, "skipped");
  assert.equal(abortCalls, 1);
  assert.equal(disposeCalls, 1);
  assert.equal(promptCalls, 0);
  assert.equal(agent.retainedSession(), undefined);
});

test("run-agent resolves relative task cwd against context cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-cwd-"));
  let loaderOptions: any;
  let createOptions: any;
  const session = {
    messages: [{ role: "assistant", content: [{ type: "text", text: "final" }] }],
    subscribe: () => () => {},
    prompt: async () => {},
    abort: () => {},
  };
  const dependencies = makeBaseDeps({
    ResourceLoader: class extends FakeResourceLoader { constructor(options: any) { super(options); loaderOptions = options; } },
    createAgentSession: async (options: any) => { createOptions = options; return { session }; },
  });
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work", cwd: "nested/project" }, noop);

  await RunAttempt(baseCtx(root), agent, agent.requireCurrentAttempt(), undefined, dependencies);

  const expectedCwd = join(root, "nested/project");
  assert.equal(loaderOptions.cwd, expectedCwd);
  assert.equal(createOptions.cwd, expectedCwd);
  assert.equal(createOptions.sessionManager.cwd, expectedCwd);
  assert.equal(createOptions.settingsManager.cwd, expectedCwd);
  assert.equal("modelRegistry" in createOptions, false);
});

test("run-agent uses frontmatter thinking when task does not override it", async () => {
  let createOptions: any;
  const session = {
    messages: [{ role: "assistant", content: [{ type: "text", text: "final" }] }],
    subscribe: () => () => {},
    prompt: async () => {},
    abort: () => {},
  };
  const dependencies = makeBaseDeps({
    createAgentSession: async (options: any) => { createOptions = options; return { session }; },
  });
  const agent = new Agent("id", { ...baseConfig, name: "thinker", thinking: "high" }, { kind: "spawn", agent: "thinker", prompt: "work" }, noop);

  await RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), undefined, dependencies);

  assert.equal(createOptions.thinkingLevel, "high");
});

test("run-agent forwards configured tools allowlist to createAgentSession", async () => {
  let createOptions: any;
  const session = {
    messages: [{ role: "assistant", content: [{ type: "text", text: "final" }] }],
    subscribe: () => () => {},
    prompt: async () => {},
    abort: () => {},
  };
  const dependencies = makeBaseDeps({
    createAgentSession: async (options: any) => { createOptions = options; return { session }; },
  });
  const agent = new Agent(
    "id",
    { ...baseConfig, name: "limited", tools: ["read", "grep"], model: "model-a" },
    { kind: "spawn", agent: "limited", prompt: "work" }, noop,
  );

  const result = toResult(await RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), undefined, dependencies));

  assert.equal(result.output, "final");
  assert.deepEqual(createOptions.tools, ["read", "grep"]);
});

test("run-agent records the complete resolved effective config in snapshots and results", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-effective-config-"));
  const selectedModel = { provider: "test", id: "child-model" } as any;
  const session = {
    model: selectedModel,
    thinkingLevel: "high",
    getActiveToolNames: () => ["read", "subagent"],
    messages: [{ role: "assistant", content: [{ type: "text", text: "final" }] }],
    subscribe: () => () => {},
    prompt: async () => {},
    abort: () => {},
  };
  const dependencies = makeBaseDeps({ createAgentSession: async () => ({ session }) });
  const agent = new Agent(
    "id",
    { ...baseConfig, tools: ["read"], skills: ["default-skill"] },
    {
      kind: "spawn",
      agent: "helper",
      prompt: "work",
      model: "test/child-model",
      thinking: "high",
      cwd: "nested",
      skills: [],
    },
    noop,
  );
  const ctx = { cwd: root, modelRegistry: { getAll: () => [selectedModel] } } as any;

  const result = toResult(await RunAttempt(ctx, agent, agent.requireCurrentAttempt(), undefined, dependencies));

  const effectiveConfig = {
    model: "test/child-model",
    thinking: "high",
    cwd: join(root, "nested"),
    skills: [],
    tools: ["read", "subagent"],
  };
  assert.deepEqual(result.effectiveConfig, effectiveConfig);
  assert.deepEqual(agent.snapshot().effectiveConfig, effectiveConfig);
});

test("run-agent marks running parent cancellation as interrupted", async () => {
  const controller = new AbortController();
  let abortCalls = 0;
  let resolvePrompt: (() => void) | undefined;
  const session = {
    messages: [] as any[],
    subscribe: () => () => {},
    prompt: async () => { await new Promise<void>(resolve => { resolvePrompt = resolve; }); },
    abort: () => {
      abortCalls += 1;
      session.messages = [{ role: "assistant", stopReason: "aborted", errorMessage: "user cancelled", content: [{ type: "text", text: "partial" }] }];
      resolvePrompt?.();
    },
  };
  const dependencies = makeBaseDeps({ createAgentSession: async () => ({ session }) });
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work" }, noop);

  const pending = RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), controller.signal, dependencies);
  await new Promise(resolve => setTimeout(resolve, 20));
  const midKind: string = agent.status.kind;
  assert.equal(midKind, "running");

  controller.abort();

  const result = toResult(await pending);
  assert.equal(result.status, "interrupted");
  assert.match(result.error ?? "", /user cancelled/);
  assert.equal(abortCalls, 1);
  const final = agent.status;
  if (final.kind !== "done") throw new Error("expected done");
  assert.equal(final.outcome, "interrupted");
});

test("run-agent treats final assistant error stop reason as failed child run", async () => {
  const session = {
    messages: [{ role: "assistant", stopReason: "error", errorMessage: "model overloaded", content: [{ type: "text", text: "partial output" }] }],
    subscribe: () => () => {},
    prompt: async () => {},
    abort: () => {},
  };
  const dependencies = makeBaseDeps({ createAgentSession: async () => ({ session }) });
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work" }, noop);

  const result = toResult(await RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), undefined, dependencies));

  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /model overloaded/);
  if (agent.status.kind !== "done") throw new Error("expected done");
  assert.equal(agent.status.outcome, "error");
  assert.equal(agent.status.error, "model overloaded");
});

test("run-agent discovers requested skills through Pi standard resource loading", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-standard-skills-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  const agentDir = join(root, "pi-agent");
  const skillDir = join(home, ".agents", "skills", "standard-only");
  await mkdir(skillDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), "---\nname: standard-only\ndescription: Standard discovery regression\n---\n\nSTANDARD LOADER BODY");
  process.env.HOME = home;

  let loaderOptions: any;
  const dependencies = makeBaseDeps({
    ResourceLoader: class extends DefaultResourceLoader {
      constructor(options: any) { super(options); loaderOptions = options; }
    },
    getAgentDir: () => agentDir,
    settingsManager: SettingsManager.create,
    readSkillFile: readFileSync,
  });
  const agent = new Agent("id", { ...baseConfig, systemPrompt: "BASE" }, { kind: "spawn", agent: "helper", prompt: "work", skills: ["standard-only"] }, noop);

  const result = toResult(await RunAttempt(baseCtx(cwd), agent, agent.requireCurrentAttempt(), undefined, dependencies));

  assert.equal(result.status, "completed");
  assert.match(loaderOptions.settingsManager ? "shared" : "", /shared/);
  assert.equal(loaderOptions.noSkills, undefined);
  await rm(root, { recursive: true, force: true });
});

test("run-agent uses the injected production loader and shared trusted settings for standard skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-production-wiring-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const skillDir = join(agentDir, "skills", "wired");
  await mkdir(skillDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), "---\nname: wired\ndescription: wiring\n---\n\nWIRED BODY");

  let constructedSettings: any;
  let sessionSettings: any;
  let resourceLoader: any;
  class RecordingLoader extends DefaultRunAgentDependencies.ResourceLoader {
    constructor(options: any) { super(options); constructedSettings = options.settingsManager; }
  }
  const dependencies = {
    ...DefaultRunAgentDependencies,
    ResourceLoader: RecordingLoader,
    getAgentDir: () => agentDir,
    createAgentSession: async (options: any) => {
      sessionSettings = options.settingsManager;
      resourceLoader = options.resourceLoader;
      return makeBaseDeps().createAgentSession();
    },
    loadExtensionPaths: async () => [],
  };
  const ctx = { ...baseCtx(cwd), isProjectTrusted: () => true };
  const agent = new Agent("id", { ...baseConfig, systemPrompt: "BASE" }, { kind: "spawn", agent: "helper", prompt: "work", skills: ["wired"] }, noop);

  const result = toResult(await RunAttempt(ctx, agent, agent.requireCurrentAttempt(), undefined, dependencies));

  assert.equal(result.status, "completed");
  assert.equal(constructedSettings, sessionSettings);
  assert.equal(constructedSettings.isProjectTrusted(), true);
  assert.match(resourceLoader.getSystemPrompt(), /WIRED BODY/);
  await rm(root, { recursive: true, force: true });
});

test("run-agent validates skills after the Pi extension resources_discover lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-extension-skills-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const extensionPath = join(root, "skill-extension.ts");
  const skillDir = join(root, "extension-skills", "extension-only");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), "---\nname: extension-only\ndescription: extension lifecycle\n---\n\nEXTENSION BODY");
  await writeFile(extensionPath, `export default (pi) => pi.on("resources_discover", () => ({ skillPaths: [${JSON.stringify(join(root, "extension-skills"))}] }));`);

  let resourceLoader: any;
  const dependencies = {
    ...DefaultRunAgentDependencies,
    getAgentDir: () => agentDir,
    loadExtensionPaths: async () => [extensionPath],
    createAgentSession: async (options: any) => {
      resourceLoader = options.resourceLoader;
      const result = await DefaultRunAgentDependencies.createAgentSession(options);
      const session = result.session;
      return {
        ...result,
        session: {
          messages: [{ role: "assistant", content: [{ type: "text", text: "final" }] }],
          subscribe: () => () => {}, prompt: async () => {}, abort: () => session.abort(),
          bindExtensions: (bindings: any) => session.bindExtensions(bindings),
        },
      } as any;
    },
  };
  const agent = new Agent("id", { ...baseConfig, systemPrompt: "BASE" }, { kind: "spawn", agent: "helper", prompt: "work", skills: ["extension-only"] }, noop);

  const result = toResult(await RunAttempt(baseCtx(cwd), agent, agent.requireCurrentAttempt(), undefined, dependencies));

  assert.equal(result.status, "completed");
  assert.match(resourceLoader.getSystemPrompt(), /EXTENSION BODY/);
  await rm(root, { recursive: true, force: true });
});

test("run-agent disposes an unowned session when post-bind requested-skill setup fails", async () => {
  for (const failure of ["missing", "unreadable"] as const) {
    let disposeCalls = 0;
    const skill = { name: "late", filePath: "/skills/late/SKILL.md", baseDir: "/skills/late" };
    const extension = { handlers: new Map([["resources_discover", [{}]]]) };
    const session = {
      messages: [] as any[],
      subscribe: () => () => {}, prompt: async () => {}, abort: () => {},
      dispose: () => { disposeCalls += 1; },
      bindExtensions: async () => {
        if (failure === "unreadable") FakeResourceLoader.skills = [skill];
      },
    };
    const dependencies = makeBaseDeps({
      ResourceLoader: class extends FakeResourceLoader {
        getExtensions() { return { extensions: [extension], errors: [], runtime: {} }; }
      },
      createAgentSession: async () => ({ session }),
      readSkillFile: () => { throw new Error("permission denied"); },
    });
    const agent = new Agent(`id-${failure}`, baseConfig, { kind: "spawn", agent: "helper", prompt: "work", skills: ["late"] }, noop);

    const result = toResult(await RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), undefined, dependencies));

    assert.equal(result.status, "error", `${failure}: expected error`);
    assert.match(result.error ?? "", failure === "missing" ? /Unknown skill: late/ : /Could not load requested skill: permission denied/);
    assert.equal(disposeCalls, 1, `${failure}: expected session cleanup`);
  }
});

test("run-agent injects requested skill bodies into the system prompt and hides loader skill scanning", async () => {
  let resourceLoader: any;
  const session = {
    messages: [{ role: "assistant", content: [{ type: "text", text: "final" }] }],
    subscribe: () => () => {}, prompt: async () => {}, abort: () => {},
  };
  const skills = [
    { name: "tdd", description: "Test-driven development", filePath: "/skills/tdd/SKILL.md", baseDir: "/skills/tdd", disableModelInvocation: false },
    { name: "review", description: "Review pending changes", filePath: "/skills/review/SKILL.md", baseDir: "/skills/review", disableModelInvocation: true },
  ];
  const dependencies = makeBaseDeps({
    ResourceLoader: withSkills(skills),
    createAgentSession: async (options: any) => { resourceLoader = options.resourceLoader; return { session }; },
  });
  const agent = new Agent("id", { ...baseConfig, systemPrompt: "BASE PROMPT" }, { kind: "spawn", agent: "helper", prompt: "work", skills: ["tdd", "review"] }, noop);

  const result = toResult(await RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), undefined, dependencies));

  assert.equal(result.status, "completed");
  assert.deepEqual(resourceLoader.getSkills().skills, []);
  const prompt = resourceLoader.getSystemPrompt();
  assert.match(prompt, /^BASE PROMPT/);
  assert.match(prompt, /<skill name="tdd" location="\/skills\/tdd\/SKILL.md">/);
  assert.match(prompt, /References are relative to \/skills\/tdd\./);
  assert.match(prompt, /Full skill instructions\./);
  assert.doesNotMatch(prompt, /description: Test skill/);
  assert.match(prompt, /<skill name="review" location="\/skills\/review\/SKILL.md">/);
});

test("run-agent reports an unreadable requested skill as a failed run without starting a session", async () => {
  let createCalled = false;
  const skill = { name: "broken", filePath: "/skills/broken/SKILL.md", baseDir: "/skills/broken" };
  const dependencies = makeBaseDeps({
    ResourceLoader: withSkills([skill]),
    createAgentSession: async () => { createCalled = true; throw new Error("unexpected session"); },
    readSkillFile: () => { throw new Error("permission denied"); },
  });
  const agent = new Agent("id", { ...baseConfig, skills: ["broken"] }, { kind: "spawn", agent: "helper", prompt: "work" }, noop);

  const result = toResult(await RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), undefined, dependencies));

  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /Could not load requested skill: permission denied/);
  assert.equal(createCalled, false);
});

test("run-agent preflights readable skills even when extensions can discover more skills", async () => {
  let createCalled = false;
  const skill = { name: "broken", filePath: "/skills/broken/SKILL.md", baseDir: "/skills/broken" };
  const extension = { handlers: new Map([["resources_discover", [{}]]]) };
  const dependencies = makeBaseDeps({
    ResourceLoader: class extends FakeResourceLoader {
      getSkills() { return { skills: [skill], diagnostics: [] }; }
      getExtensions() { return { extensions: [extension], errors: [], runtime: {} }; }
    },
    createAgentSession: async () => { createCalled = true; throw new Error("unexpected session"); },
    readSkillFile: () => { throw new Error("permission denied"); },
  });
  const agent = new Agent("id", { ...baseConfig, skills: ["broken"] }, { kind: "spawn", agent: "helper", prompt: "work" }, noop);

  const result = toResult(await RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), undefined, dependencies));

  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /Could not load requested skill: permission denied/);
  assert.equal(createCalled, false);
});

test("run-agent reports an unknown skill from per-task or frontmatter sources as a failed run without starting a session", async () => {
  for (const source of ["per-task", "frontmatter"] as const) {
    let createCalled = false;
    const dependencies = makeBaseDeps({
      ResourceLoader: withSkills([]),
      createAgentSession: async () => { createCalled = true; throw new Error("unexpected session"); },
    });
    const agent = source === "per-task"
      ? new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work", skills: ["missing"] }, noop)
      : new Agent("id", { ...baseConfig, skills: ["missing"] }, { kind: "spawn", agent: "helper", prompt: "work" }, noop);

    const result = toResult(await RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), undefined, dependencies));

    assert.equal(result.status, "error", `${source}: expected error`);
    assert.match(result.error ?? "", /Unknown skill: missing/);
    assert.equal(createCalled, false);
  }
});

test("run-agent uses agent-frontmatter default skills when the task does not provide skills", async () => {
  let resourceLoader: any;
  const skill = { name: "foo", filePath: "/skills/foo/SKILL.md", baseDir: "/skills/foo" };
  const dependencies = makeBaseDeps({
    ResourceLoader: withSkills([skill]),
    createAgentSession: async (options: any) => { resourceLoader = options.resourceLoader; return makeBaseDeps().createAgentSession(); },
  });
  const agent = new Agent("id", { ...baseConfig, systemPrompt: "BASE PROMPT", skills: ["foo"] }, { kind: "spawn", agent: "helper", prompt: "work" }, noop);

  const result = toResult(await RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), undefined, dependencies));

  assert.equal(result.status, "completed");
  assert.match(resourceLoader.getSystemPrompt(), /<skill name="foo"/);
  assert.deepEqual(agent.snapshot().config.skills, ["foo"]);
});

test("run-agent per-task skills fully replace agent-frontmatter default skills", async () => {
  let resourceLoader: any;
  const skills = ["foo", "bar", "baz"].map(name => ({ name, filePath: `/skills/${name}/SKILL.md`, baseDir: `/skills/${name}` }));
  const dependencies = makeBaseDeps({
    ResourceLoader: withSkills(skills),
    createAgentSession: async (options: any) => { resourceLoader = options.resourceLoader; return makeBaseDeps().createAgentSession(); },
  });
  const agent = new Agent("id", { ...baseConfig, systemPrompt: "BASE", skills: ["foo", "baz"] }, { kind: "spawn", agent: "helper", prompt: "work", skills: ["bar"] }, noop);

  await RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), undefined, dependencies);

  const prompt = resourceLoader.getSystemPrompt();
  assert.match(prompt, /<skill name="bar"/);
  assert.doesNotMatch(prompt, /<skill name="foo"|<skill name="baz"/);
  assert.deepEqual(agent.snapshot().effectiveConfig?.skills, ["bar"]);
});

test("run-agent explicit empty per-task skills opts out of agent-frontmatter defaults", async () => {
  let resourceLoader: any;
  const dependencies = makeBaseDeps({
    createAgentSession: async (options: any) => { resourceLoader = options.resourceLoader; return makeBaseDeps().createAgentSession(); },
  });
  const agent = new Agent("id", { ...baseConfig, systemPrompt: "BASE PROMPT", skills: ["foo"] }, { kind: "spawn", agent: "helper", prompt: "work", skills: [] }, noop);

  await RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), undefined, dependencies);

  assert.equal(resourceLoader.getSystemPrompt(), "BASE PROMPT");
  assert.deepEqual(agent.snapshot().config.skills, []);
});

test("emits coarse async spans for an attempt but no per-step sync narration when timing is enabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-timing-"));
  const logFile = join(root, "timing.log");
  process.env.PI_SUBAGENT_DEBUG_TIMING = "1";
  process.env.PI_SUBAGENT_DEBUG_TIMING_FILE = logFile;

  const dependencies = makeBaseDeps();
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work" }, noop);

  await RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), undefined, dependencies);

  const log = await readFile(logFile, "utf8");
  // The retained spans wrap the genuinely variable-cost async work of an attempt.
  assert.match(log, /event=runAgent\.resourceLoader\.reload\b/);
  assert.match(log, /event=runAgent\.createAgentSession\b/);
  assert.match(log, /event=runAgent\.session\.prompt\b/);
  // The per-step sync narration and result-summary marks are dropped.
  for (const dropped of [
    "runAgent.start",
    "runAgent.resolveCwd",
    "runAgent.selectModel",
    "runAgent.newResourceLoader",
  ]) {
    assert.doesNotMatch(log, new RegExp(`event=${dropped.replace(/\./g, "\\.")}\\b`), `unexpected event ${dropped}`);
  }
  await rm(logFile, { force: true });
});

test("inherited paths load through the native extension loader", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-native-loader-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  const entry = join(root, "pi-ai-extension.ts");
  await writeFile(entry, `
    import { streamSimpleOpenAICodexResponses } from "@earendil-works/pi-ai";
    export default () => {
      if (typeof streamSimpleOpenAICodexResponses !== "function") {
        throw new Error("Expected exported helper was unavailable");
      }
    };
  `);

  let capturedLoader: any;
  const dependencies = makeBaseDeps({
    ResourceLoader: DefaultResourceLoader,
    settingsManager: (cwd: string, dir: string) => SettingsManager.create(cwd, dir),
    getAgentDir: () => agentDir,
    loadExtensionPaths: async () => [entry],
    createAgentSession: async (options: any) => {
      capturedLoader = options.resourceLoader;
      return {
        session: {
          messages: [{ role: "assistant", content: [{ type: "text", text: "final" }] }],
          subscribe: () => () => {},
          prompt: async () => {},
          abort: () => {},
        },
      };
    },
  });
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work" }, noop);

  await RunAttempt(baseCtx(root), agent, agent.requireCurrentAttempt(), undefined, dependencies);

  const loaded = capturedLoader.getExtensions();
  assert.equal(loaded.errors.length, 0, `loader reported errors: ${JSON.stringify(loaded.errors)}`);
  assert.ok(loaded.extensions.some((ext: any) => ext.resolvedPath === entry || ext.path === entry));
});

test("run-agent discovers inherited paths with the resolved cwd and agent dir for every child", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-path-args-"));
  const calls: Array<{ cwd: string; agentDir: string }> = [];
  const dependencies = makeBaseDeps({
    getAgentDir: () => "/tmp/agent-dir",
    loadExtensionPaths: async (cwd: string, agentDir: string) => {
      calls.push({ cwd, agentDir });
      return [];
    },
  });

  for (let i = 0; i < 2; i++) {
    const agent = new Agent(`id-${i}`, baseConfig, { kind: "spawn", agent: "helper", prompt: "work", cwd: "child" }, noop);
    await RunAttempt(baseCtx(root), agent, agent.requireCurrentAttempt(), undefined, dependencies);
  }

  assert.deepEqual(calls, [
    { cwd: join(root, "child"), agentDir: "/tmp/agent-dir" },
    { cwd: join(root, "child"), agentDir: "/tmp/agent-dir" },
  ]);
});

test("run-agent passes inherited paths to a noExtensions resource loader", async () => {
  let loaderOptions: any;
  const inheritedPaths = ["/tmp/extensions/one.ts", "/tmp/extensions/two.ts"];
  const dependencies = makeBaseDeps({
    ResourceLoader: class extends FakeResourceLoader { constructor(options: any) { super(options); loaderOptions = options; } },
    loadExtensionPaths: async () => inheritedPaths,
  });
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work" }, noop);

  await RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), undefined, dependencies);

  assert.equal(loaderOptions.noExtensions, true);
  assert.deepEqual(loaderOptions.additionalExtensionPaths, inheritedPaths);
  assert.equal(loaderOptions.extensionFactories, undefined);
});

test("run-agent passes the manager-supplied child tool through createAgentSession.customTools", async () => {
  let createOptions: any;
  let childToolArg: any;
  const childTool = { name: "subagent" };
  const dependencies = makeBaseDeps({
    createAgentSession: async (options: any) => {
      createOptions = options;
      return { session: { messages: [{ role: "assistant", content: [{ type: "text", text: "final" }] }], subscribe: () => () => {}, prompt: async () => {}, abort: () => {} } };
    },
    childToolFor: (agent: any) => { childToolArg = agent; return childTool; },
  });
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work" }, noop);

  await RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), undefined, dependencies);

  assert.deepEqual(createOptions.customTools, [childTool]);
  assert.equal(childToolArg, agent);
});

test("run-agent passes no custom child tools when childToolFor is absent", async () => {
  let createOptions: any;
  const dependencies = makeBaseDeps({
    createAgentSession: async (options: any) => {
      createOptions = options;
      return { session: { messages: [{ role: "assistant", content: [{ type: "text", text: "final" }] }], subscribe: () => () => {}, prompt: async () => {}, abort: () => {} } };
    },
  });
  const agent = new Agent("id", baseConfig, { kind: "spawn", agent: "helper", prompt: "work" }, noop);

  await RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), undefined, dependencies);

  assert.deepEqual(createOptions.customTools, []);
});

test("run-agent leaves the system prompt unchanged when no skills are requested", async () => {
  let resourceLoader: any;
  const session = {
    messages: [{ role: "assistant", content: [{ type: "text", text: "final" }] }],
    subscribe: () => () => {},
    prompt: async () => {},
    abort: () => {},
  };
  const dependencies = makeBaseDeps({
    createAgentSession: async (options: any) => { resourceLoader = options.resourceLoader; return { session }; },
  });
  const agent = new Agent("id", { ...baseConfig, systemPrompt: "BASE PROMPT" }, { kind: "spawn", agent: "helper", prompt: "work" }, noop);

  await RunAttempt(baseCtx(), agent, agent.requireCurrentAttempt(), undefined, dependencies);

  assert.equal(resourceLoader.getSystemPrompt(), "BASE PROMPT");
});
