import { expect, test, vi } from "vitest";

import subagentExtension, { availableModelIds } from "../../src/index.js";
import { createDefaultSubagentSettings } from "../../src/settings.js";
import { fakeAgent } from "../helpers/fake-agent.js";

test("loading settings for a tool invocation refreshes the visible widget", async () => {
  let tool: any;
  const runtime = {
    scheduler: {},
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
test("session start refreshes agent and model schema", async () => {
  const handlers = new Map<string, Function[]>();
  const tools: any[] = [];
  subagentExtension({
    on: vi.fn((event: string, handler: Function) => handlers.set(event, [...(handlers.get(event) ?? []), handler])),
    registerTool: (definition: any) => tools.push(definition),
    registerCommand: vi.fn(),
  } as any, {
    runtime: { scheduler: {}, onConversationUpdate: () => () => {}, listConversations: () => [] } as any,
    agentRegistry: { agents: new Map(), reload: async function () { this.agents.set("handler", {}); } } as any,
    settingsStore: { load: async () => ({ settings: createDefaultSubagentSettings() }), save: async () => {} },
  });

  const available = [{ provider: "all", id: "fallback" }];
  const scopedModels = [{ model: { provider: "scope", id: "alpha" } }, { model: { provider: "scope", id: "alpha" } }];
  await handlers.get("session_start")?.at(-1)?.({}, { cwd: "/tmp", hasUI: false, ui: {}, scopedModels, modelRegistry: { getAvailable: () => available } });

  expect(tools).toHaveLength(2);
  expect(tools[0].parameters.properties.spawns.anyOf[1].items.properties.model.anyOf[1].type).toBe("string");
  expect(tools[1].parameters.properties.spawns.anyOf[1].items.properties.model.anyOf[1].enum).toEqual(["scope/alpha"]);
  expect(tools[1].parameters.properties.spawns.anyOf[1].items.properties.agent.anyOf[1].enum).toEqual(["handler"]);
  expect(availableModelIds({ scopedModels: [], modelRegistry: { getAvailable: () => available } })).toEqual(["all/fallback"]);
});
