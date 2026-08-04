import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { statSync } from "node:fs";

import { AgentRegistry } from "./agents.js";
import { generationKey, type Conversation, type ConversationSnapshot, type ConversationUpdateKind } from "./conversation.js";
import { SubagentRuntime } from "./runtime.js";
import {
  CompletionNotifier,
  formatCompletionNotificationMessage,
  type CompletionNotificationMessageDetails,
} from "./notifications.js";
import { generationElapsedMs } from "./generation-format.js";
import { timingAsync } from "./timing.js";
import { defineSubagentTool, makeChildSubagentTool } from "./tool.js";
import { SubagentSettingsStore, DEFAULT_SUBAGENT_SETTINGS, prepareSubagentRuntime, type SubagentSettings } from "./settings.js";
import { registerSubagentsCommand } from "./command/index.js";
import { registerSubagentWidgetLifecycle, updateSubagentWidget } from "./widget.js";
import { resolveCurrentPiInvocation } from "./execute.js";
import { createPaneGenerationExecutor, reopenPaneExecution, retainedChildSessionFile, retainedPaneExists } from "./pane-execution.js";

export type { CanonicalFinishedSubagent, CanonicalLiveSubagent, SubagentIdentity } from "./contract.js";
export type { SubagentAction, SubagentStatus } from "./schema.js";
export type { SubagentBatchSummary, SubagentErrorEnvelope, SubagentResponseEnvelope, SubagentResultsEnvelope } from "./tool-contract.js";

interface SubagentExtensionDependencies {
  agentRegistry?: AgentRegistry;
  runtime?: SubagentRuntime;
  settingsStore?: Pick<SubagentSettingsStore, "load" | "save">;
}

export default function subagentExtension(pi: ExtensionAPI, dependencies: SubagentExtensionDependencies = {}) {
  const agentRegistry = dependencies.agentRegistry ?? new AgentRegistry();
  const runtime = dependencies.runtime ?? new SubagentRuntime(
    agentRegistry,
    DEFAULT_SUBAGENT_SETTINGS.runtime.maxConcurrentSubagents,
    createPaneGenerationExecutor(),
    DEFAULT_SUBAGENT_SETTINGS.runtime.maxConversations,
    undefined,
    { retainedPaneExists, reopenPaneExecution, getPiInvocation: resolveCurrentPiInvocation },
  );
  const settingsStore = dependencies.settingsStore ?? new SubagentSettingsStore();

  let currentSettings: SubagentSettings = DEFAULT_SUBAGENT_SETTINGS;
  const getCurrentSettings = () => currentSettings;
  registerSubagentWidgetLifecycle(pi, runtime, getCurrentSettings);

  const completionNotifier = new CompletionNotifier({
    pi: pi as any,
    manager: runtime,
    getMode: () => currentSettings.runtime.completionNotify,
  });
  pi.on("context", event => ({ messages: completionNotifier.reconcileMessages(event.messages) }));
  runtime.scheduler.setChildTool(parent =>
    makeChildSubagentTool({ runtime, agentRegistry, parent, getCurrentSettings })
  );
  runtime.scheduler.setChildSessionEvent((parent, generation, event) =>
    completionNotifier.handleToolEvent(`child:${parent.conversationId}:${generation.number}`, event)
  );

  registerSubagentLifecycleEvents(pi.events, runtime);
  registerSubagentMetadataPersistence(pi, runtime);
  registerSubagentSessionGuards(pi as any, runtime);

  registerSubagentsCommand(pi, runtime, settingsStore, agentRegistry, settings => {
    currentSettings = settings;
  });
  try {
    pi.registerMessageRenderer?.<CompletionNotificationMessageDetails>("subagent-completion", (message, options, theme) => {
      return new Text(formatCompletionNotificationMessage(message.details!, Boolean(options?.expanded), theme, currentSettings.display), 0, 0);
    });
  } catch { }

  const prepareInvocation = async (ctx: ExtensionContext) => {
    const settings = await timingAsync(
      "tool.prepareRuntime",
      { hasUI: ctx.hasUI, cwd: ctx.cwd },
      () => prepareSubagentRuntime({ ctx, settingsStore, runtime, agentRegistry }),
    );
    currentSettings = settings;
    updateSubagentWidget(ctx, runtime.listConversations(), settings);
    return settings;
  };
  const registerTool = (agentNames: readonly string[] = [], modelIds: readonly string[] = []) => pi.registerTool(defineSubagentTool({
    runtime,
    agentRegistry,
    prepareInvocation,
    agentNames,
    modelIds,
  }));
  registerTool();
  pi.on("session_start", async (_event, ctx) => {
    await prepareInvocation(ctx);
    runtime.restoreTerminalConversations?.(readSubagentGenerationIndexes(ctx.sessionManager?.getBranch?.() ?? [], ctx.sessionManager?.getSessionFile?.()));
    updateSubagentWidget(ctx, runtime.listConversations(), currentSettings);
    registerTool([...agentRegistry.agents.keys()], availableModelIds(ctx));
  });
}
interface ModelSchemaContext {
  modelRegistry?: { getAvailable(): Array<{ provider: string; id: string }> };
  scopedModels?: readonly { model: { provider: string; id: string } }[];
}

export function availableModelIds(ctx: ModelSchemaContext): string[] {
  const models = ctx.scopedModels?.length ? ctx.scopedModels.map(entry => entry.model) : (ctx.modelRegistry?.getAvailable() ?? []);
  return [...new Set(models.map(model => `${model.provider}/${model.id}`))];
}

export interface SubagentEventBus { emit(event: string, data: unknown): void }
export interface SubagentLifecycleEventSource {
  onConversationUpdate?(listener: (agent: Conversation, kind: ConversationUpdateKind) => void): () => void;
  projectSubagent(conversationId: string): ReturnType<SubagentRuntime["projectSubagent"]>;
}

/** Emits lifecycle events keyed by stable subagent identity. */
export function registerSubagentLifecycleEvents(events: SubagentEventBus | undefined, source: SubagentLifecycleEventSource): () => void {
  if (!events?.emit || !source.onConversationUpdate) return () => {};
  const seen = new Set<string>();
  return source.onConversationUpdate((agent, kind) => {
    if (kind !== "status") return;
    const generation = agent.snapshot().generations.at(-1);
    if (!generation) return;
    const snapshot = source.projectSubagent(agent.conversationId);
    const timestamp = generation.status.kind === "queued" ? generation.status.queuedAt
      : generation.status.kind === "running" ? generation.status.startedAt
      : generation.status.completedAt;
    const key = JSON.stringify([agent.conversationId, generation.generation, snapshot.status, timestamp]);
    if (seen.has(key)) return;
    seen.add(key);
    const event = snapshot.status === "queued" ? "subagent:queued"
      : snapshot.status === "running" ? "subagent:started"
      : "subagent:finished";
    events.emit(event, snapshot);
  });
}

interface GuardPi { on?(event: "session_before_switch" | "session_before_fork", handler: (event: unknown, ctx: GuardContext) => Promise<{ cancel: true } | undefined>): void }
interface GuardContext { hasUI?: boolean; ui?: { confirm?(title: string, message: string): Promise<boolean> } }
interface GuardManager { listConversations(): ConversationSnapshot[] }
export function registerSubagentSessionGuards(pi: GuardPi, manager: GuardManager): void { const guard = (_: unknown, ctx: GuardContext) => confirmWithActiveSubagents(ctx, manager); pi.on?.("session_before_switch", guard); pi.on?.("session_before_fork", guard); }
export async function confirmWithActiveSubagents(ctx: GuardContext, manager: GuardManager): Promise<{ cancel: true } | undefined> {
  const active = manager.listConversations().filter(item => item.currentGeneration !== undefined || item.isStopping);
  if (!active.length || !ctx.hasUI || !ctx.ui?.confirm) return;
  const lines = active.slice(0, 6).map(item => `- ${item.agent.name}${item.label !== item.agent.name ? ` (${item.label})` : ""}: ${item.currentGeneration?.status.kind ?? "stopping"}`);
  if (active.length > 6) lines.push(`- ... and ${active.length - 6} more`);
  const ok = await ctx.ui.confirm("Active subagents", `${active.length} subagent${active.length === 1 ? " is" : "s are"} still active:\n${lines.join("\n")}\n\nChanging sessions will tear down this extension runtime. Continue anyway?`);
  return ok ? undefined : { cancel: true };
}

interface MetadataPi { appendEntry?(customType: string, data?: unknown): void }
interface MetadataSource { onConversationUpdate?(listener: (agent: Conversation, kind: ConversationUpdateKind) => void): () => void }
export function registerSubagentMetadataPersistence(pi: MetadataPi, source: MetadataSource): () => void {
  if (!pi.appendEntry || !source.onConversationUpdate) return () => {};
  const persistedJoined = new Map<string, boolean>();
  return source.onConversationUpdate((agent, kind) => {
    if (kind !== "status" && kind !== "joined") return;
    const snapshot = agent.snapshot();
    const generation = snapshot.generations.at(-1);
    const key = generation ? generationKey({ conversationId: snapshot.conversationId, generation: generation.generation }) : undefined;
    const joined = generation?.joined === true;
    if (!generation || generation.status.kind !== "done" || !key || (persistedJoined.has(key) && persistedJoined.get(key) === joined)) return;
    persistedJoined.set(key, joined);
    const retainedSessionFile = agent.sessionFileForResume?.();
    pi.appendEntry!("subagent-generation-index", projectSubagentGenerationIndex(snapshot, retainedSessionFile));
  });
}

export interface SubagentGenerationIndexV4 {
  readonly version: 4;
  readonly subagentId: string;
  readonly generation: number;
  readonly agent: string;
  readonly label?: string;
  readonly kind: "spawn" | "resume";
  readonly status: "completed" | "error" | "aborted" | "interrupted" | "skipped";
  readonly completedAt: number;
  readonly startedAt?: number;
  readonly elapsedMs?: number;
}

export interface SubagentGenerationIndexV5 {
  readonly version: 5;
  readonly subagentId: string;
  readonly generation: number;
  readonly agent: string;
  readonly label: string;
  readonly kind: "spawn" | "resume";
  readonly status: "completed" | "error" | "aborted" | "interrupted" | "skipped";
  readonly conversationCreatedAt: number;
  readonly createdAt: number;
  readonly completedAt: number;
  readonly startedAt?: number;
  readonly elapsedMs?: number;
  readonly prompt: string;
  readonly parentConversationId?: string;
  readonly startedInParentGeneration?: number;
  readonly requestedConfig: ConversationSnapshot["requestedConfig"];
  readonly requestedOverrides?: ConversationSnapshot["requestedOverrides"];
  readonly retainedSessionFile?: string;
  readonly joined: boolean;
}

export type SubagentGenerationIndex = SubagentGenerationIndexV4 | SubagentGenerationIndexV5;

export function projectSubagentGenerationIndex(
  snapshot: ReturnType<Conversation["snapshot"]>,
  retainedSessionFile?: string,
): SubagentGenerationIndex {
  const generation = snapshot.generations.at(-1);
  if (!generation || generation.status.kind !== "done") throw new Error("Cannot persist a non-terminal generation.");
  if (typeof snapshot.createdAt !== "number" || typeof generation.prompt !== "string" || snapshot.requestedConfig === undefined) {
    return {
      version: 4,
      subagentId: snapshot.conversationId,
      generation: generation.generation,
      agent: snapshot.agent.name,
      ...(snapshot.label ? { label: snapshot.label } : {}),
      kind: generation.kind,
      status: generation.status.outcome,
      completedAt: generation.status.completedAt,
      ...(generation.status.startedAt !== undefined ? {
        startedAt: generation.status.startedAt,
        elapsedMs: generationElapsedMs(generation),
      } : {}),
    };
  }
  return {
    version: 5,
    subagentId: snapshot.conversationId,
    generation: generation.generation,
    agent: snapshot.agent.name,
    label: snapshot.label,
    kind: generation.kind,
    status: generation.status.outcome,
    conversationCreatedAt: snapshot.createdAt,
    createdAt: generation.createdAt,
    completedAt: generation.status.completedAt,
    ...(generation.status.startedAt !== undefined ? {
      startedAt: generation.status.startedAt,
      elapsedMs: generationElapsedMs(generation),
    } : {}),
    prompt: generation.prompt,
    ...(snapshot.parentConversationId ? { parentConversationId: snapshot.parentConversationId } : {}),
    ...(generation.startedInParentGeneration !== undefined ? { startedInParentGeneration: generation.startedInParentGeneration } : {}),
    requestedConfig: snapshot.requestedConfig,
    ...(snapshot.requestedOverrides ? { requestedOverrides: snapshot.requestedOverrides } : {}),
    ...(retainedSessionFile ? { retainedSessionFile } : {}),
    joined: generation.joined === true,
  };
}

/** Folds only current-branch custom index entries; later entries replace earlier records for the same generation. */
export function readSubagentGenerationIndexes(branch: readonly unknown[], parentSessionFile?: string): SubagentGenerationIndex[] {
  const latest = new Map<string, SubagentGenerationIndex>();
  for (const entry of branch) {
    if (!isObject(entry) || entry.type !== "custom" || entry.customType !== "subagent-generation-index") continue;
    const parsed = parseSubagentGenerationIndex(entry.data);
    const record = parsed ? sanitizeRecoveredIndex(parsed, parentSessionFile) : undefined;
    if (!record) continue;
    latest.set(generationKey({ conversationId: record.subagentId as ConversationSnapshot["conversationId"], generation: record.generation }), record);
  }
  return [...latest.values()].sort((left, right) => left.subagentId.localeCompare(right.subagentId) || left.generation - right.generation);
}

function sanitizeRecoveredIndex(record: SubagentGenerationIndex, parentSessionFile: string | undefined): SubagentGenerationIndex | undefined {
  if (record.version !== 5 || record.retainedSessionFile === undefined) return record;
  if (!parentSessionFile) return { ...record, retainedSessionFile: undefined };
  const expected = retainedChildSessionFile(parentSessionFile, record.subagentId, record.generation);
  return record.retainedSessionFile === expected && isOrdinaryFile(expected) ? record : { ...record, retainedSessionFile: undefined };
}

function isOrdinaryFile(file: string): boolean {
  try { return statSync(file).isFile(); } catch { return false; }
}

function parseSubagentGenerationIndex(value: unknown): SubagentGenerationIndex | undefined {
  if (!isObject(value) || (value.version !== 4 && value.version !== 5)) return;
  if (typeof value.subagentId !== "string" || !value.subagentId || !Number.isSafeInteger(value.generation) || (value.generation as number) < 1) return;
  if (typeof value.agent !== "string" || !value.agent || (value.kind !== "spawn" && value.kind !== "resume") || !isTerminalStatus(value.status)) return;
  if (!isTimestamp(value.completedAt) || (value.startedAt !== undefined && !isTimestamp(value.startedAt)) || (value.elapsedMs !== undefined && !isTimestamp(value.elapsedMs))) return;
  if (value.version === 4) {
    if (value.label !== undefined && typeof value.label !== "string") return;
    return value as unknown as SubagentGenerationIndexV4;
  }
  if (typeof value.label !== "string" || !isTimestamp(value.conversationCreatedAt) || !isTimestamp(value.createdAt) || typeof value.prompt !== "string") return;
  if (!isObject(value.requestedConfig) || typeof value.joined !== "boolean") return;
  if (value.parentConversationId !== undefined && typeof value.parentConversationId !== "string") return;
  if (value.startedInParentGeneration !== undefined && (!Number.isSafeInteger(value.startedInParentGeneration) || (value.startedInParentGeneration as number) < 1)) return;
  if (value.requestedOverrides !== undefined && !isObject(value.requestedOverrides)) return;
  if (value.retainedSessionFile !== undefined && (typeof value.retainedSessionFile !== "string" || !value.retainedSessionFile)) return;
  return value as unknown as SubagentGenerationIndexV5;
}

function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function isTimestamp(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function isTerminalStatus(value: unknown): value is SubagentGenerationIndex["status"] {
  return value === "completed" || value === "error" || value === "aborted" || value === "interrupted" || value === "skipped";
}
