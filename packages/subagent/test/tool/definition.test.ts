import { test } from "vitest";
import assert from "node:assert/strict";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { prepareSubagentInvocationArguments } from "../../src/schema.js";
import { defineSubagentTool, makeChildSubagentTool } from "../../src/tool.js";

const settings = { runtime: { maxTasksPerRun: 1 }, display: {} } as any;
const registry = { agents: new Map(), summarizeAgent: () => "helper" } as any;

test("definition enables strict-preferred constrained sampling for every typed action", () => {
  const tool = defineSubagentTool({ runtime: {} as any, agentRegistry: registry, prepareInvocation: async () => settings });
  assert.deepEqual(tool.constrainedSampling, { type: "json_schema", strict: "prefer" });
  assert.deepEqual(tool.parameters.required, ["action", "status", "spawns", "resumes", "messages", "runIds", "conversationIds"]);
  for (const args of [
    { action: "agents" },
    { action: "list", status: ["running"] },
    { action: "spawn", spawns: [{ agent: "helper", prompt: "work" }] },
    { action: "resume", resumes: [{ conversationId: "amber-acorn", prompt: "continue" }] },
    { action: "steer", messages: [{ runId: "adapt-ably", message: "redirect" }] },
    { action: "cancel", runIds: ["adapt-ably"] },
    { action: "inspect", runIds: ["adapt-ably"] },
    { action: "join", runIds: ["adapt-ably"] },
    { action: "remove", conversationIds: ["amber-acorn"] },
  ]) validateToolArguments(tool, toolCall(prepareSubagentInvocationArguments(args)));

  const [converted] = convertResponsesTools([tool], { supportsStrictMode: true }) as any[];
  assert.equal(converted.strict, true);
  assert.equal(converted.parameters.additionalProperties, false);
  assert.deepEqual([...converted.parameters.required].sort(), Object.keys(converted.parameters.properties).sort());
  const assertStrictObjects = (schema: any): void => {
    if (!schema || typeof schema !== "object") return;
    if (schema.type === "object") {
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual([...(schema.required ?? [])].sort(), Object.keys(schema.properties ?? {}).sort());
    }
    for (const value of Object.values(schema)) {
      if (Array.isArray(value)) value.forEach(assertStrictObjects);
      else assertStrictObjects(value);
    }
  };
  assertStrictObjects(converted.parameters);
  for (const property of ["spawns", "resumes", "messages"]) {
    const array = converted.parameters.properties[property].anyOf.find((branch: any) => branch.type === "array");
    assert.equal(array.items.type, "object");
  }
  assert.throws(
    () => validateToolArguments(tool, toolCall(prepareSubagentInvocationArguments({ action: "spawn", spawns: ["not-an-object"] }))),
    /Validation failed/,
  );
});

test("root and child tools share constrained sampling and input preparation", () => {
  const root = defineSubagentTool({ runtime: {} as any, agentRegistry: registry, prepareInvocation: async () => settings });
  const child = makeChildSubagentTool({
    manager: {} as any,
    registry,
    parent: { conversationId: "amber-acorn", requireCurrentRun: () => ({ runId: "adapt-ably" }) } as any,
    getCurrentSettings: () => settings,
  });
  assert.deepEqual(child.parameters, root.parameters);
  assert.deepEqual(child.constrainedSampling, root.constrainedSampling);
  assert.deepEqual(child.prepareArguments?.({ action: "agents" }), root.prepareArguments?.({ action: "agents" }));
});

test("description names typed action inputs without restating task unions", () => {
  const tool = defineSubagentTool({
    runtime: {} as any,
    agentRegistry: registry,
    prepareInvocation: async () => settings,
  });
  const description = tool.description;
  assert.match(description, /Conversation IDs use adjective-noun form; run IDs use verb-adverb form\./);
  assert.match(description, /list\(status\?\).*matching a status/);
  assert.match(description, /spawn\(spawns\)/);
  assert.match(description, /resume\(resumes\)/);
  assert.match(description, /steer\(messages\)/);
  assert.match(description, /cancel\(runIds\)/);
  assert.match(description, /inspect\(runIds\)/);
  assert.match(description, /join\(runIds\)/);
  assert.match(description, /remove\(conversationIds\).*Surviving children are reparented/);
  assert.doesNotMatch(description, /Spawn:|Resume:|Steer:|union/);
  assert.match(description, /inspect\(runIds\): Check run status and progress without waiting/);
  assert.match(description, /join\(runIds\): Return full outcomes for terminal runs/);
  assert.match(description, /completion notifications.*prefer notifications over using join as a generic wait/);
  const guidelines = tool.promptGuidelines?.join("\n") ?? "";
  assert.match(guidelines, /completion notifications.*joining active runs just to wait/);
  assert.match(guidelines, /inspect only when status could affect your next step/);
  assert.match(guidelines, /join when you need a terminal run's full outcome/);
  assert.match(guidelines, /resume its conversationId for follow-up or correction/);
  const properties = (tool.parameters as any).properties;
  const nonNull = (schema: any) => schema.anyOf.find((branch: any) => branch.type !== "null");
  assert.deepEqual(Object.keys(properties), ["action", "status", "spawns", "resumes", "messages", "runIds", "conversationIds"]);
  assert.match(nonNull(properties.spawns).items.description, /agent.*prompt/);
  assert.match(nonNull(properties.resumes).items.description, /conversationId.*prompt/);
  assert.match(nonNull(properties.messages).items.description, /runId.*message/);
});

const toolCall = (arguments_: Record<string, any>) => ({
  type: "toolCall" as const,
  id: "call",
  name: "subagent",
  arguments: arguments_,
});

test("malformed batch items remain isolated so valid siblings still start", async () => {
  const started: unknown[] = [];
  const tool: any = defineSubagentTool({
    runtime: {
      startRun: (_ctx: unknown, tasks: unknown[]) => {
        started.push(...tasks);
        return { starts: tasks.map((_task, inputIndex) => ({ ok: true, inputIndex, conversationId: "amber-acorn", runId: "adapt-ably" })) };
      },
    } as any,
    agentRegistry: registry,
    prepareInvocation: async () => ({ runtime: { maxTasksPerRun: 2 }, display: {} }) as any,
  });
  const raw = {
    action: "spawn",
    spawns: [
      { agent: "helper", prompt: "" },
      { agent: "helper", prompt: "valid" },
    ],
  };

  const arguments_ = validateToolArguments(tool, toolCall(prepareSubagentInvocationArguments(raw)));
  const result = await tool.execute("call", arguments_, undefined, undefined, {});
  assert.deepEqual(started, [{ kind: "spawn", agent: "helper", prompt: "valid" }]);
  assert.equal(JSON.parse(result.content[0].text).results[0].ok, false);
  assert.equal(JSON.parse(result.content[0].text).results[1].ok, true);
});

test("SDK validation enforces the task-array minimum", () => {
  const tool: any = defineSubagentTool({
    runtime: {} as any,
    agentRegistry: registry,
    prepareInvocation: async () => settings,
  });
  assert.throws(
    () => validateToolArguments(tool, toolCall({ action: "spawn", spawns: [] })),
    /Validation failed/,
  );
});

test("tool prepares settings, applies task limits, and renders simple typed content", async () => {
  let prepared = 0;
  const tool: any = defineSubagentTool({ runtime: {} as any, agentRegistry: registry, prepareInvocation: async () => { prepared++; return settings; } });
  const result = await tool.execute("call", { action: "spawn", spawns: [{ agent: "a", prompt: "1" }, { agent: "a", prompt: "2" }] }, undefined, undefined, {});
  assert.equal(prepared, 1);
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    action: "spawn",
    error: "Too many tasks (2). Max is 1.\n\nAvailable agents:\nhelper",
  });
  assert.match(tool.renderResult(result, {}, {}).render(120).join("\n"), /Too many tasks/);
  assert.match(tool.renderCall({ action: "spawn", spawns: [{}, {}] }, {}, {}).render(120).join("\n"), /2 tasks/);
});

test("unknown actions return a structured global error envelope", async () => {
  const tool: any = defineSubagentTool({
    runtime: {} as any,
    agentRegistry: registry,
    prepareInvocation: async () => settings,
  });

  const result = await tool.execute("call", { action: "bogus" }, undefined, undefined, {});

  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    action: "unknown",
    error: 'Unknown action: bogus. Use "agents", "list", "spawn", "resume", "steer", "cancel", "inspect", "join", or "remove".',
  });
});

test("mixed join target errors remain ordered item failures", async () => {
  const tool: any = defineSubagentTool({ runtime: {} as any, agentRegistry: registry, prepareInvocation: async () => settings });
  const result = await tool.execute("call", { action: "join", runIds: ["valid-run", 42] }, undefined, undefined, {});
  assert.equal(result.isError, false);
  const response = JSON.parse(result.content[0].text);
  assert.equal(response.action, "join");
  assert.deepEqual(response.results, [
    { ok: false, runId: "valid-run", error: "join received invalid runId format 'valid-run'." },
    { ok: false, runId: "42", error: "join received invalid runId format '42'." },
  ]);
});

test("settings preparation failures propagate without starting manager work", async () => {
  let started = false;
  const tool: any = defineSubagentTool({ runtime: { startRun: () => { started = true; } } as any, agentRegistry: registry, prepareInvocation: async () => { throw new Error("settings unavailable"); } });
  await assert.rejects(() => tool.execute("call", { action: "agents" }, undefined, undefined, {}), /settings unavailable/);
  assert.equal(started, false);
});
