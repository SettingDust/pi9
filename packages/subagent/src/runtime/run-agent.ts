import { readFileSync } from "node:fs";
import path from "node:path";

import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ExtensionContext,
  getAgentDir,
  SessionManager,
  stripFrontmatter,
  SettingsManager,
  type AgentSession,
  type ModelRegistry,
  type ResourceLoader,
  type Skill,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { Agent } from "../domain/agent.js";
import type { Attempt } from "../domain/agent-attempt.js";
import { discoverInheritedExtensionPaths } from "./extension-paths.js";
import { timingAsync } from "./timing.js";
import { completedRun, errorRun, interruptedRun, skippedRun } from "../domain/agent-finalize.js";
import type { AgentSnapshot } from "../domain/agent-snapshot.js";

export interface RunAgentDependencies {
  ResourceLoader: typeof DefaultResourceLoader;
  getAgentDir: typeof getAgentDir;
  createAgentSession: typeof createAgentSession;
  sessionManager: typeof SessionManager.inMemory;
  settingsManager: typeof SettingsManager.create;
  readSkillFile: typeof readFileSync;
  loadExtensionPaths: (cwd: string, agentDir: string) => Promise<string[]>;
  childToolFor?: (agent: Agent) => ToolDefinition;
}

export const DefaultRunAgentDependencies: RunAgentDependencies = {
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
    const available = this.source.getSkills().skills;
    const matched = this.requestedSkills.map(name => available.find(skill => skill.name === name));
    if (matched.some(skill => skill === undefined) || matched.length === 0) return this.baseSystemPrompt;
    return `${this.baseSystemPrompt}\n\n${(matched as Skill[]).map(skill => this.skillBlock(skill)).join("\n\n")}`;
  }

  assertRequestedSkillsAvailable(allowMissing = false) {
    const available = this.source.getSkills().skills;
    const matched = this.requestedSkills.map(name => available.find(skill => skill.name === name));
    const missingIndex = matched.findIndex(skill => skill === undefined);
    if (missingIndex >= 0 && !allowMissing) throw new Error(`Unknown skill: ${this.requestedSkills[missingIndex]}`);
    for (const skill of matched) if (skill) this.skillBlock(skill);
  }

  private skillBlock(skill: Skill) {
    const body = stripFrontmatter(this.readSkillFile(skill.filePath, "utf-8")).trim();
    return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
  }

  mayDiscoverExtensionSkills() {
    return this.source.getExtensions().extensions.some(extension =>
      (extension.handlers.get("resources_discover")?.length ?? 0) > 0,
    );
  }

  extendResources(paths: Parameters<ResourceLoader["extendResources"]>[0]) { this.source.extendResources(paths); }
  reload(options?: Parameters<ResourceLoader["reload"]>[0]) { return this.source.reload(options); }
}

export async function RunAttempt(
  ctx: ExtensionContext,
  agent: Agent,
  attempt: Attempt,
  signal?: AbortSignal,
  dependencies: RunAgentDependencies = DefaultRunAgentDependencies,
): Promise<AgentSnapshot> {
  if (attempt.kind === "resume") {
    const session = agent.retainedSession();
    if (!session) {
      throw new Error(`Cannot resume an agent without a retained session.`);
    }
    agent.bindSession(session);
    return PromptAgent(session, agent, attempt, signal);
  }

  if (signal?.aborted) return skippedRun(agent);

  const runData = { agent: agent.agentName, sessionId: agent.id, parentSessionId: agent.parentId };
  const requestedConfig = agent.requestedConfig;
  const cwd = ResolveTaskCwd(ctx.cwd, requestedConfig.cwd);
  const agentDir = dependencies.getAgentDir();
  const settingsManager = dependencies.settingsManager(cwd, agentDir);
  if (typeof settingsManager.setProjectTrusted === "function" && typeof ctx.isProjectTrusted === "function") {
    settingsManager.setProjectTrusted(ctx.isProjectTrusted());
  }

  const requestedSkills = requestedConfig.skills ?? [];
  const inheritedExtensionPaths = await dependencies.loadExtensionPaths(cwd, agentDir);
  const childTool = dependencies.childToolFor?.(agent);

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

  await timingAsync("runAgent.resourceLoader.reload", { ...runData, cwd }, () => resourceLoader.reload());
  if (signal?.aborted) return skippedRun(agent);

  if (requestedSkills.length > 0) {
    try {
      resourceLoader.assertRequestedSkillsAvailable(resourceLoader.mayDiscoverExtensionSkills());
    } catch (error) {
      return errorRun(agent, RequestedSkillError(error));
    }
  }

  const selectedModel = SelectModel(requestedConfig.model, ctx.model, ctx.modelRegistry);
  const requestedThinking = requestedConfig.thinking;
  const sessionManager = dependencies.sessionManager(cwd);
  let session: AgentSession;
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
    return errorRun(agent, RequestedSkillError(error));
  }

  try {
    if (typeof session.bindExtensions === "function") {
      await session.bindExtensions({ mode: "print" });
    }
    if (requestedSkills.length > 0) resourceLoader.assertRequestedSkillsAvailable();
  } catch (error) {
    session.dispose();
    return errorRun(agent, RequestedSkillError(error));
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
    return skippedRun(agent);
  }

  agent.bindSession(session);
  return PromptAgent(session, agent, attempt, signal);
}

async function PromptAgent(
  session: AgentSession,
  agent: Agent,
  attempt: Attempt,
  signal?: AbortSignal,
): Promise<AgentSnapshot> {
  const prompt = attempt.prompt;
  const onAbort = () => { void AbortSession(session); }

  if (signal?.aborted) {
    await AbortSession(session);
    return interruptedRun(agent, "Agent interrupted.");
  }

  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    await timingAsync("runAgent.session.prompt", { agent: agent.agentName, sessionId: agent.id, promptLength: prompt.length }, () => session.prompt(prompt));
    const finalMessage = GetFinalAssistantMessage(session);
    if (finalMessage.stopReason === "aborted") {
      return interruptedRun(agent, finalMessage.errorMessage || "Agent interrupted.");
    }
    if (finalMessage.stopReason === "error") {
      return errorRun(agent, finalMessage.errorMessage || finalMessage.response || "Agent failed.");
    }

    const response = agent.message || finalMessage.response;
    return completedRun(agent, response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return signal?.aborted
      ? interruptedRun(agent, message)
      : errorRun(agent, message);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

function RequestedSkillError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("Unknown skill:") ? message : `Could not load requested skill: ${message}`;
}

async function AbortSession(session: AgentSession) {
  await Promise.resolve(session.abort()).catch(() => undefined);
}

function ResolveTaskCwd(ctxCwd: string, taskCwd: string | undefined) {
  if (!taskCwd) return ctxCwd;
  return path.isAbsolute(taskCwd) ? taskCwd : path.resolve(ctxCwd, taskCwd);
}

function SelectModel(
  agentModel: string | undefined,
  parentModel: Model<any> | undefined,
  registry: ModelRegistry,
): Model<any> | undefined {
  if (!agentModel) return parentModel;

  let modelId: string;
  let provider: string | undefined;

  const parts = agentModel.split("/");
  if (parts.length == 1) {
    modelId = parts[0];
  } else if (parts.length == 2) {
    provider = parts[0];
    modelId = parts[1];
  } else {
    return parentModel;
  }

  if (provider) {
    for (const model of registry.getAll()) {
      if (model.provider == provider && model.id == modelId) return model;
    }
  } else {
    const candidates = registry.getAll().filter((model) => model.id == modelId);
    // Prefer, but do not require, the same provider as the default model
    const sameProvider = candidates.find((model) => model.provider === parentModel?.provider);
    return sameProvider ?? candidates[0] ?? parentModel;
  }

  return parentModel;
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
