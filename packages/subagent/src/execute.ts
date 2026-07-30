import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Model } from "@earendil-works/pi-ai";
import {
  DefaultPackageManager,
  type ExtensionContext,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { Conversation, type Run, type RunSnapshot, completedRun, errorRun, interruptedRun, skippedRun } from "./conversation.js";
import { launchPaneExecution, observePaneCompletion, type PaneCompletion, type PaneExecutionHandle } from "./pane-execution.js";
import { readPaneActivity } from "./pane-activity.js";

const ownExtensionPath = fileURLToPath(new URL("./index.ts", import.meta.url));
const paneChildExtensionPath = fileURLToPath(new URL("./pane-child.ts", import.meta.url));
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
getPiInvocation: () => { command: string; args: string[] };
  getAgentDir: typeof getAgentDir;
  sessionManager: typeof SessionManager.create;
  loadExtensionPaths: (cwd: string, agentDir: string) => Promise<string[]>;
  launchPaneExecution: typeof launchPaneExecution;
  observePaneCompletion: typeof observePaneCompletion;
  readSessionFile: typeof readFileSync;
  ownExtensionPath: string;
  [legacyDependency: string]: unknown;
}

export const DEFAULT_EXECUTE_RUN_DEPENDENCIES: ExecuteRunDependencies = {
getPiInvocation: resolveCurrentPiInvocation,
  getAgentDir,
  sessionManager: SessionManager.create,
  loadExtensionPaths: discoverInheritedExtensionPaths,
  launchPaneExecution,
  observePaneCompletion,
  readSessionFile: readFileSync,
  ownExtensionPath,
};
export function resolveCurrentPiInvocation(): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args: [] };
  return { command: "pi", args: [] };
}


export async function executeRun(
  ctx: ExtensionContext,
  agent: Conversation,
  run: Run,
  signal?: AbortSignal,
  dependencies: ExecuteRunDependencies = DEFAULT_EXECUTE_RUN_DEPENDENCIES,
): Promise<RunSnapshot> {
  if (signal?.aborted) return skippedRun(agent, run.runId);

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
  if (signal?.aborted) return skippedRun(agent, run.runId);

  const requestedThinking = requestedConfig.thinking;
  const parentSession = ctx.sessionManager?.getSessionFile();
  const childSessionDir = parentSession
    ? path.join(path.dirname(parentSession), path.basename(parentSession, path.extname(parentSession)))
    : undefined;
  const childSession = run.kind === "spawn"
    ? dependencies.sessionManager(cwd, childSessionDir, parentSession ? { parentSession } : undefined)
    : undefined;
  const sessionFile = run.kind === "resume" ? agent.snapshot().sessionFile : childSession?.getSessionFile?.();
  if (!sessionFile) {
    return errorRun(agent, run.runId, run.kind === "resume"
      ? "Cannot resume an agent without a conversation session file."
      : "Could not allocate child session file.");
  }
  if (run.kind === "spawn") {
    const header = childSession?.getHeader?.();
    if (!header) return errorRun(agent, run.runId, "Could not initialize child session header.");
mkdirSync(path.dirname(sessionFile), { recursive: true });
    try {
      writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, { flag: "wx" });
    } catch (error) {
      return errorRun(agent, run.runId, `Could not initialize child session: ${errorMessage(error)}`);
    }
  }
  agent.setSessionFile(sessionFile);

  const extensionPaths = await uniquePaths([...inheritedExtensionPaths, dependencies.ownExtensionPath, paneChildExtensionPath]);
  const prompt = `${run.prompt}\n\nWhen finished, call the subagent_done tool. If blocked and parent input is required, call caller_ping.`;
const activityFile = `${sessionFile}.activity.json`;
  const env = {
    PI_SUBAGENT_SESSION: sessionFile,
    PI_SUBAGENT_NAME: agent.agentName,
    PI_SUBAGENT_CONVERSATION_ID: agent.conversationId,
    PI_SUBAGENT_RUN_ID: run.runId,
PI_SUBAGENT_COMPLETION_FILE: `${sessionFile}.exit`,
    PI_SUBAGENT_ACTIVITY_FILE: activityFile,
    ...(agent.parent ? {
      PI_SUBAGENT_PARENT_CONVERSATION_ID: agent.parent.conversationId,
      PI_SUBAGENT_PARENT_RUN_ID: agent.parent.runId,
    } : {}),
  };
if (signal?.aborted) return skippedRun(agent, run.runId);

  agent.setEffectiveConfig({
    ...(selectedModel ? { model: `${selectedModel.provider}/${selectedModel.id}` } : {}),
    ...(requestedThinking ? { thinking: requestedThinking } : {}),
    cwd,
    skills: requestedSkills,
    tools: requestedConfig.tools ?? [],
  });

  let execution: PaneExecutionHandle;
  try {
execution = await dependencies.launchPaneExecution({
      cwd,
      sessionFile,
      prompt,
systemPrompt: agent.config.systemPrompt,
      skills: requestedSkills,
      tools: requestedConfig.tools,
      extensionPaths,
      ...(selectedModel ? { model: `${selectedModel.provider}/${selectedModel.id}` } : {}),
      ...(requestedThinking ? { thinking: requestedThinking } : {}),
      env,
piInvocation: dependencies.getPiInvocation(),
    });
agent.bindExecution(execution);
  } catch (error) {
    if (isRunDone(run)) return existingRun(agent, run);
    return errorRun(agent, run.runId, errorMessage(error));
  }

  try {
let activitySequence = 0;
    const observation = await dependencies.observePaneCompletion({
      handle: execution,
      ...(signal ? { signal } : {}),
onTick: () => {
        const activity = readPaneActivity(activityFile, run.runId);
        if (!activity || activity.sequence <= activitySequence) return;
        activitySequence = activity.sequence;
        agent.observePaneActivity(activity);
      },
    });
    if (isRunDone(run)) return existingRun(agent, run);
if (observation.status === "cancelled") return interruptedRun(agent, run.runId, "Agent interrupted.");
    return completeFromPane(agent, run, observation.completion, sessionFile, dependencies.readSessionFile);
  } catch (error) {
    if (isRunDone(run)) return existingRun(agent, run);
    return signal?.aborted
      ? interruptedRun(agent, run.runId, errorMessage(error))
      : errorRun(agent, run.runId, errorMessage(error));
  }
}

function completeFromPane(agent: Conversation, run: Run, completion: PaneCompletion, sessionFile: string, readSessionFile: typeof readFileSync): RunSnapshot {
  if (completion.type === "structured_output") {
    return completedRun(agent, run.runId, typeof completion.value === "string" ? completion.value : JSON.stringify(completion.value));
  }
  if (completion.type === "ping") return completedRun(agent, run.runId, completion.message);
if (completion.type === "failed") return errorRun(agent, run.runId, `Pane Pi exited with code ${completion.exitCode}.`);
  try {
    return completedRun(agent, run.runId, finalAssistantText(readSessionFile(sessionFile, "utf8")));
  } catch (error) {
    return errorRun(agent, run.runId, `Could not read completed pane session: ${errorMessage(error)}`);
  }
}

function finalAssistantText(rawSession: string): string {
  for (const line of rawSession.trim().split("\n").reverse()) {
    try {
      const entry = JSON.parse(line) as { type?: unknown; message?: { role?: unknown; content?: unknown } };
      if (entry.type !== "message" || entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
      return entry.message.content
        .filter((part): part is { type: "text"; text: string } => !!part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
        .map(part => part.text)
        .join("\n")
        .trim();
    } catch {}
  }
  return "";
}


async function uniquePaths(paths: readonly string[]): Promise<string[]> {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of paths) {
    const canonical = await canonicalPath(entry);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    result.push(entry);
  }
  return result;
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

