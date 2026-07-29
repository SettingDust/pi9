import { readFileSync, statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultPackageManager,
  DefaultResourceLoader,
  type ExtensionContext,
  getAgentDir,
  SessionManager,
  SettingsManager,
  stripFrontmatter,
  type AgentSession,
  type AgentSessionEvent,
  type ModelRegistry,
  type ResourceLoader,
  type Skill,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Conversation, type Run, type RunSnapshot, completedRun, errorRun, interruptedRun, skippedRun } from "./conversation.js";
import { timingAsync } from "./timing.js";

const ownExtensionPath = fileURLToPath(new URL("./index.ts", import.meta.url));

export async function discoverInheritedExtensionPaths(cwd: string, agentDir: string): Promise<string[]> {
  const settingsManager = SettingsManager.create(cwd, agentDir);
  await settingsManager.reload();

  const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  const resolved = await packageManager.resolve();
  const ownCanonicalPath = await canonicalPath(ownExtensionPath);
  const seen = new Set<string>();
  const inherited: string[] = [];

  for (const entry of resolved.extensions) {
    if (!entry.enabled) continue;
    const canonical = await canonicalPath(entry.path);
    if (canonical === ownCanonicalPath || seen.has(canonical)) continue;
    seen.add(canonical);
    inherited.push(entry.path);
  }

  return inherited;
}

async function canonicalPath(file: string): Promise<string> {
  try {
    return await realpath(file);
  } catch {
    return path.resolve(file);
  }
}

export interface ExecuteRunDependencies {
  ResourceLoader: typeof DefaultResourceLoader;
  getAgentDir: typeof getAgentDir;
  createAgentSession: typeof createAgentSession;
  sessionManager: typeof SessionManager.inMemory;
  settingsManager: typeof SettingsManager.create;
  readSkillFile: typeof readFileSync;
  loadExtensionPaths: (cwd: string, agentDir: string) => Promise<string[]>;
  childToolFor?: (agent: Conversation) => ToolDefinition;
  childSessionEvent?: (agent: Conversation, run: Run, event: AgentSessionEvent) => void;
}

export const DEFAULT_EXECUTE_RUN_DEPENDENCIES: ExecuteRunDependencies = {
  ResourceLoader: DefaultResourceLoader,
  getAgentDir,
  createAgentSession,
  sessionManager: SessionManager.inMemory,
  settingsManager: SettingsManager.create,
  readSkillFile: readFileSync,
  loadExtensionPaths: discoverInheritedExtensionPaths,
};

class SelectedSkillResourceLoader implements ResourceLoader {
  constructor(
    private readonly source: ResourceLoader,
    private readonly baseSystemPrompt: string,
    private readonly requestedSkills: readonly string[],
    private readonly readSkillFile: typeof readFileSync,
  ) {}

  getExtensions() { return this.source.getExtensions(); }
  getSkills() { return { skills: [], diagnostics: this.source.getSkills().diagnostics }; }
  getPrompts() { return this.source.getPrompts(); }
  getThemes() { return this.source.getThemes(); }
  getAgentsFiles() { return this.source.getAgentsFiles(); }
  getAppendSystemPrompt() { return []; }

  getSystemPrompt() {
    const matched = this.requestedSkills.map(name => this.source.getSkills().skills.find(skill => skill.name === name));
    if (matched.some(skill => skill === undefined) || matched.length === 0) return this.baseSystemPrompt;
    return `${this.baseSystemPrompt}\n\n${(matched as Skill[]).map(skill => this.skillBlock(skill)).join("\n\n")}`;
  }

  missingRequestedSkills() {
    const available = this.source.getSkills().skills;
    return this.requestedSkills.filter(name => !available.some(skill => skill.name === name));
  }

  assertRequestedSkillsAvailable(allowMissing = false) {
    const available = this.source.getSkills().skills;
    for (const name of this.requestedSkills) {
      const skill = available.find(candidate => candidate.name === name);
      if (!skill) {
        if (!allowMissing) throw new Error(`Unknown skill: ${name}`);
        continue;
      }
      this.skillBlock(skill);
    }
  }

  mayDiscoverExtensionSkills() {
    return this.source.getExtensions().extensions.some(extension =>
      (extension.handlers.get("resources_discover")?.length ?? 0) > 0,
    );
  }

  extendResources(paths: Parameters<ResourceLoader["extendResources"]>[0]) { this.source.extendResources(paths); }
  reload(options?: Parameters<ResourceLoader["reload"]>[0]) { return this.source.reload(options); }

  private skillBlock(skill: Skill) {
    const body = stripFrontmatter(this.readSkillFile(skill.filePath, "utf-8")).trim();
    return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
  }
}

export async function executeRun(
  ctx: ExtensionContext,
  agent: Conversation,
  run: Run,
  signal?: AbortSignal,
  dependencies: ExecuteRunDependencies = DEFAULT_EXECUTE_RUN_DEPENDENCIES,
): Promise<RunSnapshot> {
  if (run.kind === "resume") {
    const session = agent.sessionForResume();
    if (!session) {
      throw new Error(`Cannot resume an agent without a conversation session.`);
    }
    agent.bindSession(session);
    return PromptAgent(session, agent, run, signal, dependencies.childSessionEvent);
  }

  if (signal?.aborted) return skippedRun(agent, run.runId);

  const runData = { agent: agent.agentName, conversationId: agent.conversationId, parentConversationId: agent.parent?.conversationId };
  const requestedConfig = agent.requestedConfig;
  const cwdResolution = resolveTaskCwd(ctx.cwd, requestedConfig.cwd);
  if (!cwdResolution.ok) return errorRun(agent, run.runId, cwdResolution.error);
  const modelResolution = resolveModel(requestedConfig.model, ctx.model, ctx.modelRegistry);
  if (!modelResolution.ok) return errorRun(agent, run.runId, modelResolution.error);

  const cwd = cwdResolution.value;
  const selectedModel = modelResolution.value;
  const agentDir = dependencies.getAgentDir();

  const requestedSkills = [...new Set(requestedConfig.skills ?? [])];
  const inheritedExtensionPaths = await dependencies.loadExtensionPaths(cwd, agentDir);
  const childTool = dependencies.childToolFor?.(agent);
  const settingsManager = dependencies.settingsManager(cwd, agentDir);
  if (typeof settingsManager.setProjectTrusted === "function" && typeof ctx.isProjectTrusted === "function") {
    settingsManager.setProjectTrusted(ctx.isProjectTrusted());
  }

  const discoveredResources = new dependencies.ResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    additionalExtensionPaths: inheritedExtensionPaths,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  const resourceLoader = new SelectedSkillResourceLoader(
    discoveredResources,
    agent.config.systemPrompt,
    requestedSkills,
    dependencies.readSkillFile,
  );

  try {
    await timingAsync("runAgent.resourceLoader.reload", { ...runData, cwd }, () => resourceLoader.reload());
  } catch (error) {
    if (isRunDone(run)) return existingRun(agent, run);
    return errorRun(agent, run.runId, errorMessage(error));
  }
  if (isRunDone(run)) return existingRun(agent, run);
  let needsExtensionDiscovery = false;
  if (requestedSkills.length > 0) {
    try {
      needsExtensionDiscovery = resourceLoader.missingRequestedSkills().length > 0
        && resourceLoader.mayDiscoverExtensionSkills();
      resourceLoader.assertRequestedSkillsAvailable(needsExtensionDiscovery);
    } catch (error) {
      return errorRun(agent, run.runId, requestedSkillError(error));
    }
  }
  if (signal?.aborted) return skippedRun(agent, run.runId);

  const requestedThinking = requestedConfig.thinking;
  const sessionManager = dependencies.sessionManager(cwd);
  let session: AgentSession | undefined;
  try {
    ({ session } = await timingAsync("runAgent.createAgentSession", { ...runData, cwd, model: selectedModel ? `${selectedModel.provider}/${selectedModel.id}` : undefined }, () => dependencies.createAgentSession({
      cwd,
      agentDir,
      resourceLoader,
      model: selectedModel,
      thinkingLevel: requestedThinking,
      tools: requestedConfig.tools ? [...requestedConfig.tools] : undefined,
      customTools: childTool ? [childTool] : [],
      sessionManager,
      settingsManager,
    })));
  } catch (error) {
    if (isRunDone(run)) return existingRun(agent, run);
    return errorRun(agent, run.runId, errorMessage(error));
  }

  if (!session) return errorRun(agent, run.runId, "Could not create agent session.");
  if (isRunDone(run)) {
    session.dispose();
    return existingRun(agent, run);
  }
  try {
    if (needsExtensionDiscovery && typeof session.bindExtensions === "function") {
      await session.bindExtensions({ mode: "print" });
    }
  } catch (error) {
    session.dispose();
    if (isRunDone(run)) return existingRun(agent, run);
    return errorRun(agent, run.runId, errorMessage(error));
  }
  if (isRunDone(run)) {
    session.dispose();
    return existingRun(agent, run);
  }
  if (requestedSkills.length > 0) {
    try {
      resourceLoader.assertRequestedSkillsAvailable();
    } catch (error) {
      session.dispose();
      return errorRun(agent, run.runId, requestedSkillError(error));
    }
  }
  const effectiveModel = session.model ?? selectedModel;
  const effectiveThinking = session.thinkingLevel ?? requestedThinking;
  const activeTools = typeof session.getActiveToolNames === "function"
    ? session.getActiveToolNames()
    : requestedConfig.tools ?? [];
  agent.setEffectiveConfig({
    ...(effectiveModel ? { model: `${effectiveModel.provider}/${effectiveModel.id}` } : {}),
    ...(effectiveThinking ? { thinking: effectiveThinking as ModelThinkingLevel } : {}),
    cwd,
    skills: requestedSkills,
    tools: activeTools,
  });

  if (signal?.aborted) {
    await AbortSession(session);
    session.dispose();
    return skippedRun(agent, run.runId);
  }

  agent.bindSession(session);
  return PromptAgent(session, agent, run, signal, dependencies.childSessionEvent);
}

async function PromptAgent(
  session: AgentSession,
  agent: Conversation,
  run: Run,
  signal?: AbortSignal,
  onSessionEvent?: (agent: Conversation, run: Run, event: AgentSessionEvent) => void,
): Promise<RunSnapshot> {
  const prompt = run.prompt;
  const onAbort = () => { void AbortSession(session); }

  if (signal?.aborted) {
    await AbortSession(session);
    return interruptedRun(agent, run.runId, "Agent interrupted.");
  }

  signal?.addEventListener("abort", onAbort, { once: true });
  const unsubscribe = onSessionEvent ? session.subscribe(event => onSessionEvent(agent, run, event)) : undefined;

  try {
    await timingAsync("runAgent.session.prompt", { agent: agent.agentName, conversationId: agent.conversationId, promptLength: prompt.length }, () => session.prompt(prompt));
    const finalMessage = GetFinalAssistantMessage(session);
    if (finalMessage.stopReason === "aborted") {
      return interruptedRun(agent, run.runId, finalMessage.errorMessage || "Agent interrupted.");
    }
    if (finalMessage.stopReason === "error") {
      return errorRun(agent, run.runId, finalMessage.errorMessage || finalMessage.response || "Agent failed.");
    }

    return completedRun(agent, run.runId, finalMessage.response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return signal?.aborted
      ? interruptedRun(agent, run.runId, message)
      : errorRun(agent, run.runId, message);
  } finally {
    unsubscribe?.();
    signal?.removeEventListener("abort", onAbort);
  }
}

function isRunDone(run: Run): boolean {
  return run.state.kind === "done";
}

function existingRun(agent: Conversation, run: Run): RunSnapshot {
  return agent.runHistory.find(item => item.runId === run.runId)!;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function requestedSkillError(error: unknown) {
  const message = errorMessage(error);
  return message.startsWith("Unknown skill:") ? message : `Could not load requested skill: ${message}`;
}

async function AbortSession(session: AgentSession) {
  await Promise.resolve(session.abort()).catch(() => undefined);
}

export type RunAgentResolution<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

export function resolveTaskCwd(
  parentCwd: string,
  requestedCwd: string | undefined,
): RunAgentResolution<string> {
  if (requestedCwd === undefined) return { ok: true, value: parentCwd };

  const cwd = path.resolve(parentCwd, requestedCwd);
  try {
    if (!statSync(cwd).isDirectory()) {
      return { ok: false, error: `Working directory is not a directory: ${cwd}` };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, error: `Working directory does not exist: ${cwd}` };
    if (code === "ENOTDIR") return { ok: false, error: `Working directory is not a directory: ${cwd}` };
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Could not access working directory ${cwd}: ${message}` };
  }

  return { ok: true, value: cwd };
}

export function resolveModel(
  requestedModel: string | undefined,
  parentModel: Model<any> | undefined,
  registry: ModelRegistry,
): RunAgentResolution<Model<any> | undefined> {
  if (requestedModel === undefined) return { ok: true, value: parentModel };

  const parts = requestedModel.split("/");
  if (parts.some(part => part.trim().length === 0)) {
    return {
      ok: false,
      error: `Invalid model "${requestedModel}": model references cannot be blank or contain empty slash-delimited parts.`,
    };
  }

  const models = registry.getAll();
  const canonical = models.find(model => `${model.provider}/${model.id}` === requestedModel);
  if (canonical) return { ok: true, value: canonical };

  const candidates = models.filter(model => model.id === requestedModel);
  const sameProvider = candidates.find(model => model.provider === parentModel?.provider);
  if (sameProvider) return { ok: true, value: sameProvider };
  if (candidates.length === 1) return { ok: true, value: candidates[0] };
  if (candidates.length > 1) {
    const matches = candidates.map(model => `${model.provider}/${model.id}`).join(", ");
    return {
      ok: false,
      error: `Ambiguous model "${requestedModel}": matches ${matches}. Use a provider-qualified model reference.`,
    };
  }

  return { ok: false, error: `Unknown model: ${requestedModel}` };
}

function GetFinalAssistantMessage(
  session: AgentSession,
): { response: string; stopReason?: string; errorMessage?: string } {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i];
    if (msg.role == "assistant") {
      return {
        response: msg.content
          .filter(part => part.type === "text")
          .map(part => part.text)
          .join("\n")
          .trim() ?? "",
        stopReason: msg.stopReason,
        errorMessage: msg.errorMessage,
      };
    }
  }
  return { response: "" };
}
