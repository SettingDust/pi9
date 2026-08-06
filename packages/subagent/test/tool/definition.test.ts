import { test } from "vitest";
import assert from "node:assert/strict";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { SubagentRuntime } from "../../src/runtime.js";
import { defineSubagentTool } from "../../src/tool.js";

const settings = { runtime: { maxTasksPerCall: 1 }, display: {} } as any;
const registry = { agents: new Map(), summarizeAgent: () => "helper" } as any;
const runtime = new SubagentRuntime(registry);

const toolCall = (arguments_: Record<string, any>) => ({
  type: "toolCall" as const,
  id: "call",
  name: "subagent",
  arguments: arguments_,
});
const spawnBranch = (schema: any) => schema.properties.request.anyOf.find((branch: any) => branch.properties?.action?.enum?.includes("spawn"));
const validInvocations = [
  { action: "agents" },
  { action: "list", statuses: null, joined: null },
  { action: "spawn", spawns: [{ agent: "helper", prompt: "work", label: "Worker", skills: null, model: null, thinking: null, cwd: null }] },
  { action: "resume", resumes: [{ subagentId: "airy-acorn", prompt: "continue" }] },
  { action: "steer", messages: [{ subagentId: "airy-acorn", message: "adjust" }] },
  { action: "cancel", subagentIds: ["airy-acorn"] },
  { action: "inspect", subagentIds: ["airy-acorn"] },
  { action: "join", subagentIds: ["airy-acorn"] },
  { action: "remove", subagentIds: ["airy-acorn"] },
];

test("tool opts into provider-side constrained JSON-schema sampling", () => {
  const tool: any = defineSubagentTool({ runtime, agentRegistry: registry, prepareInvocation: async () => settings });
  assert.deepEqual(tool.constrainedSampling, { type: "json_schema", strict: "prefer" });
});
test("prompt guidelines discourage polling active subagents", () => {
  const tool: any = defineSubagentTool({ runtime, agentRegistry: registry, prepareInvocation: async () => settings });
  const guidelines = tool.promptGuidelines.join("\n");
  assert.match(guidelines, /After spawning or resuming active work, continue independent work or end the turn/);
  assert.match(guidelines, /do not repeatedly inspect, list, or join merely to poll/);
  assert.match(guidelines, /Inspect only when progress could change your next step/);
  assert.match(guidelines, /completion notification starts a new turn; then join that terminal subagent/);
});

test("published schema accepts every action's wrapped minimal invocation", () => {
  const tool: any = defineSubagentTool({ runtime, agentRegistry: registry, prepareInvocation: async () => settings });
  for (const invocation of validInvocations) {
    assert.doesNotThrow(() => validateToolArguments(tool, toolCall({ request: invocation })));
  }
});

test("SDK validation rejects a whole batch containing a malformed task", () => {
  const tool: any = defineSubagentTool({
    runtime,
    agentRegistry: registry,
    prepareInvocation: async () => ({ runtime: { maxTasksPerCall: 2 }, display: {} }) as any,
  });
  const raw = {
    request: {
      action: "spawn",
      spawns: [
        { agent: "helper", prompt: "malformed", extra: true },
        { agent: "helper", prompt: "valid" },
      ],
    },
  };

  assert.throws(() => validateToolArguments(tool, toolCall(raw)), /Validation failed/);
});

test("SDK validation leaves task-array minimum enforcement to the parser", () => {
  const tool: any = defineSubagentTool({
    runtime,
    agentRegistry: registry,
    prepareInvocation: async () => settings,
  });
  assert.doesNotThrow(
    () => validateToolArguments(tool, toolCall({ request: { action: "spawn", spawns: [] } })),
  );
});

test("definition can expose discovered agents and available models", () => {
  const tool: any = defineSubagentTool({
    runtime,
    agentRegistry: registry,
    prepareInvocation: async () => settings,
    agentNames: ["handler", "reviewer"],
    modelIds: ["provider/alpha"],
  });
  const spawn = spawnBranch(tool.parameters).properties.spawns.items;
  assert.deepEqual(spawn.properties.agent.enum, ["handler", "reviewer"]);
  assert.deepEqual(spawn.properties.model.anyOf.find((branch: any) => branch.enum)?.enum, ["provider/alpha"]);
});

test("execution normalizes nullable provider fields before parsing", async () => {
  const tool: any = defineSubagentTool({ runtime, agentRegistry: registry, prepareInvocation: async () => settings });
  const listed = await tool.execute("list", {
    request: { action: "list", statuses: null, joined: null },
  }, undefined, undefined, {});
  assert.deepEqual(listed.details.response, { action: "list", results: [] });

  const spawned = await tool.execute("spawn", {
    request: {
      action: "spawn",
      spawns: [{ agent: "missing", prompt: "work", label: "Worker", skills: null, model: null, thinking: null, cwd: null }],
    },
  }, undefined, undefined, { cwd: "/tmp", modelRegistry: { find: () => undefined } });
  assert.match(spawned.details.response.results[0].error, /Unknown agent/);
});

test("published schema rejects fields from another action", () => {
  const tool: any = defineSubagentTool({
    runtime,
    agentRegistry: registry,
    prepareInvocation: async () => settings,
  });
  assert.throws(
    () => validateToolArguments(tool, toolCall({
      request: {
        action: "spawn",
        spawns: [{ agent: "helper", prompt: "work", label: "Worker" }],
        joined: false,
      },
    })),
    /Validation failed/,
  );
});

test("tool prepares settings, applies task limits, and renders simple typed content", async () => {
  let prepared = 0;
  const tool: any = defineSubagentTool({ runtime, agentRegistry: registry, prepareInvocation: async () => { prepared++; return settings; } });
  const result = await tool.execute("call", {
    request: {
      action: "spawn",
      spawns: [
        { agent: "a", prompt: "1", label: "One" },
        { agent: "a", prompt: "2", label: "Two" },
      ],
    },
  }, undefined, undefined, {});
  assert.equal(prepared, 1);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    action: "spawn",
    error: "Too many tasks (2). Max is 1.\n\nAvailable agents:\nhelper",
  });
  assert.match(tool.renderResult(result, {}, {}).render(120).join("\n"), /Too many tasks/);
  assert.match(tool.renderCall({ request: { action: "spawn", spawns: [{}, {}] } }, {}, {}).render(120).join("\n"), /2 tasks/);
});

test("unknown actions return a structured global error envelope marked as an error", async () => {
  const tool: any = defineSubagentTool({
    runtime,
    agentRegistry: registry,
    prepareInvocation: async () => settings,
  });

  const result = await tool.execute("call", { request: { action: "bogus" } }, undefined, undefined, {});

  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    action: "unknown",
    error: 'Unknown action: bogus. Use "agents", "list", "spawn", "resume", "steer", "cancel", "inspect", "join", or "remove".',
  });
});

test("plausible unknown join IDs use not-found wording while malformed IDs remain invalid", async () => {
  const tool: any = defineSubagentTool({ runtime, agentRegistry: registry, prepareInvocation: async () => settings });
  const result = await tool.execute("call", { request: { action: "join", subagentIds: ["plausible-target", "ghost-silently", 42] } }, undefined, undefined, {});
  const response = JSON.parse(result.content[0].text);
  assert.equal(response.action, "join");
  assert.deepEqual(response.summary, { requested: 3, succeeded: 0, failed: 3 });
  assert.deepEqual(response.results, [
    { ok: false, subagentId: "plausible-target", error: "Subagent plausible-target was not found." },
    { ok: false, subagentId: "ghost-silently", error: "Subagent ghost-silently was not found." },
    { ok: false, subagentId: "42", error: "Invalid subagentId format: 42." },
  ]);
});

test("settings preparation failures propagate without starting manager work", async () => {
  let started = false;
  const tool: any = defineSubagentTool({ runtime: { startTasks: () => { started = true; } } as any, agentRegistry: registry, prepareInvocation: async () => { throw new Error("settings unavailable"); } });
  await assert.rejects(() => tool.execute("call", { request: { action: "agents" } }, undefined, undefined, {}), /settings unavailable/);
  assert.equal(started, false);
});
