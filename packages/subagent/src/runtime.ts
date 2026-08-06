import { statSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentRegistry, isModelThinkingLevel, resolveRequestedConfig, type AgentDefinition, type ExecutionOverrides, type RequestedExecutionConfig } from "./agents.js";
import {
  Conversation,
  GenerationSteerError,
  effectiveStatus,
  generationKey,
  type ConversationSnapshot,
  type ConversationUpdateKind,
  type ConversationUpdateListener,
  type Generation,
  type GenerationBinding,
  type GenerationKind,
  type GenerationRef,
  type GenerationSnapshot,
  type GenerationViewStatus,
  type NestedJoinTargetSnapshot,
  type RestoredActiveConversation,
  type RestoredTerminalConversation,
  type RestoredTerminalGeneration,
  type SteerReceipt,
  completedGeneration,
  errorGeneration,
  interruptedGeneration,
} from "./conversation.js";
import { resolveModel, resolveTaskCwd } from "./execute.js";
import { ConversationIdAllocator, isConversationId, type ConversationId, type SubagentId } from "./identifiers.js";
import { readPaneCompletionOutcome, readPaneCompletionOutput, rebindPaneExecution, type PaneCompletionOutcome } from "./pane-execution.js";
import { GenerationScheduler, type GenerationExecutor } from "./scheduler.js";
import { projectLiveSubagent, projectSubagentGenerationStatus, projectSubagentStatus, type CanonicalLiveSubagent, type FailureProjectionMode } from "./contract.js";
import type { SubagentStatus, SpawnRequest, ResumeRequest } from "./schema.js";

export type { ConversationUpdateListener } from "./conversation.js";

export class SubagentNotFoundError extends Error {
  constructor(readonly subagentId: string) { super(`Subagent ${subagentId} was not found.`); this.name = "SubagentNotFoundError"; }
}

export type OrderedStartOutcome =
  | ({ readonly ok: true; readonly inputIndex: number; readonly steer?: SteerReceipt } & GenerationRef)
  | { readonly ok: false; readonly inputIndex: number; readonly error: string };
export interface GenerationHandle { readonly starts: readonly OrderedStartOutcome[]; readonly completion: Promise<readonly OrderedStartOutcome[]> }
export interface JoinProjection extends GenerationRef { readonly status: GenerationViewStatus }
export interface JoinBinding {
  readonly targets: readonly GenerationRef[];
  readonly completion: Promise<void>;
  project(): readonly JoinProjection[];
  markJoined(): void;
  release(): void;
}
export interface NestedJoinBinding extends JoinBinding {
  readonly owner: GenerationRef;
  readonly attemptIndex: number;
  interrupt(error?: string): void;
}
export interface SubagentCaller { readonly conversation: Conversation; readonly generation: Generation }
export interface ConversationDisplayIdentity { readonly conversationId: ConversationId; readonly label?: string; readonly agentName?: string }
export type RemoveOutcome =
  | { readonly ok: true; readonly conversationId: ConversationId; readonly label: string; readonly removedIds: readonly ConversationId[] }
  | { readonly ok: false; readonly conversationId: string; readonly error: string };
export interface SteerResult extends GenerationRef { readonly steer: SteerReceipt }
export type OpenConversationPaneResult = { readonly status: "already-open" | "reopened" };

interface GenerationRecord { readonly conversation: Conversation; readonly generation: Generation }
interface BoundRecord { readonly conversationId: ConversationId; readonly binding: GenerationBinding }
type Reservation = GenerationRecord | { readonly error: string };
export interface OpenConversationPaneHandle { readonly surface: string; close(): void }
export interface OpenConversationPaneRequest { cwd: string; sessionFile: string; displayName?: string; piInvocation?: { command: string; args?: readonly string[] } }
export interface OpenConversationPaneDependencies {
  retainedPaneExists(surface: string): Promise<boolean | undefined>;
  reopenPaneExecution(options: OpenConversationPaneRequest): Promise<OpenConversationPaneHandle>;
  getPiInvocation(): { command: string; args: string[] };
}

const DEFAULT_OPEN_CONVERSATION_PANE_DEPENDENCIES: OpenConversationPaneDependencies = {
  retainedPaneExists: async () => undefined,
  reopenPaneExecution: async () => { throw new Error("Pane reopening is not configured."); },
  getPiInvocation: () => { throw new Error("Pane reopening is not configured."); },
};

export interface TerminalRecoveryV4Record {
  readonly version: 4;
  readonly subagentId: string;
  readonly generation: number;
  readonly agent: string;
  readonly label?: string;
  readonly kind: GenerationKind;
  readonly status: "completed" | "error" | "aborted" | "interrupted" | "skipped";
  readonly completedAt: number;
  readonly startedAt?: number;
  readonly elapsedMs?: number;
}

export interface TerminalRecoveryV5Record {
  readonly version: 5;
  readonly subagentId: string;
  readonly generation: number;
  readonly agent: string;
  readonly label: string;
  readonly kind: GenerationKind;
  readonly status: "completed" | "error" | "aborted" | "interrupted" | "skipped";
  readonly conversationCreatedAt: number;
  readonly createdAt: number;
  readonly completedAt: number;
  readonly startedAt?: number;
  readonly elapsedMs?: number;
  readonly prompt: string;
  readonly parentConversationId?: string;
  readonly startedInParentGeneration?: number;
  readonly requestedConfig: RequestedExecutionConfig;
  readonly requestedOverrides?: ExecutionOverrides;
  readonly retainedSessionFile?: string;
  readonly joined: boolean;
}

export type TerminalRecoveryRecord = TerminalRecoveryV4Record | TerminalRecoveryV5Record;

interface RecoveryGroup {
  readonly id: ConversationId;
  readonly records: readonly TerminalRecoveryRecord[];
}

interface RecoverableGroup {
  readonly id: ConversationId;
  readonly input: RestoredTerminalConversation;
  readonly completedAt: number;
}

export interface ActivePaneRecoveryGeneration {
  readonly generation: number;
  readonly kind: GenerationKind;
  readonly createdAt: number;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly status: "running" | "completed" | "error" | "aborted" | "interrupted" | "skipped";
  readonly prompt: string;
  readonly startedInParentGeneration?: number;
  readonly joined: boolean;
}

/** Structural lease shape; the persistence layer may own its concrete record type. */
export interface ActivePaneRecoveryRecord {
  readonly subagentId: string;
  readonly generation: number;
  readonly agent: string;
  readonly label: string;
  readonly kind: GenerationKind;
  readonly conversationCreatedAt: number;
  readonly createdAt: number;
  readonly startedAt: number;
  readonly prompt: string;
  readonly parentConversationId?: string;
  readonly startedInParentGeneration?: number;
  readonly requestedConfig: RequestedExecutionConfig;
  readonly requestedOverrides?: ExecutionOverrides;
  readonly retainedSessionFile: string;
  readonly paneSurface: string;
  readonly childId: string;
  readonly generations: readonly ActivePaneRecoveryGeneration[];
}

export type ActivePaneRecoveryResult =
  | { readonly ok: true; readonly conversationId: ConversationId; readonly generation: number }
  | { readonly ok: false; readonly conversationId: string; readonly generation?: number; readonly error: string };

export interface ActivePaneRecoveryDependencies {
  rebindPaneExecution: typeof rebindPaneExecution;
}

const DEFAULT_ACTIVE_PANE_RECOVERY_DEPENDENCIES: ActivePaneRecoveryDependencies = { rebindPaneExecution };

interface RecoverableActivePane {
  readonly id: ConversationId;
  readonly input: RestoredActiveConversation;
  readonly surface: string;
  readonly sessionFile: string;
  readonly childId: string;
  readonly completion?: PaneCompletionOutcome;
}

/** Owns retained conversations. Generations are addressed internally by their object identity. */
export class SubagentRuntime {
  private readonly conversations = new Map<ConversationId, Conversation>();
  private readonly listeners = new Set<ConversationUpdateListener>();
  private readonly deferredUpdates = new Map<Conversation, Set<ConversationUpdateKind>>();
  private updateDeferralDepth = 0;
  private readonly conversationIds = new ConversationIdAllocator();
  private readonly executionScheduler: GenerationScheduler;
  private readonly hydratedTerminalOutputs = new Set<string>();

  constructor(
    readonly registry: AgentRegistry,
    maxExecuting = 4,
    executor?: GenerationExecutor,
    private maximumConversations = 100,
    private readonly cancellationSettlementMs = 5_000,
    private readonly openPaneDependencies: OpenConversationPaneDependencies = DEFAULT_OPEN_CONVERSATION_PANE_DEPENDENCIES,
  ) {
    this.executionScheduler = new GenerationScheduler({ maxExecuting, ...(executor ? { executor } : {}), isTracked: conversation => this.conversations.get(conversation.conversationId) === conversation });
  }

  get scheduler(): GenerationScheduler { return this.executionScheduler; }
  get maxConversations(): number { return this.maximumConversations; }
  configure(options: { maxExecuting?: number; maxConversations?: number }): void {
    this.executionScheduler.configure(options);
    if (options.maxConversations !== undefined) this.maximumConversations = options.maxConversations;
  }
  onConversationUpdate(listener: ConversationUpdateListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  listConversations(): ConversationSnapshot[] { return [...this.conversations.values()].map(conversation => conversation.snapshot()); }
  queryConversations(callerConversationId?: ConversationId): ConversationSnapshot[] {
    return [...this.conversations.values()].filter(conversation => conversation.parentConversationId === callerConversationId).map(conversation => conversation.snapshot());
  }
  conversationDepth(conversationId: ConversationId, callerConversationId?: ConversationId): number {
    let current = this.requireConversation(conversationId);
    let depth = 1;
    const seen = new Set<ConversationId>();
    while (current.parentConversationId !== callerConversationId) {
      if (!current.parentConversationId || seen.has(current.conversationId)) throw new Error(`Conversation ${conversationId} is outside the requested conversation tree.`);
      seen.add(current.conversationId);
      current = this.requireConversation(current.parentConversationId);
      depth++;
    }
    return depth;
  }
  conversation(conversationId: string): ConversationSnapshot { return this.requireConversation(conversationId).snapshot(); }
  subagentStatus(conversationId: string): SubagentStatus { return projectSubagentStatus(this.requireConversation(conversationId).generationHistory.at(-1)!.status); }

  projectSubagent(conversationId: string, caller?: SubagentCaller, failureMode: FailureProjectionMode = "full"): CanonicalLiveSubagent {
    if (caller) this.requireCaller(caller, "inspect");
    const conversation = this.requireConversation(conversationId);
    const latest = conversation.generationHistory.at(-1)!;
    const directlyOwned = caller ? conversation.parentConversationId === caller.conversation.conversationId : conversation.parentConversationId === undefined;
    const inspectable = caller ? this.isDescendant(conversation, caller.conversation.conversationId) : true;
    const removableSubtree = this.conversationSubtree(conversation.conversationId).every(item => !item.hasActiveExecution);
    return projectLiveSubagent({
      subagentId: conversation.conversationId,
      label: conversation.label,
      agent: conversation.agentName,
      generation: latest.generation,
      generationStatus: latest.status,
      joined: latest.joined,
      directlyOwned,
      inspectable,
      resumeAllowed: conversation.isResumeAllowed,
      removableSubtree,
    }, failureMode);
  }

  restoreTerminalConversations(records: readonly TerminalRecoveryRecord[], maxRecoveredConversations?: number): number {
    const groups = new Map<string, TerminalRecoveryRecord[]>();
    for (const record of records) {
      if (!isRecoveryRecord(record)) continue;
      const group = groups.get(record.subagentId) ?? [];
      group.push(record);
      groups.set(record.subagentId, group);
    }

    const orderedGroups: RecoveryGroup[] = [];
    for (const [rawId, group] of groups) {
      if (!isConversationId(rawId) || this.conversations.has(rawId)) continue;
      const sorted = [...group].sort((left, right) => left.generation - right.generation);
      if (sorted.some((record, index) => index > 0 && record.generation === sorted[index - 1].generation)) continue;
      orderedGroups.push({ id: rawId, records: sorted });
    }
    orderedGroups.sort((left, right) => left.id.localeCompare(right.id));

    const recoverable = new Map<ConversationId, RecoverableGroup>();
    for (const group of orderedGroups) {
      const first = group.records[0];
      if (!first || first.generation !== 1 || !this.registry.agents.has(first.agent)) continue;
      if (group.records.some((record, index) => record.generation !== index + 1 || record.kind !== (index === 0 ? "spawn" : "resume") || record.agent !== first.agent)) continue;
      const definition = this.registry.agents.get(first.agent);
      if (!definition) continue;
      const input = this.toRestoredConversation(group.id, definition, group.records);
      if (!input) continue;
      try { Conversation.restoreTerminal(input, () => {}); }
      catch { continue; }
      recoverable.set(group.id, {
        id: group.id,
        input,
        completedAt: Math.max(...group.records.map(record => record.completedAt)),
      });
    }

    let selected: RecoverableGroup[];
    if (maxRecoveredConversations === undefined) {
      selected = [...recoverable.values()];
    } else {
      const selectedIds = new Set<ConversationId>();
      const candidates = [...recoverable.values()].sort((left, right) => right.completedAt - left.completedAt || left.id.localeCompare(right.id));
      for (const candidate of candidates) {
        const chain: RecoverableGroup[] = [];
        const seen = new Set<ConversationId>();
        let current: RecoverableGroup | undefined = candidate;
        while (current) {
          if (seen.has(current.id)) { chain.length = 0; break; }
          seen.add(current.id);
          chain.push(current);
          const parentId = current.input.parentConversationId;
          if (!parentId || this.conversations.has(parentId)) break;
          current = recoverable.get(parentId);
          if (!current) { chain.length = 0; break; }
        }
        const added = chain.filter(group => !selectedIds.has(group.id));
        if (!chain.length || selectedIds.size + added.length > maxRecoveredConversations) continue;
        for (const group of added) selectedIds.add(group.id);
        if (selectedIds.size === maxRecoveredConversations) break;
      }
      selected = [...recoverable.values()].filter(group => selectedIds.has(group.id));
    }

    let restored = 0;
    let pending = selected;
    while (pending.length > 0 && this.conversations.size < this.maxConversations) {
      const deferred: RecoverableGroup[] = [];
      let progressed = false;
      for (const group of pending) {
        if (this.conversations.size >= this.maxConversations) break;
        if (group.input.parentConversationId && !this.conversations.has(group.input.parentConversationId)) {
          deferred.push(group);
          continue;
        }
        try {
          const conversation = Conversation.restoreTerminal(group.input, (changed, kind) => this.updated(changed, kind));
          if (!this.conversationIds.claim(group.id)) continue;
          this.conversations.set(group.id, conversation);
          restored++;
          progressed = true;
        } catch {
          // Malformed historical data remains skipped without mutating runtime state.
        }
      }
      if (!progressed) break;
      pending = deferred;
    }
    return restored;
  }

  /**
   * Restores a mixed persisted graph. Active leases reserve capacity first; their terminal
   * ancestors are restored to a fixed point before ordinary terminal history fills the remainder.
   */
  async recoverPersistedConversations(
    terminalRecords: readonly TerminalRecoveryRecord[],
    activeRecords: readonly ActivePaneRecoveryRecord[],
    maxRecoveredConversations?: number,
    dependencies: ActivePaneRecoveryDependencies = DEFAULT_ACTIVE_PANE_RECOVERY_DEPENDENCIES,
  ): Promise<{ readonly active: readonly ActivePaneRecoveryResult[]; readonly terminals: number }> {
    const active = new Map<ConversationId, ActivePaneRecoveryRecord>();
    for (const record of activeRecords) {
      const candidate = this.toRecoverableActivePane(record);
      if (candidate && !this.conversations.has(candidate.id) && !active.has(candidate.id)) active.set(candidate.id, record);
    }
    const activeCandidates = [...active.values()];
    const maxTerminalRecoveries = maxRecoveredConversations ?? Number.POSITIVE_INFINITY;
    const priorityTerminalRecords = activeTerminalAncestors(terminalRecords, activeCandidates);
    let terminals = 0;
    const pendingActive = new Map(activeCandidates.map(record => [record.subagentId, record]));
    const activeResults = new Map<string, ActivePaneRecoveryResult>();

    // A terminal parent can depend on an active grandparent, so alternate until no edge resolves.
    while (pendingActive.size) {
      let progressed = false;
      const priorityCapacity = Math.max(0, this.maxConversations - this.conversations.size - pendingActive.size);
      const priorityBudget = Math.min(maxTerminalRecoveries - terminals, priorityCapacity);
      if (priorityBudget > 0) {
        const restored = this.restoreTerminalConversations(priorityTerminalRecords, priorityBudget);
        terminals += restored;
        progressed ||= restored > 0;
      }
      const ready = [...pendingActive.values()].filter(record => !record.parentConversationId || this.conversations.has(record.parentConversationId as ConversationId));
      if (!ready.length) {
        if (!progressed) break;
        continue;
      }
      const results = await this.restoreActivePaneConversations(ready, dependencies);
      for (let index = 0; index < ready.length; index++) {
        const record = ready[index];
        const result = results[index]!;
        pendingActive.delete(record.subagentId);
        activeResults.set(record.subagentId, result);
        if (result.ok) progressed = true;
      }
      if (!progressed) break;
    }
    for (const record of pendingActive.values()) {
      activeResults.set(record.subagentId, activeRecoveryFailure(record, `Parent conversation ${record.parentConversationId} is unavailable.`));
    }

    const remainingTerminalBudget = Math.min(
      maxTerminalRecoveries - terminals,
      Math.max(0, this.maxConversations - this.conversations.size),
    );
    if (remainingTerminalBudget > 0) {
      const restored = this.restoreTerminalConversations(terminalRecords, remainingTerminalBudget);
      terminals += restored;
    }
    return {
      active: activeRecords.map(record => activeResults.get(record.subagentId) ?? activeRecoveryFailure(record, "Invalid active pane recovery record.")),
      terminals,
    };
  }

  /** Restores only positively rebound, already-running panes; it never launches or schedules execution. */
  async restoreActivePaneConversations(
    records: readonly ActivePaneRecoveryRecord[],
    dependencies: ActivePaneRecoveryDependencies = DEFAULT_ACTIVE_PANE_RECOVERY_DEPENDENCIES,
  ): Promise<readonly ActivePaneRecoveryResult[]> {
    const results: ActivePaneRecoveryResult[] = new Array(records.length);
    const candidates = new Map<ConversationId, { index: number; value: RecoverableActivePane }>();
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      const candidate = this.toRecoverableActivePane(record);
      if (!candidate) results[index] = activeRecoveryFailure(record, "Invalid active pane recovery record.");
      else if (this.conversations.has(candidate.id) || candidates.has(candidate.id)) results[index] = activeRecoveryFailure(record, `Conversation ${candidate.id} is already claimed.`);
      else candidates.set(candidate.id, { index, value: candidate });
    }

    const pending = new Map(candidates);
    while (pending.size) {
      let progressed = false;
      for (const [id, candidate] of [...pending]) {
        const parentId = candidate.value.input.parentConversationId;
        if (parentId && !this.conversations.has(parentId)) {
          if (pending.has(parentId)) continue;
          results[candidate.index] = activeRecoveryFailure(records[candidate.index], `Parent conversation ${parentId} is unavailable.`);
          pending.delete(id);
          progressed = true;
          continue;
        }
        if (this.conversations.size >= this.maxConversations) {
          results[candidate.index] = activeRecoveryFailure(records[candidate.index], this.capacityError());
          pending.delete(id);
          progressed = true;
          continue;
        }
        try {
          await this.restoreActivePane(candidate.value, dependencies);
          results[candidate.index] = { ok: true, conversationId: id, generation: candidate.value.input.generations.at(-1)!.generation };
        } catch (error) {
          results[candidate.index] = activeRecoveryFailure(records[candidate.index], error instanceof Error ? error.message : String(error));
        }
        pending.delete(id);
        progressed = true;
      }
      if (!progressed) {
        for (const { index } of pending.values()) results[index] = activeRecoveryFailure(records[index], "Active recovery parent chain is cyclic.");
        break;
      }
    }
    return results;
  }

  private toRecoverableActivePane(record: ActivePaneRecoveryRecord): RecoverableActivePane | undefined {
    if (!isActivePaneRecoveryRecord(record) || !isRetainedSessionFile(record.retainedSessionFile)) return;
    const definition = this.registry.agents.get(record.agent);
    if (!definition) return;
    const latest = record.generations.at(-1);
    if (!latest || latest.status !== "running" || latest.startedAt === undefined) return;
    const generations: RestoredActiveConversation["generations"] = [
      ...record.generations.slice(0, -1).map(toRestoredTerminalGeneration),
      {
        generation: latest.generation,
        kind: latest.kind,
        ...(latest.startedInParentGeneration !== undefined ? { startedInParentGeneration: latest.startedInParentGeneration } : {}),
        prompt: latest.prompt,
        createdAt: latest.createdAt,
        status: { kind: "running", startedAt: latest.startedAt },
      },
    ];
    const input: RestoredActiveConversation = {
      conversationId: record.subagentId as ConversationId,
      definition,
      label: record.label,
      createdAt: record.conversationCreatedAt,
      ...(record.parentConversationId ? { parentConversationId: record.parentConversationId as ConversationId } : {}),
      requestedConfig: record.requestedConfig,
      ...(record.requestedOverrides ? { requestedOverrides: record.requestedOverrides } : {}),
      retainedSessionFile: record.retainedSessionFile,
      generations,
    };
    try { Conversation.restoreActive(input, () => {}); }
    catch { return; }
    const completion = readPaneCompletionOutcome(record.retainedSessionFile);
    return {
      id: input.conversationId,
      input,
      surface: record.paneSurface,
      sessionFile: record.retainedSessionFile,
      childId: record.childId,
      ...(completion ? { completion } : {}),
    };
  }

  private async restoreActivePane(candidate: RecoverableActivePane, dependencies: ActivePaneRecoveryDependencies): Promise<void> {
    // Construct the recovered state before claiming its finite ID.
    const conversation = Conversation.restoreActive(candidate.input, (changed, kind) => this.updated(changed, kind));
    const generation = conversation.latestGeneration;

    if (candidate.completion) {
      if (!this.conversationIds.claim(candidate.id)) throw new Error(`Conversation ${candidate.id} is already claimed.`);
      this.conversations.set(candidate.id, conversation);
      this.settleRecoveredPane(conversation, generation, candidate.completion);
      return;
    }

    const execution = await dependencies.rebindPaneExecution({
      surface: candidate.surface,
      sessionFile: candidate.sessionFile,
      childId: candidate.childId,
      onActivity: (snapshot, usage) => { if (snapshot) generation.activity.observe(snapshot, usage as never); },
    });
    if (!this.conversationIds.claim(candidate.id)) {
      execution.close();
      throw new Error(`Conversation ${candidate.id} is already claimed.`);
    }
    this.conversations.set(candidate.id, conversation);
    // bindControl emits the sole running-status update after the catalog can observe it.
    conversation.retainPaneSurface(execution.surface, () => execution.close());
    conversation.bindControl(generation, { steer: async text => execution.send(text), abort: async () => execution.interrupt() });
    execution.observeActivity();

    let finished = false;
    const finish = (outcome?: PaneCompletionOutcome, error?: unknown) => {
      if (finished) return;
      finished = true;
      if (error !== undefined) errorGeneration(conversation, generation, error instanceof Error ? error.message : String(error));
      else if (outcome) this.settleRecoveredPane(conversation, generation, outcome);
      execution.close();
      conversation.clearRetainedPaneSurface(execution.surface);
      conversation.executionSettled(generation);
    };
    void execution.waitForCompletion(undefined, () => execution.observeActivity()).then(
      outcome => finish(outcome),
      error => finish(undefined, error),
    );
  }

  private settleRecoveredPane(conversation: Conversation, generation: Generation, outcome: PaneCompletionOutcome): void {
    if (outcome.status === "cancelled") { interruptedGeneration(conversation, generation, "Agent interrupted."); return; }
    switch (outcome.completion.type) {
      case "structured_output": completedGeneration(conversation, generation, typeof outcome.completion.value === "string" ? outcome.completion.value : JSON.stringify(outcome.completion.value) ?? String(outcome.completion.value)); break;
      case "ping": outcome.completion.name === "__subagent_setup_error__"
        ? errorGeneration(conversation, generation, outcome.completion.message)
        : completedGeneration(conversation, generation, outcome.completion.message); break;
      case "failed": errorGeneration(conversation, generation, `Pane child exited with code ${outcome.completion.exitCode}.`); break;
      case "done": completedGeneration(conversation, generation, ""); break;
    }
  }

  private toRestoredConversation(id: ConversationId, definition: AgentDefinition, records: readonly TerminalRecoveryRecord[]): RestoredTerminalConversation | undefined {
    const first = records[0];
    if (!first) return;
    let metadata: TerminalRecoveryV5Record | undefined;
    for (let index = records.length - 1; index >= 0; index--) {
      const record = records[index];
      if (record.version === 5) { metadata = record; break; }
    }
    const parentConversationId = metadata?.parentConversationId !== undefined
      ? isConversationId(metadata.parentConversationId) ? metadata.parentConversationId : undefined
      : undefined;
    if (metadata?.parentConversationId !== undefined && !parentConversationId) return;
    const generations: RestoredTerminalGeneration[] = records.map(record => {
      const v5Record = record.version === 5;
      return {
        generation: record.generation,
        kind: record.kind,
        ...(v5Record && record.startedInParentGeneration !== undefined ? { startedInParentGeneration: record.startedInParentGeneration } : {}),
        prompt: v5Record ? record.prompt : "",
        createdAt: v5Record ? record.createdAt : record.completedAt,
        status: {
          kind: "done",
          outcome: record.status,
          ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
          completedAt: record.completedAt,
        },
        joined: v5Record ? record.joined : false,
      };
    });
    return {
      conversationId: id,
      definition,
      label: metadata?.label ?? first.label ?? first.agent,
      createdAt: metadata?.conversationCreatedAt ?? first.completedAt,
      ...(parentConversationId ? { parentConversationId } : {}),
      requestedConfig: metadata?.requestedConfig ?? {},
      ...(metadata?.requestedOverrides ? { requestedOverrides: metadata.requestedOverrides } : {}),
      ...(metadata?.retainedSessionFile ? { retainedSessionFile: metadata.retainedSessionFile } : {}),
      generations,
    };
  }

  /** Resolves and reserves the complete batch synchronously; executions never inherit caller cancellation. */
  startTasks(ctx: ExtensionContext, tasks: readonly (SpawnRequest | ResumeRequest)[], options: { caller?: SubagentCaller } = {}): GenerationHandle {
    const starts: OrderedStartOutcome[] = [];
    const executions: Promise<unknown>[] = [];
    const caller = options.caller;
    let callerError: string | undefined;
    if (caller) try { this.requireCaller(caller, "start"); } catch (error) { callerError = error instanceof Error ? error.message : String(error); }
    for (let inputIndex = 0; inputIndex < tasks.length; inputIndex++) {
      const task = tasks[inputIndex];
      const reservation: Reservation = callerError ? { error: callerError }
        : task.kind === "spawn" ? this.reserveSpawn(ctx, task, caller)
        : this.reserveResume(task, caller);
      if ("error" in reservation) { starts.push({ ok: false, inputIndex, error: reservation.error }); continue; }
      const { conversation, generation } = reservation;
      const execution = this.executionScheduler.schedule(ctx, undefined, conversation, generation).finally(() => conversation.executionSettled(generation));
      executions.push(execution);
      this.updated(conversation, "status");
      starts.push({ ok: true, inputIndex, conversationId: conversation.conversationId, generation: generation.number });
    }
    return { starts, completion: Promise.allSettled(executions).then(() => starts) };
  }

  private reserveSpawn(ctx: ExtensionContext, task: SpawnRequest, caller?: SubagentCaller): Reservation {
    const definition = this.registry.agents.get(task.agent);
    if (!definition) return { error: `Unknown agent: ${task.agent}.` };
    const requested = resolveRequestedConfig(definition, task);
    const model = resolveModel(requested.model, ctx.model, ctx.modelRegistry);
    if (!model.ok) return { error: model.error };
    const cwd = resolveTaskCwd(ctx.cwd, requested.cwd);
    if (!cwd.ok) return { error: cwd.error };
    if (this.conversations.size >= this.maxConversations) return { error: this.capacityError() };
    const conversationId = this.conversationIds.allocate();
    if (!conversationId) return { error: "Conversation ID space exhausted." };
    const conversation = new Conversation(conversationId, definition, task, (changed, kind) => this.updated(changed, kind), {
      ...(caller ? { parentConversationId: caller.conversation.conversationId, startedInParentGeneration: caller.generation.number } : {}),
    });
    this.conversations.set(conversationId, conversation);
    return { conversation, generation: conversation.latestGeneration };
  }

  private reserveResume(task: ResumeRequest, caller?: SubagentCaller): Reservation {
    const conversation = task.subagentId ? this.conversations.get(task.subagentId) : undefined;
    if (!conversation) return { error: new SubagentNotFoundError(String(task.subagentId)).message };
    if (caller && conversation.parentConversationId !== caller.conversation.conversationId) return { error: `Subagent ${conversation.conversationId} is not directly owned by caller subagent ${caller.conversation.conversationId}.` };
    if (!caller && conversation.parentConversationId) return { error: `Subagent ${conversation.conversationId} is not directly owned by the root agent.` };
    if (conversation.hasCurrentGeneration) {
      const status = conversation.status.kind;
      if (status === "running") return { error: `Subagent ${conversation.conversationId} is running. Join it before resuming, or steer it while it runs.` };
      if (status === "queued") return { error: `Subagent ${conversation.conversationId} is queued. Wait for or join it before resuming.` };
      return { error: `Subagent ${conversation.conversationId} cannot be resumed.` };
    }
    if (!conversation.isResumeAllowed) return { error: this.resumeError(conversation) };
    const sessionFile = conversation.sessionFileForResume();
    if (sessionFile && !isRetainedSessionFile(sessionFile)) return { error: `Subagent ${conversation.conversationId} retained session file is missing.` };
    return { conversation, generation: conversation.beginResume(task.prompt, caller?.generation.number) };
  }

  async steerSubagent(subagentId: SubagentId, prompt: string, caller?: SubagentCaller): Promise<SteerResult> {
    const record = this.latestSubagentRecord(subagentId);
    this.assertDirectOwner(record.conversation, caller, "steer");
    try {
      const steer = await record.conversation.steer(record.generation, prompt);
      return { conversationId: record.conversation.conversationId, generation: record.generation.number, steer };
    } catch (error) {
      if (error instanceof GenerationSteerError) {
        const status = error.status === "stopping" ? "cancelled" : projectSubagentGenerationStatus(error.status);
        throw new Error(`Subagent ${subagentId} is ${status} and cannot be steered.`);
      }
      throw error;
    }
  }

  async cancelSubagent(subagentId: SubagentId, caller?: SubagentCaller): Promise<GenerationRef> {
    const record = this.latestSubagentRecord(subagentId);
    this.assertDirectOwner(record.conversation, caller, "cancel");
    const snapshot = record.conversation.generationSnapshot(record.generation);
    if (snapshot.status.kind === "done") {
      const status = projectSubagentGenerationStatus(snapshot.status.outcome);
      if (status !== "cancelled") throw new Error(`Subagent ${subagentId} is ${status} and cannot be cancelled.`);
    } else {
      const wasQueued = snapshot.status.kind === "queued";
      void record.conversation.abort("Generation cancelled.");
      if (wasQueued) this.executionScheduler.cancelQueued(record.generation, record.conversation.generationSnapshot(record.generation));
    }
    await this.finishCancellation(record.conversation, record.generation);
    return { conversationId: record.conversation.conversationId, generation: record.generation.number };
  }

  inspectSubagents(subagentIds: readonly SubagentId[], caller?: SubagentCaller): Array<{ readonly conversationId: ConversationId; readonly snapshot: GenerationSnapshot }> {
    return subagentIds.map(subagentId => {
      const record = this.latestSubagentRecord(subagentId);
      this.assertDescendant(record.conversation, caller, "inspect");
      return { conversationId: record.conversation.conversationId, snapshot: record.conversation.generationSnapshot(record.generation) };
    });
  }
  validateSubagentJoin(subagentId: SubagentId, caller?: SubagentCaller): void { this.assertDirectOwner(this.requireConversation(subagentId), caller, "join"); }

  bindSubagentJoin(subagentIds: readonly SubagentId[], caller?: SubagentCaller, toolCallId?: string): JoinBinding | NestedJoinBinding {
    const records = subagentIds.map(subagentId => this.latestSubagentRecord(subagentId));
    for (const record of records) this.assertDirectOwner(record.conversation, caller, "join");
    return caller ? this.bindNestedJoin(caller, records, toolCallId) : this.withDeferredUpdates(() => this.bindRecords(records));
  }

  private bindNestedJoin(caller: SubagentCaller, records: readonly GenerationRecord[], toolCallId?: string): NestedJoinBinding {
    return this.withDeferredUpdates(() => {
      this.requireCaller(caller, "join");
      const initialTargets = records.map(record => generationRef(record));
      const attemptIndex = caller.conversation.beginNestedJoin(caller.generation, initialTargets, toolCallId);
      try { for (const record of records) this.assertDirectOwner(record.conversation, caller, "join"); }
      catch (error) {
        caller.conversation.updateNestedJoin(caller.generation, attemptIndex, { state: "failed", error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
      const base = this.bindRecords(records);
      let terminal = false;
      const targets = (): NestedJoinTargetSnapshot[] => base.project().map(value => ({ conversationId: value.conversationId, generation: value.generation, status: effectiveStatus(value.status) }));
      caller.conversation.updateNestedJoin(caller.generation, attemptIndex, { targets: targets() });
      void base.completion.then(() => {
        if (terminal) return;
        terminal = true;
        this.updateNestedJoin(caller, attemptIndex, { targets: targets(), state: "completed" });
      });
      return {
        owner: callerRef(caller),
        attemptIndex,
        get targets() { return base.targets; },
        completion: base.completion,
        project: () => base.project(),
        markJoined: () => base.markJoined(),
        release: () => base.release(),
        interrupt: (error = "Nested join interrupted.") => {
          if (terminal) return;
          terminal = true;
          this.updateNestedJoin(caller, attemptIndex, { targets: targets(), state: "interrupted", error });
          base.release();
        },
      };
    });
}

  async openConversationPane(ctx: ExtensionContext, conversationId: string): Promise<OpenConversationPaneResult> {
    const conversation = this.requireConversation(conversationId);
    if (conversation.hasActiveExecution || conversation.isStopping) throw new Error(`Subagent ${conversationId} is active and cannot be reopened.`);
    const sessionFile = conversation.sessionFileForResume();
    if (!conversation.isPaneOpenable || !sessionFile) throw new Error(`Subagent ${conversationId} does not have a retained pane session.`);
    if (!isRetainedSessionFile(sessionFile)) throw new Error(`Subagent ${conversationId} retained pane session file is missing.`);
    const retained = conversation.retainedPaneSurface();
    if (retained) {
      const exists = await this.openPaneDependencies.retainedPaneExists(retained);
      if (exists === true) return { status: "already-open" };
      if (exists === undefined) conversation.disposeRetainedPaneSurface(retained);
      else conversation.clearRetainedPaneSurface(retained);
    }
    const cwd = resolveTaskCwd(ctx.cwd, conversation.requestedConfig.cwd);
    if (!cwd.ok) throw new Error(cwd.error);
    const execution = await this.openPaneDependencies.reopenPaneExecution({
      cwd: cwd.value,
      sessionFile,
      displayName: conversation.label || conversation.agentName,
      piInvocation: this.openPaneDependencies.getPiInvocation(),
    });
    conversation.retainPaneSurface(execution.surface, () => execution.close());
    return { status: "reopened" };
  }

  generationSnapshot(reference: GenerationRef): GenerationSnapshot {
    const { conversation, generation } = this.resolveGeneration(reference);
    return conversation.generationSnapshot(generation);
  }
  generationCaller(reference: GenerationRef): SubagentCaller {
    const { conversation, generation } = this.resolveGeneration(reference);
    return { conversation, generation };
  }
  conversationDisplay(conversationId: ConversationId): ConversationDisplayIdentity {
    const conversation = this.requireConversation(conversationId);
    return { conversationId, label: conversation.label, agentName: conversation.agentName };
  }
  directChildGenerations(owner: GenerationRef): readonly GenerationRef[] {
    const { conversation: ownerConversation } = this.resolveGeneration(owner);
    return [...this.conversations.values()]
      .filter(conversation => conversation.parentConversationId === ownerConversation.conversationId)
      .flatMap(conversation => conversation.generationHistory
        .filter(generation => generation.startedInParentGeneration === owner.generation)
        .map(generation => ({ conversationId: conversation.conversationId, generation: generation.generation })));
  }
  unjoinedDirectChildGenerations(owner: GenerationRef): readonly GenerationRef[] {
    const ownerSnapshot = this.generationSnapshot(owner);
    const mentioned = new Set((ownerSnapshot.nestedJoins ?? []).flatMap(attempt => attempt.targets.map(generationKey)));
    return this.directChildGenerations(owner).filter(child => !mentioned.has(generationKey(child)));
  }

  private bindRecords(records: readonly GenerationRecord[]): JoinBinding {
    this.hydrateBoundTerminalOutputs(records);
    const attached: BoundRecord[] = [];
    try { for (const record of records) attached.push({ conversationId: record.conversation.conversationId, binding: record.conversation.bindGeneration(record.generation) }); }
    catch (error) { for (const item of attached) item.binding.release(); throw error; }
    let released = false;
    let resolve!: () => void;
    const completion = new Promise<void>(done => { resolve = done; });
    const check = () => { if (!released && attached.every(item => item.binding.snapshot().status.kind === "done")) resolve(); };
    const unsubscribe = this.onConversationUpdate(check);
    check();
    return {
      targets: Object.freeze(records.map(generationRef)),
      completion,
      project: () => attached.map(item => ({ conversationId: item.conversationId, generation: item.binding.generation.number, status: item.binding.snapshot().status })),
      markJoined: () => { for (const item of attached) if (item.binding.snapshot().status.kind === "done") item.binding.markJoined(); },
      release: () => { if (released) return; released = true; unsubscribe(); for (const item of attached) item.binding.release(); },
    };
  }
  private hydrateBoundTerminalOutputs(records: readonly GenerationRecord[]): void {
    for (const { conversation, generation } of records) {
      if (generation.state.kind !== "done" || generation.state.output !== undefined) continue;
      const sessionFile = conversation.sessionFileForResume();
      if (!sessionFile) continue;
      const key = generationKey({ conversationId: conversation.conversationId, generation: generation.number });
      if (this.hydratedTerminalOutputs.has(key)) continue;
      this.hydratedTerminalOutputs.add(key);
      const output = readPaneCompletionOutput(sessionFile);
      if (output !== undefined) conversation.hydrateTerminalOutput(generation, output);
    }
  }
  private updateNestedJoin(caller: SubagentCaller, index: number, update: { targets?: readonly NestedJoinTargetSnapshot[]; state?: "running" | "completed" | "failed" | "interrupted"; error?: string }): void {
    if (!this.isCurrentCaller(caller)) return;
    caller.conversation.updateNestedJoin(caller.generation, index, update);
  }

  /** Callers must use the exact latest generation of a retained conversation. */
  private requireCaller(caller: SubagentCaller, action: string): GenerationRecord {
    if (!this.isCurrentCaller(caller)) throw new Error(`${capitalize(action)} caller is no longer active.`);
    return caller;
  }
  private isCurrentCaller(caller: SubagentCaller): boolean {
    return this.conversations.get(caller.conversation.conversationId) === caller.conversation
      && caller.conversation.latestGeneration === caller.generation;
  }
  private assertDirectOwner(target: Conversation, caller: SubagentCaller | undefined, action: string): void {
    if (caller) {
      this.requireCaller(caller, action);
      if (target.parentConversationId !== caller.conversation.conversationId) throw new Error(`Subagent ${target.conversationId} is not directly owned by caller subagent ${caller.conversation.conversationId}.`);
      return;
    }
    if (target.parentConversationId) throw new Error(`Subagent ${target.conversationId} is not directly owned by the root agent.`);
  }
  private assertDescendant(target: Conversation, caller: SubagentCaller | undefined, action: string): void {
    if (!caller) return;
    this.requireCaller(caller, action);
    if (!this.isDescendant(target, caller.conversation.conversationId)) throw new Error(`Subagent ${target.conversationId} is not a descendant of caller subagent ${caller.conversation.conversationId}.`);
  }
  private isDescendant(target: Conversation, ancestorId: ConversationId): boolean {
    const seen = new Set<ConversationId>();
    let parentId = target.parentConversationId;
    while (parentId && !seen.has(parentId)) {
      if (parentId === ancestorId) return true;
      seen.add(parentId);
      parentId = this.conversations.get(parentId)?.parentConversationId;
    }
    return false;
  }
  private latestSubagentRecord(subagentId: SubagentId): GenerationRecord {
    const conversation = this.requireConversation(subagentId);
    return { conversation, generation: conversation.latestGeneration };
  }
  private resolveGeneration(reference: GenerationRef): GenerationRecord {
    const conversation = this.requireConversation(reference.conversationId);
    const generation = conversation.generation(reference.generation);
    if (!generation) throw new Error(`Unknown generation ${reference.generation} in conversation ${reference.conversationId}.`);
    return { conversation, generation };
  }

  async removeConversation(conversationId: string, caller?: SubagentCaller): Promise<RemoveOutcome> { return (await this.removeConversations([conversationId], caller))[0]; }
  async removeConversations(ids: readonly string[], caller?: SubagentCaller): Promise<RemoveOutcome[]> {
    const unique = [...new Set(ids)];
    const failures = new Map<string, Extract<RemoveOutcome, { ok: false }>>();
    const candidates: Conversation[] = [];
    const requestedIds = new Set(unique);
    for (const id of unique) {
      const conversation = this.conversations.get(id as ConversationId);
      if (!conversation) { failures.set(id, { ok: false, conversationId: id, error: new SubagentNotFoundError(id).message }); continue; }
      try { this.assertDirectOwner(conversation, caller, "remove"); candidates.push(conversation); }
      catch (error) {
        let ancestorId = conversation.parentConversationId;
        let covered = false;
        while (ancestorId) {
          if (requestedIds.has(ancestorId)) {
            try { this.assertDirectOwner(this.conversations.get(ancestorId)!, caller, "remove"); covered = true; break; } catch {}
          }
          ancestorId = this.conversations.get(ancestorId)?.parentConversationId;
        }
        if (covered) candidates.push(conversation);
        else failures.set(id, { ok: false, conversationId: id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const subtrees = new Map(candidates.map(conversation => [conversation.conversationId, this.conversationSubtree(conversation.conversationId)]));
    const requested = new Set(candidates.map(conversation => conversation.conversationId));
    const roots = candidates.filter(conversation => {
      let parentId = conversation.parentConversationId;
      while (parentId) { if (requested.has(parentId)) return false; parentId = this.conversations.get(parentId)?.parentConversationId; }
      return true;
    });
    const removed = new Set<ConversationId>();
    const removedConversations: Conversation[] = [];
    for (const root of roots) {
      const subtree = subtrees.get(root.conversationId)!;
      const active = subtree.filter(conversation => conversation.hasActiveExecution);
      if (active.length) {
        const error = `Subagent subtree ${root.conversationId} has active subagents: ${active.map(conversation => conversation.conversationId).join(", ")}. Cancel them before removal.`;
        for (const target of candidates) if (subtree.includes(target)) failures.set(target.conversationId, { ok: false, conversationId: target.conversationId, error });
        continue;
      }
      for (const conversation of [...subtree].reverse()) {
        conversation.disposeRetainedResources();
        this.conversations.delete(conversation.conversationId);
        removed.add(conversation.conversationId);
        removedConversations.push(conversation);
      }
    }
    for (const conversation of removedConversations) for (const listener of [...this.listeners]) try { listener(conversation, "removed"); } catch {}
    const claimed = new Set<ConversationId>();
    const attributed = new Map<ConversationId, ConversationId[]>();
    for (const conversation of [...candidates].sort((a, b) => subtrees.get(b.conversationId)!.length - subtrees.get(a.conversationId)!.length)) {
      const removedIds = subtrees.get(conversation.conversationId)!.map(item => item.conversationId).filter(id => removed.has(id) && !claimed.has(id)).reverse();
      for (const id of removedIds) claimed.add(id);
      attributed.set(conversation.conversationId, removedIds);
    }
    return unique.map(id => {
      const failure = failures.get(id);
      if (failure) return failure;
      const conversation = candidates.find(item => item.conversationId === id)!;
      if (!removed.has(conversation.conversationId)) return { ok: false as const, conversationId: id, error: `Subagent ${id} was not removed.` };
      return { ok: true as const, conversationId: conversation.conversationId, label: conversation.label, removedIds: attributed.get(conversation.conversationId)! };
    });
  }

  private conversationSubtree(rootId: ConversationId): Conversation[] {
    const result: Conversation[] = [];
    const visit = (conversation: Conversation) => {
      result.push(conversation);
      for (const child of this.conversations.values()) if (child.parentConversationId === conversation.conversationId) visit(child);
    };
    visit(this.requireConversation(rootId));
    return result;
  }
  private requireConversation(id: string): Conversation {
    const found = this.conversations.get(id as ConversationId);
    if (!found) throw new SubagentNotFoundError(id);
    return found;
  }
  private async finishCancellation(conversation: Conversation, generation: Generation): Promise<void> {
    const settled = await this.waitForCancellationSettlement(conversation);
    if (!settled && conversation.isStopping) {
      this.executionScheduler.abandon(generation, conversation.forceAbandonCancellation(generation));
    }
  }
  private waitForCancellationSettlement(conversation: Conversation): Promise<boolean> {
    if (!conversation.isStopping) return Promise.resolve(true);
    return new Promise(resolve => {
      let done = false;
      const finish = (settled: boolean) => { if (done) return; done = true; clearTimeout(timer); unsubscribe(); resolve(settled); };
      const unsubscribe = this.onConversationUpdate(updated => { if (updated === conversation && !conversation.isStopping) finish(true); });
      const timer = setTimeout(() => finish(false), this.cancellationSettlementMs);
      if (!conversation.isStopping) finish(true);
    });
  }
  private resumeError(conversation: Conversation): string {
    return conversation.isStopping
      ? `Subagent ${conversation.conversationId} is still settling a cancelled execution. Wait for it to finish before resuming.`
      : `Subagent ${conversation.conversationId} cannot be resumed.`;
  }
  private capacityError(): string {
    const removable = [...this.conversations.values()].filter(conversation => !conversation.hasActiveExecution).map(conversation => conversation.conversationId);
    return `Subagent capacity (${this.maxConversations}) reached. Remove inactive subagents${removable.length ? `: ${removable.join(", ")}` : " before spawning more"}.`;
  }
  private withDeferredUpdates<T>(operation: () => T): T {
    this.updateDeferralDepth++;
    try { return operation(); }
    finally {
      this.updateDeferralDepth--;
      if (this.updateDeferralDepth === 0) {
        const pending = [...this.deferredUpdates].flatMap(([conversation, kinds]) => [...kinds].map(kind => ({ conversation, kind })));
        this.deferredUpdates.clear();
        for (const { conversation, kind } of pending) this.updated(conversation, kind);
      }
    }
  }
  private updated(conversation: Conversation, kind: ConversationUpdateKind): void {
    if (this.conversations.get(conversation.conversationId) !== conversation) return;
    if (this.updateDeferralDepth > 0) {
      const kinds = this.deferredUpdates.get(conversation) ?? new Set<ConversationUpdateKind>();
      kinds.add(kind);
      this.deferredUpdates.set(conversation, kinds);
      return;
    }
    for (const listener of this.listeners) listener(conversation, kind);
  }
}

function isRetainedSessionFile(file: string): boolean {
  try { return statSync(file).isFile(); } catch { return false; }
}

function isActivePaneRecoveryRecord(record: ActivePaneRecoveryRecord): boolean {
  if (!isConversationId(record.subagentId) || !record.agent || !record.label || record.parentConversationId === record.subagentId || !isTimestamp(record.conversationCreatedAt)
    || !isTimestamp(record.createdAt) || !isTimestamp(record.startedAt) || typeof record.prompt !== "string"
    || !isRequestedConfig(record.requestedConfig) || !record.retainedSessionFile.trim() || !record.paneSurface.trim()
    || record.childId !== `${record.subagentId}:${record.generation}` || !Number.isSafeInteger(record.generation) || record.generation < 1
    || (record.parentConversationId !== undefined && !isConversationId(record.parentConversationId))
    || (record.startedInParentGeneration !== undefined && (!Number.isSafeInteger(record.startedInParentGeneration) || record.startedInParentGeneration < 1))
    || (record.requestedOverrides !== undefined && !isExecutionOverrides(record.requestedOverrides))
    || !Array.isArray(record.generations) || record.generations.length !== record.generation) return false;
  return record.generations.every((generation, index) => isActivePaneRecoveryGeneration(generation, index + 1))
    && record.generations.at(-1)?.status === "running"
    && record.generations.at(-1)?.startedAt === record.startedAt
    && record.kind === record.generations.at(-1)?.kind
    && record.createdAt === record.generations.at(-1)?.createdAt
    && record.prompt === record.generations.at(-1)?.prompt;
}

function isActivePaneRecoveryGeneration(generation: ActivePaneRecoveryGeneration, expected: number): boolean {
  if (generation.generation !== expected || generation.kind !== (expected === 1 ? "spawn" : "resume")
    || !isTimestamp(generation.createdAt) || typeof generation.prompt !== "string" || typeof generation.joined !== "boolean"
    || (generation.startedInParentGeneration !== undefined && (!Number.isSafeInteger(generation.startedInParentGeneration) || generation.startedInParentGeneration < 1))) return false;
  if (generation.status === "running") return generation.joined === false && isTimestamp(generation.startedAt) && generation.completedAt === undefined;
  return isTerminalRecoveryStatus(generation.status) && isTimestamp(generation.completedAt)
    && (generation.startedAt === undefined || isTimestamp(generation.startedAt));
}

function toRestoredTerminalGeneration(record: ActivePaneRecoveryGeneration): RestoredTerminalGeneration {
  return {
    generation: record.generation,
    kind: record.kind,
    ...(record.startedInParentGeneration !== undefined ? { startedInParentGeneration: record.startedInParentGeneration } : {}),
    prompt: record.prompt,
    createdAt: record.createdAt,
    status: {
      kind: "done",
      outcome: record.status as RestoredTerminalGeneration["status"]["outcome"],
      ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
      completedAt: record.completedAt!,
    },
    joined: record.joined,
  };
}

function activeRecoveryFailure(record: Partial<ActivePaneRecoveryRecord>, error: string): ActivePaneRecoveryResult {
  return { ok: false, conversationId: typeof record.subagentId === "string" ? record.subagentId : "", ...(typeof record.generation === "number" ? { generation: record.generation } : {}), error };
}

function activeTerminalAncestors(records: readonly TerminalRecoveryRecord[], active: readonly ActivePaneRecoveryRecord[]): TerminalRecoveryRecord[] {
  const byId = new Map<ConversationId, TerminalRecoveryRecord[]>();
  for (const record of records) {
    if (!isRecoveryRecord(record)) continue;
    const id = record.subagentId as ConversationId;
    const group = byId.get(id) ?? [];
    group.push(record);
    byId.set(id, group);
  }
  const required = new Set<ConversationId>();
  const visit = (rawParentId: string | undefined, seen: Set<ConversationId>) => {
    if (!rawParentId || !isConversationId(rawParentId)) return;
    const parentId = rawParentId as ConversationId;
    if (seen.has(parentId)) return;
    seen.add(parentId);
    const group = byId.get(parentId);
    if (!group) return;
    required.add(parentId);
    const latest = [...group].sort((left, right) => right.generation - left.generation)[0];
    if (latest?.version === 5) visit(latest.parentConversationId, seen);
  };
  for (const record of active) visit(record.parentConversationId, new Set());
  return records.filter(record => isRecoveryRecord(record) && required.has(record.subagentId as ConversationId));
}

function isRecoveryRecord(value: unknown): value is TerminalRecoveryRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if ((record.version !== 4 && record.version !== 5) || typeof record.subagentId !== "string" || !isConversationId(record.subagentId)
    || !Number.isSafeInteger(record.generation) || (record.generation as number) < 1 || typeof record.agent !== "string" || !record.agent
    || (record.kind !== "spawn" && record.kind !== "resume") || !isTerminalRecoveryStatus(record.status)
    || !isTimestamp(record.completedAt)) return false;
  if (record.startedAt !== undefined && !isTimestamp(record.startedAt)) return false;
  if (record.elapsedMs !== undefined && !isTimestamp(record.elapsedMs)) return false;
  if (record.version === 4) return record.label === undefined || typeof record.label === "string";
  return typeof record.label === "string" && isTimestamp(record.conversationCreatedAt) && isTimestamp(record.createdAt)
    && typeof record.prompt === "string" && isRequestedConfig(record.requestedConfig) && typeof record.joined === "boolean"
    && (record.parentConversationId === undefined || isConversationId(record.parentConversationId))
    && (record.startedInParentGeneration === undefined || (Number.isSafeInteger(record.startedInParentGeneration) && (record.startedInParentGeneration as number) >= 1))
    && (record.requestedOverrides === undefined || isExecutionOverrides(record.requestedOverrides))
    && (record.retainedSessionFile === undefined || (typeof record.retainedSessionFile === "string" && record.retainedSessionFile.length > 0));
}

function isTerminalRecoveryStatus(value: unknown): value is TerminalRecoveryRecord["status"] {
  return value === "completed" || value === "error" || value === "aborted" || value === "interrupted" || value === "skipped";
}
function isTimestamp(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function isRequestedConfig(value: unknown): value is RequestedExecutionConfig {
  if (!isObject(value) || Object.keys(value).some(key => !["model", "thinking", "skills", "tools", "cwd"].includes(key))) return false;
  return (value.model === undefined || typeof value.model === "string")
    && (value.thinking === undefined || isModelThinkingLevel(value.thinking))
    && (value.cwd === undefined || typeof value.cwd === "string")
    && (value.skills === undefined || isStringArray(value.skills))
    && (value.tools === undefined || isStringArray(value.tools));
}
function isExecutionOverrides(value: unknown): value is ExecutionOverrides {
  return isObject(value) && Object.keys(value).every(key => key === "model" || key === "thinking")
    && (value.model === undefined || typeof value.model === "string")
    && (value.thinking === undefined || isModelThinkingLevel(value.thinking));
}
function isStringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === "string"); }

function generationRef(record: GenerationRecord): GenerationRef { return { conversationId: record.conversation.conversationId, generation: record.generation.number }; }
function callerRef(caller: SubagentCaller): GenerationRef { return { conversationId: caller.conversation.conversationId, generation: caller.generation.number }; }
function capitalize(value: string): string { return value[0].toUpperCase() + value.slice(1); }
