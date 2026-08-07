import { test, expect } from "vitest";
import { completedGeneration, Conversation } from "../../src/conversation.js";
import { CONVERSATION_ID_ADJECTIVES } from "../../src/identifier-word-lists.js";
import { SubagentRuntime, type SubagentCaller } from "../../src/runtime.js";
import { cancelAction, defineSubagentTool, inspectAction, joinAction, listAction, removeAction, resumeAction, spawnAction, steerAction } from "../../src/tool.js";

const knownModel = { provider: "test", id: "known" } as any;
const config = {
  name: "worker",
  description: "",
  systemPrompt: "",
  source: "project",
} as any;
const registry = { agents: new Map([["worker", config]]) } as any;
const ctx = {
  cwd: "/tmp",
  model: knownModel,
  modelRegistry: { getAll: () => [knownModel] },
} as any;
const session = (steering: string[] = []) => ({
  messages: [],
  subscribe: () => () => {},
  abort() {},
  steer(message: string) { steering.push(message); },
  getSteeringMessages() { return steering; },
  getFollowUpMessages() { return []; },
}) as any;
const deps = (runtime: SubagentRuntime) => ({ runtime, agentRegistry: registry });
const response = (result: any) => result.details.response;

function modelFacingInspectFixture(targetIds: readonly string[]) {
  const conversations = new Map(targetIds.map(target => [target, new Conversation(target as any, config, {
    kind: "spawn",
    agent: "worker",
    label: target,
    prompt: target,
  }, () => {})]));
  const runtime = {
    inspectSubagents: (subagentIds: readonly string[]) => subagentIds.map(subagentId => {
      const conversation = conversations.get(subagentId);
      if (!conversation) throw new Error(`Subagent ${subagentId} was not found.`);
      return { conversationId: subagentId, snapshot: conversation.generationHistory[0] };
    }),
    projectSubagent: (subagentId: string) => ({
      ok: true,
      subagentId,
      agent: "worker",
      label: subagentId,
      generation: 1,
      status: "running",
      joined: false,
      actionHints: ["inspect"],
    }),
    conversation: (subagentId: string) => {
      const conversation = conversations.get(subagentId);
      if (!conversation) throw new Error(`Subagent ${subagentId} was not found.`);
      return conversation.snapshot();
    },
    conversationDepth: () => 0,
    removeConversations: async (subagentIds: readonly string[]) => subagentIds.map(subagentId => {
      const conversation = conversations.get(subagentId);
      if (!conversation) return { ok: false as const, error: `Subagent ${subagentId} was not found.` };
      conversations.delete(subagentId);
      return { ok: true as const, label: conversation.label, removedIds: [subagentId] };
    }),
  } as any;
  const tool = defineSubagentTool({
    runtime,
    agentRegistry: registry,
    prepareInvocation: async () => ({ runtime: { maxTasksPerCall: 8 } }) as any,
  });
  const execute = (request: any) => tool.execute("model-call", { request }, undefined, undefined, ctx);
  return { conversations, execute };
}

function joinLatest(runtime: SubagentRuntime, subagentId: any): void {
  const binding = runtime.bindSubagentJoin([subagentId]);
  binding.markJoined();
  binding.release();
}

test("spawn response reflects a started generation after the scheduler tick", async () => {
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const runtime = new SubagentRuntime(registry, 1, async (_ctx, conversation, generation) => {
    conversation.bindSession(generation, session());
    await gate;
    return completedGeneration(conversation, generation, "done");
  });

  const result = await spawnAction(deps(runtime), {
    action: "spawn",
    spawns: [{ kind: "spawn", agent: "worker", prompt: "wait", label: "visible" }],
  }, ctx);

  expect(response(result).results[0]).toMatchObject({ status: "running" });
  release();
  await runtime.bindSubagentJoin([response(result).results[0].subagentId]).completion;
});

test("list joined=false includes active subagents and projects joined explicitly", async () => {
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const executor = async (_ctx: any, conversation: any, generation: any) => {
    conversation.bindSession(generation, session());
    await gate;
    return completedGeneration(conversation, generation, "done");
  };
  const runtime = new SubagentRuntime(registry, 1, executor);
  const start = runtime.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "wait", label: "active" }]);
  const identity = start.starts[0] as any;
  await new Promise(done => setImmediate(done));

  const listed = response(listAction(deps(runtime), { action: "list", joined: false }));

  expect(listed.results).toMatchObject([{
    ok: true,
    subagentId: identity.conversationId,
    generation: 1,
    status: "running",
    joined: false,
  }]);

  release();
  await start.completion;
});

test("inspect separates current generation metrics from prior generation history", async () => {
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>(done => { releaseFirst = done; });
  const steering: string[] = [];
  const executor = async (_ctx: any, conversation: any, generation: any) => {
    conversation.bindSession(generation, session(steering));
    if (generation.kind === "spawn") await firstGate;
    return completedGeneration(conversation, generation, generation.prompt);
  };
  const runtime = new SubagentRuntime(registry, 1, executor);
  const initial = runtime.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "first", label: "history" }]);
  const identity = initial.starts[0] as any;
  await new Promise(done => setImmediate(done));
  await runtime.steerSubagent(identity.conversationId, "redirect");
  releaseFirst();
  await initial.completion;
  joinLatest(runtime, identity.conversationId);

  const resumed = runtime.startTasks(ctx, [{ kind: "resume", subagentId: identity.conversationId, prompt: "second" }]);
  await resumed.completion;

  const result = inspectAction(deps(runtime), {
    action: "inspect",
    subagentIds: [identity.conversationId],
  });
  const inspected = response(result).results[0];

  expect(result.details).toMatchObject({
    observedGenerations: [{ conversationId: identity.conversationId, generation: 2 }],
  });
  expect(JSON.parse(result.content[0].text)).not.toHaveProperty("observedGenerations");
  expect(inspected).toMatchObject({
    generation: 2,
    metrics: {
      elapsedMs: expect.any(Number),
      turns: 0,
      compactions: 0,
      tokens: 0,
    },
    totalMetrics: {
      elapsedMs: expect.any(Number),
      turns: 0,
      compactions: 0,
      tokens: 0,
    },
    history: [
      {
        generation: 1,
        kind: "spawn",
        status: "completed",
        joined: true,
        elapsedMs: expect.any(Number),
        turns: 0,
        compactions: 0,
        tokens: 0,
        steers: [{ id: 1, state: "discarded" }],
      },
    ],
  });
  expect(inspected).not.toHaveProperty("attempt");
  expect(inspected).not.toHaveProperty("attemptMetrics");
  expect(inspected).not.toHaveProperty("elapsedMs");
  expect(inspected).not.toHaveProperty("turns");
  expect(inspected).not.toHaveProperty("compactions");
  expect(inspected.totalMetrics.elapsedMs).toBe(
    inspected.history[0].elapsedMs + inspected.metrics.elapsedMs,
  );
});

test("model-facing inspect rejects unchanged polling but permits changed snapshots and other targets", async () => {
  const releases = new Map<string, () => void>();
  const gates = new Map<string, Promise<void>>();
  for (const prompt of ["first", "other"]) {
    gates.set(prompt, new Promise<void>(done => { releases.set(prompt, done); }));
  }
  const runtime = new SubagentRuntime(registry, 2, async (_ctx, conversation, generation) => {
    conversation.bindSession(generation, session());
    await gates.get(generation.prompt);
    return completedGeneration(conversation, generation, generation.prompt);
  });
  const tool = defineSubagentTool({
    runtime,
    agentRegistry: registry,
    prepareInvocation: async () => ({ runtime: { maxTasksPerCall: 8 } }) as any,
  });
  const inspect = (subagentId: string) => tool.execute(
    "inspect-call",
    { request: { action: "inspect", subagentIds: [subagentId] } },
    undefined,
    undefined,
    ctx,
  );

  const firstStart = runtime.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "first", label: "first" }]);
  const firstId = (firstStart.starts[0] as any).conversationId;
  await new Promise(done => setImmediate(done));
  const firstInspection = response(await inspect(firstId));
  expect(firstInspection.results[0]).toMatchObject({ ok: true, subagentId: firstId, status: "running" });

  const repeatedInspection = response(await inspect(firstId));
  expect(repeatedInspection.results[0]).toMatchObject({
    ok: false,
    subagentId: firstId,
    error: expect.stringContaining("cannot be used to poll or wait"),
  });

  const otherStart = runtime.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "other", label: "other" }]);
  const otherId = (otherStart.starts[0] as any).conversationId;
  await new Promise(done => setImmediate(done));
  const otherInspection = response(await inspect(otherId));
  expect(otherInspection.results[0]).toMatchObject({ ok: true, subagentId: otherId, status: "running" });

  releases.get("first")!();
  await firstStart.completion;
  const changedInspection = response(await inspect(firstId));
  expect(changedInspection.results[0]).toMatchObject({ ok: true, subagentId: firstId, status: "completed" });

  releases.get("other")!();
  await otherStart.completion;
});

test("model-facing inspect observations are isolated by caller generation", async () => {
  const parent = new Conversation("calm-parent" as any, config, {
    kind: "spawn",
    agent: "worker",
    label: "parent",
    prompt: "first",
  }, () => {});
  parent.bindSession(parent.latestGeneration, session());
  const child = new Conversation("calm-river" as any, config, {
    kind: "spawn",
    agent: "worker",
    label: "child",
    prompt: "work",
  }, () => {}, { parentConversationId: parent.conversationId });
  const runtime = {
    inspectSubagents: () => [{ conversationId: child.conversationId, snapshot: child.generationHistory[0] }],
    projectSubagent: () => ({
      ok: true,
      subagentId: child.conversationId,
      agent: "worker",
      label: "child",
      generation: 1,
      status: "running",
      joined: false,
      actionHints: ["inspect"],
    }),
    conversation: () => child.snapshot(),
    conversationDepth: () => 1,
  } as any;
  const tool = defineSubagentTool({
    runtime,
    agentRegistry: registry,
    parent,
    prepareInvocation: async () => ({ runtime: { maxTasksPerCall: 8 } }) as any,
  });
  const inspect = () => tool.execute(
    "inspect-call",
    { request: { action: "inspect", subagentIds: [child.conversationId] } },
    undefined,
    undefined,
    ctx,
  );

  expect(response(await inspect()).results[0]).toMatchObject({ ok: true, subagentId: child.conversationId });
  expect(response(await inspect()).results[0]).toMatchObject({
    ok: false,
    subagentId: child.conversationId,
    error: expect.stringContaining("cannot be used to poll or wait"),
  });

  parent.settle(parent.latestGeneration, "completed", { output: "done" });
  parent.markJoined(parent.latestGeneration);
  parent.beginResume("second");
  expect(response(await inspect()).results[0]).toMatchObject({ ok: true, subagentId: child.conversationId });
});

test("model-facing root inspect cache evicts oldest targets while guarding recent targets", async () => {
  const targetIds = CONVERSATION_ID_ADJECTIVES.slice(0, 101).map(adjective => `${adjective}-acorn`);
  const fixture = modelFacingInspectFixture(targetIds);
  const inspect = (subagentId: string) => fixture.execute({ action: "inspect", subagentIds: [subagentId] });

  for (const targetId of targetIds) {
    expect(response(await inspect(targetId)).results[0]).toMatchObject({ ok: true, subagentId: targetId });
  }

  expect(response(await inspect(targetIds[0])).results[0]).toMatchObject({ ok: true, subagentId: targetIds[0] });
  expect(response(await inspect(targetIds.at(-1)!)).results[0]).toMatchObject({
    ok: false,
    subagentId: targetIds.at(-1),
    error: expect.stringContaining("cannot be used to poll or wait"),
  });
});

test("model-facing remove evicts the target's stale inspect observation", async () => {
  const targetId = "calm-acorn";
  const fixture = modelFacingInspectFixture([targetId]);
  const inspect = () => fixture.execute({ action: "inspect", subagentIds: [targetId] });

  expect(response(await inspect()).results[0]).toMatchObject({ ok: true, subagentId: targetId });
  expect(response(await inspect()).results[0]).toMatchObject({ ok: false, error: expect.stringContaining("cannot be used to poll or wait") });

  const removed = response(await fixture.execute({ action: "remove", subagentIds: [targetId] }));
  expect(removed.results[0]).toMatchObject({ ok: true, subagentId: targetId, removedIds: [targetId] });
  fixture.conversations.set(targetId, new Conversation(targetId as any, config, {
    kind: "spawn",
    agent: "worker",
    label: targetId,
    prompt: targetId,
  }, () => {}));

  expect(response(await inspect()).results[0]).toMatchObject({ ok: true, subagentId: targetId });
});

test("cancelling a parent does not crash its in-flight nested join update", async () => {
  const parent = new Conversation("calm-parent" as any, config, {
    kind: "spawn",
    agent: "worker",
    label: "parent",
    prompt: "delegate",
  }, () => {});
  let update: (() => void) | undefined;
  let subscribed!: () => void;
  const subscription = new Promise<void>(resolve => { subscribed = resolve; });
  let completeJoin!: () => void;
  const joinCompletion = new Promise<void>(resolve => { completeJoin = resolve; });
  const binding = {
    owner: { conversationId: parent.conversationId, generation: 1 },
    attemptIndex: 0,
    targets: [{ conversationId: "calm-river", generation: 1 }],
    completion: joinCompletion,
    project: () => [{ conversationId: "calm-river", generation: 1, status: { kind: "running", startedAt: Date.now() } }],
    markJoined() {},
    release() {},
    interrupt() { completeJoin(); },
  };
  const runtime = {
    scheduler: { suspendConversationSlotDuring: (_parent: Conversation, wait: () => Promise<void>) => wait() },
    validateSubagentJoin() {},
    bindSubagentJoin: () => binding,
    onConversationUpdate(listener: () => void) { update = listener; subscribed(); return () => {}; },
    listConversations: () => [],
    generationSnapshot: () => { throw new Error("unavailable"); },
    conversationDisplay: () => ({ agentName: "worker", label: "child" }),
    unjoinedDirectChildGenerations: () => [],
    projectSubagent: (_id: string, caller: SubagentCaller) => ({
      ok: true,
      subagentId: "calm-river",
      agent: "worker",
      label: "child",
      generation: 1,
      status: "running",
      joined: false,
      actionHints: ["inspect", "join"],
      callerGeneration: caller.generation.number,
    }),
  } as any;
  const tool = defineSubagentTool({
    runtime,
    agentRegistry: registry,
    parent,
    prepareInvocation: async () => ({ runtime: { maxTasksPerCall: 8 } }) as any,
  });
  const controller = new AbortController();
  const execution = tool.execute("join-call", { request: { action: "join", subagentIds: ["calm-river"] } }, controller.signal, () => {}, ctx);
  await subscription;

  parent.settle(parent.latestGeneration, "aborted", { error: "Generation cancelled." });
  expect(() => update?.()).not.toThrow();

  controller.abort();
  await execution;
});

test("cancel details correlate the exact generation without exposing it in public JSON", async () => {
  const actionDeps = {
    runtime: {
      cancelSubagent: async () => ({ conversationId: "calm-river", generation: 2 }),
      projectSubagent: () => ({
        ok: true,
        subagentId: "calm-river",
        agent: "worker",
        label: "cancelled task",
        generation: 2,
        status: "cancelled",
        joined: false,
        actionHints: ["inspect", "remove"],
      }),
    },
    agentRegistry: registry,
  } as any;

  const result = await cancelAction(actionDeps, { action: "cancel", subagentIds: ["calm-river"] } as any);

  expect(result.details).toMatchObject({
    observedGenerations: [{ conversationId: "calm-river", generation: 2 }],
  });
  const publicResult = JSON.parse(result.content[0].text);
  expect(publicResult).not.toHaveProperty("observedGenerations");
  expect(publicResult.results[0]).not.toHaveProperty("settled");
  expect(publicResult.results[0]).not.toHaveProperty("alreadyCancelled");
  expect(publicResult.results[0]).not.toHaveProperty("note");
});

test("cancel is idempotent and returns only canonical lifecycle state", async () => {
  let finish!: () => void;
  const gate = new Promise<void>(done => { finish = done; });
  let abortCalls = 0;
  const runtime = new SubagentRuntime(registry, 1, async (_ctx, conversation, generation) => {
    conversation.bindSession(generation, { ...session(), abort() { abortCalls++; finish(); } });
    await gate;
    return completedGeneration(conversation, generation, "ignored after cancellation");
  });
  const start = runtime.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "wait", label: "cancel me" }]);
  const identity = start.starts[0] as any;
  await new Promise(done => setImmediate(done));

  const first = response(await cancelAction(deps(runtime), { action: "cancel", subagentIds: [identity.conversationId] }));
  const repeated = response(await cancelAction(deps(runtime), { action: "cancel", subagentIds: [identity.conversationId] }));

  for (const result of [first, repeated]) {
    expect(result.summary).toEqual({ requested: 1, succeeded: 1, failed: 0 });
    expect(result.results[0]).toMatchObject({
      ok: true,
      subagentId: identity.conversationId,
      generation: 1,
      status: "cancelled",
    });
    expect(result.results[0]).not.toHaveProperty("settled");
    expect(result.results[0]).not.toHaveProperty("alreadyCancelled");
    expect(result.results[0]).not.toHaveProperty("note");
  }
  expect(abortCalls).toBe(1);
  await start.completion;
});

test("final joins use null when terminal generations have no output", async () => {
  const runtime = new SubagentRuntime(registry, 4, async (_ctx, conversation, generation) => {
    conversation.bindSession(generation, session());
    if (generation.prompt === "completed") return completedGeneration(conversation, generation, "answer");
    if (generation.prompt === "partial") return conversation.settle(generation, "aborted", { error: "Generation cancelled.", output: "partial answer" });
    if (generation.prompt === "cancelled") return conversation.settle(generation, "aborted", { error: "Generation cancelled." });
    return conversation.settle(generation, "error", { error: "provider failed" });
  });
  const prompts = ["completed", "partial", "cancelled", "failed"];
  const start = runtime.startTasks(ctx, prompts.map(prompt => ({ kind: "spawn", agent: "worker", prompt, label: prompt })));
  await start.completion;
  const ids = start.starts.map(item => (item as any).conversationId);

  const joined = response(await joinAction(deps(runtime), { action: "join", subagentIds: ids }, undefined, undefined));

  expect(joined.results.map((result: any) => ({ generation: result.generation, status: result.status, output: result.output }))).toEqual([
    { generation: 1, status: "completed", output: "answer" },
    { generation: 1, status: "cancelled", output: "partial answer" },
    { generation: 1, status: "cancelled", output: null },
    { generation: 1, status: "failed", output: null },
  ]);
  expect(joined.results[3]).toMatchObject({ failure: "Subagent failed: provider failed" });

  const repeated = response(await joinAction(deps(runtime), { action: "join", subagentIds: [ids[2]] }, undefined, undefined));
  expect(repeated.results[0]).toMatchObject({ generation: 1, status: "cancelled", joined: true, output: null });
});

test("running join updates omit output until the final result", async () => {
  let finish!: () => void;
  const gate = new Promise<void>(done => { finish = done; });
  const runtime = new SubagentRuntime(registry, 1, async (_ctx, conversation, generation) => {
    conversation.bindSession(generation, session());
    await gate;
    return completedGeneration(conversation, generation, "done");
  });
  const start = runtime.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "wait", label: "wait" }]);
  const identity = start.starts[0] as any;
  await new Promise(done => setImmediate(done));
  const updates: any[] = [];

  const joining = joinAction(
    deps(runtime),
    { action: "join", subagentIds: [identity.conversationId] },
    undefined,
    update => updates.push(response(update)),
  );
  expect(updates[0].results[0]).toMatchObject({ generation: 1, status: "running" });
  expect(updates[0].results[0]).not.toHaveProperty("output");

  finish();
  const final = response(await joining);
  expect(final.results[0]).toMatchObject({ generation: 1, status: "completed", output: "done" });
  await start.completion;
});

test("join rendering reports an unjoined resumed child from a historical owner generation", async () => {
  let releaseGrandparent!: () => void;
  let releaseParent!: () => void;
  let releaseResumedChild!: () => void;
  const gates = new Map([
    ["grandparent", new Promise<void>(done => { releaseGrandparent = done; })],
    ["parent", new Promise<void>(done => { releaseParent = done; })],
    ["child-again", new Promise<void>(done => { releaseResumedChild = done; })],
  ]);
  const executor = async (_ctx: any, conversation: any, generation: any) => {
    conversation.bindSession(generation, generation.kind === "resume" ? conversation.sessionForResume() : session());
    await gates.get(generation.prompt);
    return completedGeneration(conversation, generation, generation.prompt);
  };
  const runtime = new SubagentRuntime(registry, 3, executor);

  const grandparentStart = runtime.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "grandparent", label: "grandparent" }]);
  const grandparent = grandparentStart.starts[0] as any;
  await new Promise(done => setImmediate(done));
  const grandparentCaller = runtime.generationCaller(grandparent);

  const parentStart = runtime.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "parent", label: "parent" }], { caller: grandparentCaller });
  const parent = parentStart.starts[0] as any;
  await new Promise(done => setImmediate(done));
  const parentCaller = runtime.generationCaller(parent);
  const parentJoin = runtime.bindSubagentJoin([parent.conversationId], grandparentCaller);

  const childStart = runtime.startTasks(ctx, [{ kind: "spawn", agent: "worker", prompt: "child", label: "child" }], { caller: parentCaller });
  await childStart.completion;
  const child = childStart.starts[0] as any;
  const childJoin = runtime.bindSubagentJoin([child.conversationId], parentCaller);
  await childJoin.completion;
  childJoin.markJoined();
  childJoin.release();

  const resumedChildStart = runtime.startTasks(ctx, [{ kind: "resume", subagentId: child.conversationId, prompt: "child-again" }], { caller: parentCaller });
  await new Promise(done => setImmediate(done));

  releaseParent();
  await parentStart.completion;
  await parentJoin.completion;
  parentJoin.markJoined();
  parentJoin.release();
  const resumedParent = runtime.startTasks(ctx, [{ kind: "resume", subagentId: parent.conversationId, prompt: "parent-again" }], { caller: grandparentCaller });
  await resumedParent.completion;

  releaseGrandparent();
  await grandparentStart.completion;
  const rendered = await joinAction(deps(runtime), { action: "join", subagentIds: [grandparent.conversationId] }, undefined, undefined);
  const historicalParent = (rendered.details as any).view.entries[0].joins[0].targets[0];

  expect(runtime.conversation(parent.conversationId).generations).toHaveLength(2);
  expect(historicalParent.background[0].entries).toEqual([expect.objectContaining({
    subagentId: child.conversationId,
    status: "running",
    detachedAtFinal: true,
  })]);

  releaseResumedChild();
  await resumedChildStart.completion;
});

test("unauthorized lifecycle failures do not expose canonical target metadata", async () => {
  const blocked = new Set(["first-root", "second-root", "child"]);
  const releases = new Map<string, () => void>();
  const gates = new Map([...blocked].map(prompt => [prompt, new Promise<void>(done => { releases.set(prompt, done); })]));
  const executor = async (_ctx: any, conversation: any, generation: any) => {
    conversation.bindSession(generation, session());
    const gate = gates.get(generation.prompt);
    if (gate) {
      await gate;
      return completedGeneration(conversation, generation, "done");
    }
    return conversation.settle(generation, "error", { error: "TOP SECRET FAILURE" });
  };
  const runtime = new SubagentRuntime(registry, 4, executor);
  const handles: Array<{ completion: Promise<unknown> }> = [];
  const start = async (prompt: string, caller?: SubagentCaller) => {
    const handle = runtime.startTasks(
      ctx,
      [{ kind: "spawn", agent: "worker", prompt, label: `SECRET ${prompt}` }],
      caller ? { caller } : {},
    );
    handles.push(handle);
    const identity = handle.starts[0] as any;
    await new Promise(done => setImmediate(done));
    if (!blocked.has(prompt)) await handle.completion;
    return identity;
  };
  const firstRoot = await start("first-root");
  const secondRoot = await start("second-root");
  const secondCaller = runtime.generationCaller(secondRoot);
  const child = await start("child", secondCaller);
  const childCaller = runtime.generationCaller(child);
  const leaf = await start("leaf", childCaller);
  const ownedFailureIdentity = await start("owned-failure");

  const unauthorizedCases = [
    {
      name: "sibling",
      target: secondRoot.conversationId,
      actionDeps: { ...deps(runtime), parent: runtime.generationCaller(firstRoot).conversation },
    },
    {
      name: "ancestor",
      target: secondRoot.conversationId,
      actionDeps: { ...deps(runtime), parent: runtime.generationCaller(child).conversation },
    },
  ];

  for (const item of unauthorizedCases) {
    const results = [
      response(await resumeAction(item.actionDeps as any, { action: "resume", resumes: [{ kind: "resume", subagentId: item.target, prompt: "again" }] }, ctx as any)).results[0],
      response(await steerAction(item.actionDeps as any, { action: "steer", messages: [{ kind: "steer", subagentId: item.target, message: "redirect" }] })).results[0],
      response(await cancelAction(item.actionDeps as any, { action: "cancel", subagentIds: [item.target] })).results[0],
      response(inspectAction(item.actionDeps as any, { action: "inspect", subagentIds: [item.target] })).results[0],
      response(await joinAction(item.actionDeps as any, { action: "join", subagentIds: [item.target] }, undefined, undefined)).results[0],
      response(await removeAction(item.actionDeps as any, { action: "remove", subagentIds: [item.target] })).results[0],
    ];

    for (const result of results) {
      expect(result, item.name).toEqual({
        ok: false,
        subagentId: item.target,
        error: expect.stringMatching(/not (?:directly owned|a descendant)/),
      });
      expect(JSON.stringify(result)).not.toContain("SECRET");
    }
  }

  const indirect = { target: leaf.conversationId, actionDeps: deps(runtime) };
  const inspected = response(inspectAction(indirect.actionDeps as any, {
    action: "inspect",
    subagentIds: [indirect.target],
  })).results[0];
  expect(inspected).toMatchObject({
    ok: true,
    subagentId: indirect.target,
    label: "SECRET leaf",
    status: "failed",
    actionHints: ["inspect"],
  });

  const indirectMutations = [
    response(await resumeAction(indirect.actionDeps as any, { action: "resume", resumes: [{ kind: "resume", subagentId: indirect.target, prompt: "again" }] }, ctx as any)).results[0],
    response(await steerAction(indirect.actionDeps as any, { action: "steer", messages: [{ kind: "steer", subagentId: indirect.target, message: "redirect" }] })).results[0],
    response(await cancelAction(indirect.actionDeps as any, { action: "cancel", subagentIds: [indirect.target] })).results[0],
    response(await joinAction(indirect.actionDeps as any, { action: "join", subagentIds: [indirect.target] }, undefined, undefined)).results[0],
    response(await removeAction(indirect.actionDeps as any, { action: "remove", subagentIds: [indirect.target] })).results[0],
  ];
  for (const result of indirectMutations) {
    expect(result).toEqual({
      ok: false,
      subagentId: indirect.target,
      error: expect.stringContaining("not directly owned"),
    });
  }

  const ownedFailure = response(await steerAction(deps(runtime), {
    action: "steer",
    messages: [{ kind: "steer", subagentId: ownedFailureIdentity.conversationId, message: "redirect" }],
  })).results[0];
  expect(ownedFailure).toMatchObject({
    ok: false,
    subagentId: ownedFailureIdentity.conversationId,
    label: "SECRET owned-failure",
    status: "failed",
    failure: "Subagent failed: TOP SECRET FAILURE",
    error: expect.stringContaining("cannot be steered"),
  });

  for (const release of releases.values()) release();
  await Promise.all(handles.map(handle => handle.completion));
});
