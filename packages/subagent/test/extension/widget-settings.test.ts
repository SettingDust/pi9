import { expect, test, vi } from "vitest";

import subagentExtension, { availableModelIds } from "../../src/index.js";
import { completedGeneration } from "../../src/conversation.js";
import { SubagentRuntime } from "../../src/runtime.js";
import { createDefaultSubagentSettings } from "../../src/settings.js";
import { fakeAgent } from "../helpers/fake-agent.js";

test("extension reconciles current completion messages at the provider context boundary", async () => {
  const config = { name: "worker", description: "", systemPrompt: "", source: "project" } as any;
  const agentRegistry = { agents: new Map([["worker", config]]), reload: async () => {} } as any;
  const runtime = new SubagentRuntime(agentRegistry, 1, async (_ctx, agent, generation) => {
    agent.bindSession(generation, { messages: [], subscribe: () => () => {}, abort() {} } as any);
    return completedGeneration(agent, generation, "done");
  });
  const started = runtime.startTasks(
    { cwd: "/tmp", modelRegistry: { find: () => undefined } } as any,
    [{ kind: "spawn", agent: "worker", prompt: "work", label: "work" }] as any,
  );
  await started.completion;

  const handlers = new Map<string, Array<(event: any, ctx?: any) => any>>();
  const sent: any[] = [];
  subagentExtension({
    on: (event: string, handler: (event: any, ctx?: any) => any) => {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
    sendMessage: (message: any) => { sent.push(message); },
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
  } as any, {
    runtime,
    agentRegistry,
    settingsStore: { load: async () => ({ settings: createDefaultSubagentSettings() }), save: async () => {} },
  });

  const notifierContext = { isIdle: () => true };
  for (const handler of handlers.get("session_start") ?? []) handler({}, notifierContext);
  await vi.waitFor(() => expect(sent).toHaveLength(1));

  const completion = { role: "custom", ...sent[0] };
  const reconcile = handlers.get("context")?.[0];
  expect(reconcile?.({ messages: [completion] })).toEqual({ messages: [completion] });

  const subagentId = (started.starts[0] as any).conversationId;
  const binding = runtime.bindSubagentJoin([subagentId]);
  await binding.completion;
  binding.markJoined();
  binding.release();
  expect(reconcile?.({ messages: [completion] })).toEqual({ messages: [] });

  for (const handler of handlers.get("session_shutdown") ?? []) handler({}, notifierContext);
});

test("loading settings for a tool invocation refreshes the visible widget", async () => {
  let tool: any;
  const runtime = {
    scheduler: { setChildTool: vi.fn(), setChildSessionEvent: vi.fn() },
    configure: vi.fn(),
    listConversations: () => [fakeAgent({ status: { kind: "running", startedAt: 1 } })],
    onConversationUpdate: () => () => {},
  };
  const agentRegistry = { agents: new Map(), reload: async () => {} };
  const settings = createDefaultSubagentSettings();
  const setWidget = vi.fn();
  subagentExtension({
    on: vi.fn(),
    registerTool: (definition: any) => { tool = definition; },
    registerCommand: vi.fn(),
  } as any, {
    runtime: runtime as any,
    agentRegistry: agentRegistry as any,
    settingsStore: { load: async () => ({ settings }), save: async () => {} },
  });

  await tool.execute("call", { action: "agents" }, undefined, undefined, {
    cwd: "/tmp",
    hasUI: true,
    ui: { setWidget },
  });

  expect(setWidget).toHaveBeenCalledWith("subagent", expect.any(Function), { placement: "belowEditor" });
});
const spawnBranch = (schema: any) => schema.anyOf.find((branch: any) => branch.properties?.action?.enum?.includes("spawn"));

test("session start refreshes agent and model schema", async () => {
  const handlers = new Map<string, Function[]>();
  const tools: any[] = [];
  subagentExtension({
    on: vi.fn((event: string, handler: Function) => handlers.set(event, [...(handlers.get(event) ?? []), handler])),
    registerTool: (definition: any) => tools.push(definition),
    registerCommand: vi.fn(),
  } as any, {
    runtime: { scheduler: { setChildTool: vi.fn(), setChildSessionEvent: vi.fn() }, configure: vi.fn(), onConversationUpdate: () => () => {}, listConversations: () => [] } as any,
    agentRegistry: { agents: new Map(), reload: async function () { this.agents.set("handler", {}); } } as any,
    settingsStore: { load: async () => ({ settings: createDefaultSubagentSettings() }), save: async () => {} },
  });

  const available = [{ provider: "all", id: "fallback" }];
  const scopedModels = [{ model: { provider: "scope", id: "alpha" } }, { model: { provider: "scope", id: "alpha" } }];
await handlers.get("session_start")?.at(-1)?.({}, { cwd: "/tmp", hasUI: false, ui: {}, scopedModels, modelRegistry: { getAvailable: () => available } });

  expect(tools).toHaveLength(2);
  const initialSpawn = spawnBranch(tools[0].parameters).properties.spawns.items;
  const refreshedSpawn = spawnBranch(tools[1].parameters).properties.spawns.items;
  expect(initialSpawn.properties.model.type).toBe("string");
  expect(refreshedSpawn.properties.model.enum).toEqual(["scope/alpha"]);
  expect(refreshedSpawn.properties.agent.enum).toEqual(["handler"]);
  expect(availableModelIds({ scopedModels: [], modelRegistry: { getAvailable: () => available } })).toEqual(["all/fallback"]);
});
