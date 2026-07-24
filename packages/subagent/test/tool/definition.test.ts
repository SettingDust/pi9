import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";
import subagentExtension from "../../src/index.js";
import { parseSubagentInvocation, prepareSubagentInvocationArguments } from "../../src/schema.js";
import { defineSubagentTool, makeChildSubagentTool } from "../../src/tool.js";

const settings = { runtime: { maxTasksPerRun: 1 }, display: {} } as any;
const registry = { agents: new Map(), summarizeAgent: () => "helper" } as any;

test("definition opts into Pi JSON-schema constrained sampling", () => {
  const tool = defineSubagentTool({
    runtime: {} as any,
    agentRegistry: registry,
    prepareInvocation: async () => settings,
  });
  assert.deepEqual(tool.constrainedSampling, { type: "json_schema", strict: "prefer" });
  assert.equal(tool.parameters.type, "object");
  assert.deepEqual(tool.parameters.required, ["action", "status", "tasks", "runIds", "conversationIds"]);
});

test("the registered root Pi wrapper forwards constrained sampling", async () => {
  let registered: any;
  const runtime = {
    scheduler: { setChildTool: () => {} },
    configure: () => {},
    listConversations: () => [],
    onConversationUpdate: () => () => {},
  };
  subagentExtension({
    on: () => {},
    registerTool: (definition: any) => { registered = definition; },
    registerCommand: () => {},
  } as any, {
    runtime: runtime as any,
    agentRegistry: { agents: new Map(), reload: async () => {} } as any,
    settingsStore: { load: async () => ({ settings }), save: async () => {} },
  });

  const { wrapRegisteredTool } = await import(new URL(
    "../../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/wrapper.js",
    import.meta.url,
  ).href);
  const wrapped = wrapRegisteredTool(
    { definition: registered },
    { createContext: () => ({}), getActiveTools: () => [] } as any,
  );

  assert.deepEqual(wrapped.constrainedSampling, { type: "json_schema", strict: "prefer" });
});

test("strict schema admits every legal action after host preparation", () => {
  const tool = defineSubagentTool({ runtime: {} as any, agentRegistry: registry, prepareInvocation: async () => settings });
  for (const args of [
    { action: "agents" },
    { action: "list", status: ["running"] },
    { action: "run", tasks: [{ agent: "helper", prompt: "work" }] },
    { action: "run", tasks: [{ conversationId: "amber-acorn", prompt: "continue" }] },
    { action: "join", runIds: ["adapt-ably"] },
    { action: "remove", conversationIds: ["amber-acorn"] },
  ]) validateToolArguments(tool, toolCall(prepareSubagentInvocationArguments(args)));
});

test("parser rejects fields from other action branches after host validation", () => {
  for (const args of [
    { action: "agents", status: ["running"] },
    { action: "list", runIds: ["adapt-ably"] },
    { action: "join", conversationIds: ["amber-acorn"] },
    { action: "remove", runIds: ["adapt-ably"] },
  ]) {
    const parsed = parseSubagentInvocation(prepareSubagentInvocationArguments(args));
    assert.ok("error" in parsed);
  }
});

test("OpenAI strict-tool conversion receives a strict-compatible object schema", () => {
  const tool = defineSubagentTool({ runtime: {} as any, agentRegistry: registry, prepareInvocation: async () => settings });
  const [converted] = convertResponsesTools([tool], { supportsStrictMode: true }) as any[];
  const schema = converted.parameters;

  assert.equal(converted.strict, true);
  assert.equal(schema.type, "object");
  assert.equal("anyOf" in schema, false);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
  assert.deepEqual(schema.properties.action.enum, ["agents", "list", "run", "join", "remove"]);
  for (const field of ["status", "tasks", "runIds", "conversationIds"]) {
    assert.ok(schema.properties[field].anyOf.some((branch: any) => branch.type === "null"));
  }
});

test("root and child tools share identical input constraints", () => {
  const root = defineSubagentTool({ runtime: {} as any, agentRegistry: registry, prepareInvocation: async () => settings });
  const child = makeChildSubagentTool({
    manager: {} as any,
    registry,
    parent: { conversationId: "amber-acorn", requireCurrentRun: () => ({ runId: "adapt-ably" }) } as any,
    getCurrentSettings: () => settings,
  });
  assert.deepEqual(child.parameters, root.parameters);
  assert.deepEqual(child.constrainedSampling, root.constrainedSampling);
});

const toolCall = (arguments_: Record<string, any>) => ({
  type: "toolCall" as const,
  id: "call",
  name: "subagent",
  arguments: arguments_,
});

test("SDK validation keeps malformed run tasks isolated so valid siblings start", async () => {
  let received: unknown;
  const tool: any = defineSubagentTool({
    runtime: {
      startRun: (_ctx: unknown, tasks: unknown) => {
        received = tasks;
        return {
          starts: [{ ok: true, inputIndex: 0, conversationId: "amber-acorn", runId: "adapt-ably" }],
          completion: Promise.resolve(),
        };
      },
    } as any,
    agentRegistry: registry,
    prepareInvocation: async () => ({ runtime: { maxTasksPerRun: 2 }, display: {} }) as any,
  });
  const raw = {
    action: "run",
    tasks: [
      { agent: "helper", prompt: "malformed", extra: true },
      { agent: "helper", prompt: "valid" },
    ],
  };
  const arguments_ = validateToolArguments(tool, toolCall(prepareSubagentInvocationArguments(raw)));
  const parsed = parseSubagentInvocation(arguments_, { maxTasks: 2 });

  assert.deepEqual(parsed, {
    action: "run",
    tasks: [
      { error: "Task property extra is not allowed for a spawn task." },
      { kind: "spawn", agent: "helper", prompt: "valid" },
    ],
  });
  const result = await tool.execute("call", arguments_, undefined, undefined, {});
  assert.deepEqual(received, [{ kind: "spawn", agent: "helper", prompt: "valid" }]);
  assert.deepEqual(JSON.parse(result.content[0].text), [
    { ok: false, inputIndex: 0, error: "Task property extra is not allowed for a spawn task." },
    { ok: true, inputIndex: 1, conversationId: "amber-acorn", runId: "adapt-ably" },
  ]);
});

test("SDK validation enforces the task-array minimum", () => {
  const tool: any = defineSubagentTool({
    runtime: {} as any,
    agentRegistry: registry,
    prepareInvocation: async () => settings,
  });
  assert.throws(
    () => validateToolArguments(tool, toolCall(prepareSubagentInvocationArguments({ action: "run", tasks: [] }))),
    /Validation failed/,
  );
});

test("child production session wrapper forwards constrained sampling", async () => {
  let childFactory: ((parent: unknown) => unknown) | undefined;
  const runtime = {
    scheduler: { setChildTool: (factory: (parent: unknown) => unknown) => { childFactory = factory; } },
    configure: () => {},
    listConversations: () => [],
    onConversationUpdate: () => () => {},
  };
  subagentExtension({
    on: () => {},
    registerTool: () => {},
    registerCommand: () => {},
  } as any, {
    runtime: runtime as any,
    agentRegistry: { agents: new Map(), reload: async () => {} } as any,
    settingsStore: { load: async () => ({ settings }), save: async () => {} },
  });
  assert.ok(childFactory);
  const child = childFactory({
    conversationId: "amber-acorn",
    requireCurrentRun: () => ({ runId: "adapt-ably" }),
  }) as any;
  const { createAgentSession, SessionManager } = await import("@earendil-works/pi-coding-agent");
  const cwd = await mkdtemp(join(tmpdir(), "pi9-subagent-"));
  try {
    const { session } = await createAgentSession({
      cwd,
      agentDir: cwd,
      sessionManager: SessionManager.inMemory(cwd),
      customTools: [child],
      tools: ["subagent"],
    });
    assert.deepEqual(session.agent.state.tools[0]?.constrainedSampling, { type: "json_schema", strict: "prefer" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("tool prepares settings, applies task limits, and renders simple typed content", async () => {
  let prepared = 0;
  const tool: any = defineSubagentTool({ runtime: {} as any, agentRegistry: registry, prepareInvocation: async () => { prepared++; return settings; } });
  const result = await tool.execute("call", { action: "run", tasks: [{ agent: "a", prompt: "1" }, { agent: "a", prompt: "2" }] }, undefined, undefined, {});
  assert.equal(prepared, 1); assert.equal(result.isError, true); assert.match(result.content[0].text, /Too many tasks/);
  assert.match(tool.renderResult(result, {}, {}).render(120).join("\n"), /Too many tasks/);
  assert.match(tool.renderCall({ action: "run", tasks: [{}, {}] }, {}, {}).render(120).join("\n"), /2 tasks/);
});

test("rejected mixed join releases every valid requested claim", async () => {
  let released: readonly string[] = [];
  const tool: any = defineSubagentTool({ runtime: {} as any, agentRegistry: registry, prepareInvocation: async () => settings, releaseJoinClaims: ids => { released = ids; } });
  const result = await tool.execute("call", { action: "join", runIds: ["valid-run", 42] }, undefined, undefined, {});
  assert.equal(result.isError, true);
  assert.deepEqual(released, ["valid-run"]);
});

test("settings preparation failures propagate without starting manager work", async () => {
  let started = false;
  const tool: any = defineSubagentTool({ runtime: { startRun: () => { started = true; } } as any, agentRegistry: registry, prepareInvocation: async () => { throw new Error("settings unavailable"); } });
  await assert.rejects(() => tool.execute("call", { action: "agents" }, undefined, undefined, {}), /settings unavailable/);
  assert.equal(started, false);
});
