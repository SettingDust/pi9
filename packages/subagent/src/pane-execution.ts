import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completedGeneration, errorGeneration, interruptedGeneration, skippedGeneration, type Conversation, type Generation, type GenerationSnapshot } from "./conversation.js";
import { discoverInheritedExtensionPaths, resolveCurrentPiInvocation, resolveModel, resolveRequestedSkills, resolveTaskCwd } from "./execute.js";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { projectPaneActivity, readPaneActivity } from "./pane-activity.js";
export const paneChildExtensionPath = fileURLToPath(new URL("./pane-child.ts", import.meta.url));

interface PollResult {
  reason: "done" | "ping" | "structured_output" | "sentinel";
  exitCode: number;
  ping?: { name: string; message: string };
  structuredOutput?: unknown;
}

interface TerminalMux {
  closeSurface(surface: string): void;
  createSurface(name: string): string;
  getMuxBackend(): string | null;
  isMuxAvailable(): boolean;
  sendCommand(surface: string, text: string): void;
  sendEscape(surface: string): void;
  sendLongCommand(surface: string, command: string, options?: { scriptPath?: string; scriptPreamble?: string }): string;
  shellEscape(value: string): string;
  pollForExit(surface: string, signal: AbortSignal, options: { interval: number; sessionFile?: string; onTick?: (elapsed: number) => void }): Promise<PollResult>;
  createSurfaceSplit?(name: string, direction: "left" | "right" | "up" | "down", fromSurface?: string): string;
}

export interface PaneExecutionDependencies {
  mux?: TerminalMux;
  writeFile?: typeof writeFileSync;
  execFile?: typeof execFileSync;
  stat?: typeof statSync;
  sleep?: (milliseconds: number) => Promise<void>;
  platform?: NodeJS.Platform;
  getAgentDir?: typeof getAgentDir;
  loadExtensionPaths?: (cwd: string, agentDir: string) => Promise<string[]>;
  getPiInvocation?: () => { command: string; args: string[] };
}

export interface PaneExecutionOptions {
  cwd: string;
  sessionFile: string;
  prompt: string;
  displayName?: string;
  extensionPaths: readonly string[];
  systemPrompt?: string;
  skills?: readonly string[];
  tools?: readonly string[];
  model?: string;
  thinking?: string;
  env: Readonly<Record<string, string>>;
  piInvocation?: { command: string; args?: readonly string[] };
  dependencies?: PaneExecutionDependencies;
}
export interface ReopenPaneExecutionOptions {
  cwd: string;
  sessionFile: string;
  displayName?: string;
  extensionPaths?: readonly string[];
  env?: Readonly<Record<string, string>>;
  piInvocation?: { command: string; args?: readonly string[] };
  dependencies?: PaneExecutionDependencies;
}

export interface PaneExecutionHandle {
  readonly surface: string;
  send(text: string): void;
  interrupt(): void;
  close(): void;
  wait(signal?: AbortSignal, onTick?: (elapsed: number) => void): Promise<PollResult>;
}

type PaneCompletion =
  | { type: "done" }
  | { type: "structured_output"; value: unknown }
  | { type: "ping"; name: string; message: string }
  | { type: "failed"; exitCode: number };

/** Returns the lazy-join output recorded by a terminal child pane, if valid. */
export function readPaneCompletionOutput(sessionFile: string): string | undefined {
  try {
    const completion: unknown = JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8"));
    if (!completion || typeof completion !== "object" || Array.isArray(completion)) return undefined;
    const value = completion as Record<string, unknown>;
    switch (value.type) {
      case "structured_output": return Object.hasOwn(value, "value") ? formatStructuredOutput(value.value) : undefined;
      case "ping": return typeof value.name === "string" && typeof value.message === "string" ? value.message : undefined;
      case "done": return "";
      case "failed": return typeof value.exitCode === "number" ? undefined : undefined;
      default: return undefined;
    }
  } catch { return undefined; }
}

export type PaneCompletionOutcome =
  | { status: "completed"; completion: PaneCompletion }
  | { status: "cancelled" };

const herdrSurfaces: string[] = [];
let herdrNextDirection: "right" | "down" = "right";
const activePaneHandles = new Set<PaneExecutionHandle>();
export function resetPaneExecutionStateForTests(): void {
  for (const handle of activePaneHandles) handle.close();
  activePaneHandles.clear();
  herdrSurfaces.length = 0;
  herdrNextDirection = "right";
}

export async function launchPaneExecution(options: PaneExecutionOptions): Promise<PaneExecutionHandle> {
  const invocation = options.piInvocation ?? resolveCurrentPiInvocation();
  const args = [...(invocation.args ?? []), "--session", options.sessionFile];
  const unixArgs = [...(invocation.args ?? []), "--session", options.sessionFile];
  for (const extensionPath of options.extensionPaths) {
    args.push("-e", extensionPath);
    unixArgs.push("-e", extensionPath);
  }
  if (options.model) {
    const model = options.thinking ? `${options.model}:${options.thinking}` : options.model;
    args.push("--model", model);
    unixArgs.push("--model", model);
  }
  if (options.systemPrompt?.trim()) {
    args.push("--system-prompt", options.systemPrompt);
    unixArgs.push("--system-prompt", options.systemPrompt);
  }
  if (options.tools?.length) {
    const tools = [...new Set([...options.tools, "caller_ping", "subagent_done"])].join(",");
    args.push("--tools", tools);
    unixArgs.push("--tools", tools);
  }
  args.push(options.prompt);
  unixArgs.push(options.prompt);

  return launchPiPane({
    cwd: options.cwd,
    sessionFile: options.sessionFile,
    displayName: options.displayName,
    env: options.env,
    invocation,
    args,
    unixArgs,
    dependencies: options.dependencies,
  });
}
function isAbsoluteSessionFile(sessionFile: string): boolean {
  return path.isAbsolute(sessionFile);
}
export async function reopenPaneExecution(options: ReopenPaneExecutionOptions): Promise<PaneExecutionHandle> {
  if (!isAbsoluteSessionFile(options.sessionFile)) throw new Error("Cannot reopen a pane without an absolute session file.");
  const stat = options.dependencies?.stat ?? statSync;
  try {
    if (!stat(options.sessionFile).isFile()) throw new Error("Session file is not a regular file.");
  } catch (error) {
    if (error instanceof Error && error.message === "Session file is not a regular file.") throw error;
    throw new Error(`Cannot reopen pane; session file is missing or inaccessible: ${options.sessionFile}`);
  }
  const invocation = options.piInvocation ?? resolveCurrentPiInvocation();
const args = [...(invocation.args ?? []), "--session", options.sessionFile];
  const unixArgs = [...(invocation.args ?? []), "--session", options.sessionFile];
  for (const extensionPath of [...(options.extensionPaths ?? []), paneChildExtensionPath]) {
    args.push("-e", extensionPath);
    unixArgs.push("-e", extensionPath);
  }
  return launchPiPane({
    cwd: options.cwd,
    sessionFile: options.sessionFile,
    displayName: options.displayName,
    env: { ...options.env, PI_SUBAGENT_READONLY: "1" },
    invocation,
    args,
    unixArgs,
    dependencies: options.dependencies,
  });
}

export async function retainedPaneExists(surface: string, dependencies: PaneExecutionDependencies = {}): Promise<boolean | undefined> {
  const mux = dependencies.mux ?? await loadMux();
  if (mux.getMuxBackend() !== "herdr") return undefined;
  try {
    (dependencies.execFile ?? execFileSync)("herdr", ["pane", "get", surface], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch (error) {
    if (isMissingPaneError(error)) return false;
    throw error;
  }
}

export function createPaneGenerationExecutor(dependencies: PaneExecutionDependencies = {}) {
  return async function executePaneGeneration(ctx: ExtensionContext, conversation: Conversation, generation: Generation, signal?: AbortSignal): Promise<GenerationSnapshot> {
    if (generation.kind === "resume" && !conversation.sessionFileForResume()) return errorGeneration(conversation, generation, "Cannot resume a pane-backed generation without a retained child session file.");
    if (signal?.aborted) return skippedGeneration(conversation, generation);

    const requested = conversation.requestedConfig;
    const cwdResolution = resolveTaskCwd(ctx.cwd, requested.cwd);
    if (!cwdResolution.ok) return errorGeneration(conversation, generation, cwdResolution.error);
    const modelResolution = resolveModel(requested.model, ctx.model, ctx.modelRegistry);
    if (!modelResolution.ok) return errorGeneration(conversation, generation, modelResolution.error);
    const skillResolution = resolveRequestedSkills(cwdResolution.value, requested.skills ?? []);
    if (!skillResolution.ok) return errorGeneration(conversation, generation, skillResolution.error);

    const cwd = cwdResolution.value;
    const agentDir = (dependencies.getAgentDir ?? getAgentDir)();
    const extensionPaths = await (dependencies.loadExtensionPaths ?? discoverInheritedExtensionPaths)(cwd, agentDir);
    extensionPaths.push(paneChildExtensionPath);
    const sessionFile = generation.kind === "resume" ? conversation.sessionFileForResume()! : childSessionFile(ctx, conversation.conversationId, generation.number);
    const completionFile = `${sessionFile}.exit`;
    const activityFile = `${sessionFile}.activity.json`;
    const childId = `${conversation.conversationId}:${generation.number}`;
    const selectedModel = modelResolution.value;
    const systemPrompt = conversation.definition.systemPrompt;

    mkdirSync(path.dirname(sessionFile), { recursive: true });
    writeFileSync(sessionFile, "", { flag: "a" });
    clearCompletionSidecar(completionFile);
    const piInvocation = dependencies.getPiInvocation?.() ?? resolveCurrentPiInvocation();

    const handle = await launchPaneExecution({
      cwd,
      sessionFile,
      prompt: `${generation.prompt}\n\nWhen finished, call the subagent_done tool. If blocked and parent input is required, call caller_ping.`,
      displayName: conversation.label || conversation.agentName,
      extensionPaths,
      systemPrompt,
      skills: requested.skills,
      tools: requested.tools,
      model: selectedModel ? `${selectedModel.provider}/${selectedModel.id}` : undefined,
      thinking: requested.thinking,
      env: {
        PI_SUBAGENT_CONVERSATION_ID: conversation.conversationId,
        PI_SUBAGENT_COMPLETION_FILE: completionFile,
        PI_SUBAGENT_RUN_ID: childId,
        PI_SUBAGENT_ACTIVITY_FILE: activityFile,
        PI_SUBAGENT_SKILLS: JSON.stringify(requested.skills ?? []),
      },
      dependencies,
      piInvocation,
    });

    conversation.bindControl(generation, {
      steer: async text => handle.send(text),
      abort: async () => handle.interrupt(),
    });
    activePaneHandles.add(handle);
    conversation.retainPaneSurface(handle.surface, () => handle.close());

    const observe = () => {
      const state = readPaneActivity(activityFile, childId);
      const snapshot = projectPaneActivity(state);
      if (snapshot) generation.activity.observe(snapshot, state?.usage);
    };
    conversation.retainSessionFile(sessionFile);

    let outcome: PaneCompletionOutcome;
    try {
      outcome = await observePaneCompletion({ handle, signal, onTick: observe });
      observe();
      if (outcome.status === "completed") await waitForPaneShutdown(activityFile, childId, dependencies.sleep ?? sleep);
      observe();
      releaseActivePane(handle);
      conversation.clearRetainedPaneSurface(handle.surface);
    } catch (error) {
      releaseActivePane(handle);
      conversation.clearRetainedPaneSurface(handle.surface);
      throw error;
    }
    if (outcome.status === "cancelled") return interruptedGeneration(conversation, generation, "Agent interrupted.");
    switch (outcome.completion.type) {
      case "structured_output": return completedGeneration(conversation, generation, formatStructuredOutput(outcome.completion.value));
      case "ping": return completedGeneration(conversation, generation, outcome.completion.message);
      case "failed": return errorGeneration(conversation, generation, `Pane child exited with code ${outcome.completion.exitCode}.`);
      case "done": return completedGeneration(conversation, generation, "");
    }
  };
}

interface PiPaneLaunchOptions {
  cwd: string;
  sessionFile: string;
  displayName?: string;
  env: Readonly<Record<string, string>>;
  invocation: { command: string; args?: readonly string[] };
  args: readonly string[];
  unixArgs: readonly string[];
  dependencies?: PaneExecutionDependencies;
}

async function launchPiPane(options: PiPaneLaunchOptions): Promise<PaneExecutionHandle> {
  const mux = options.dependencies?.mux ?? await loadMux();
  if (!mux.isMuxAvailable()) throw new Error("No supported terminal multiplexer is available; pane-backed subagents require a steer-capable mux surface.");
  const name = sanitizeDisplayName(options.displayName);
  const herdr = mux.getMuxBackend() === "herdr" && process.env.HERDR_PANE_ID && mux.createSurfaceSplit;
  let surface: string;
  if (herdr) {
    while (true) {
      const layoutIndex = herdrSurfaces.length;
      const source = layoutIndex === 0 ? process.env.HERDR_PANE_ID!
        : layoutIndex === 1 || layoutIndex === 3 ? herdrSurfaces[0]!
        : layoutIndex === 2 ? herdrSurfaces[1]!
        : herdrSurfaces.at(-1)!;
      const direction = layoutIndex < 2 ? "right" : layoutIndex < 4 ? "down" : herdrNextDirection;
      try { surface = mux.createSurfaceSplit!(name, direction, source); herdrNextDirection = direction === "right" ? "down" : "right"; break; }
      catch (error) {
        const sourceIndex = herdrSurfaces.indexOf(source);
        if (!isMissingPaneError(error) || sourceIndex < 0) throw error;
        herdrSurfaces.splice(sourceIndex, 1);
        if (herdrSurfaces.length === 0) herdrNextDirection = "right";
      }
    }
    herdrSurfaces.push(surface);
  } else {
    surface = mux.createSurface(name);
  }
  if (!surface) throw new Error("Terminal multiplexer did not return a pane ID from its managed split layout.");
  await (options.dependencies?.sleep ?? sleep)(500);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { mux.closeSurface(surface); }
    catch (error) { if (!isMissingPaneError(error)) throw error; }
    finally {
      const index = herdrSurfaces.indexOf(surface);
      if (index >= 0) herdrSurfaces.splice(index, 1);
      if (herdrSurfaces.length === 0) herdrNextDirection = "right";
    }
  };

  try { launchPiTransport(mux, surface, options); }
  catch (error) { close(); throw error; }

  return {
    surface,
    send: text => mux.sendCommand(surface, text),
    interrupt: () => {
      try { mux.sendEscape(surface); }
      catch (error) { if (!isMissingPaneError(error)) throw error; }
      (options.dependencies?.writeFile ?? writeFileSync)(`${options.sessionFile}.exit`, JSON.stringify({ type: "done" }));
    },
    close,
    wait: (signal = new AbortController().signal, onTick) => mux.pollForExit(surface, signal, { interval: 1000, sessionFile: options.sessionFile, ...(onTick ? { onTick } : {}) }),
  };
}

function launchPiTransport(mux: TerminalMux, surface: string, options: PiPaneLaunchOptions): void {
  if ((options.dependencies?.platform ?? process.platform) === "win32") {
    const scriptPath = `${options.sessionFile}.launch.ps1`;
    const bootstrapPath = `${options.sessionFile}.launch.cjs`;
    const completionFile = `${options.sessionFile}.exit`;
    const writeFile = options.dependencies?.writeFile ?? writeFileSync;
    writeFile(bootstrapPath, buildNodeLaunchScript(options.cwd, options.env, options.invocation.command, options.args, completionFile, bootstrapPath), "utf8");
    writeFile(scriptPath, `\ufeff${buildPowerShellLaunchScript(resolveBootstrapRuntime(), bootstrapPath, completionFile)}`, "utf8");
    mux.sendCommand(surface, `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File ${windowsCommandLineQuote(scriptPath)}`);
    return;
  }

  const exitFile = mux.shellEscape(`${options.sessionFile}.exit`);
  const argAssignments = [mux.shellEscape(options.invocation.command), ...options.unixArgs.map(mux.shellEscape)].join(" ");
  const preamble = [
    `cd ${mux.shellEscape(options.cwd)}`,
    ...Object.entries(options.env).map(([key, value]) => `export ${key}=${mux.shellEscape(value)}`),
    `__args=(${argAssignments})`,
  ].join("\n");
  mux.sendLongCommand(surface, `("${"${__args[@]}"}"); __code=$?; if [ ! -e ${exitFile} ]; then printf '{"type":"failed","exitCode":%s}' "$__code" > ${exitFile}; fi; echo '__SUBAGENT_DONE_'$__code'__'`, {
    scriptPath: `${options.sessionFile}.launch.sh`,
    scriptPreamble: preamble,
  });
}

function buildNodeLaunchScript(cwd: string, env: Readonly<Record<string, string>>, command: string, args: readonly string[], completionFile: string, bootstrapFile: string): string {
  const spec = Buffer.from(JSON.stringify({ cwd, env, command, args, completionFile, bootstrapFile }), "utf8").toString("base64");
  return [
    `const { existsSync, unlinkSync, writeFileSync } = require("node:fs");`,
    `const { spawnSync } = require("node:child_process");`,
    `const spec = JSON.parse(Buffer.from(${JSON.stringify(spec)}, "base64").toString("utf8"));`,
    `let exitCode = 1;`,
    `try {`,
    `  const result = spawnSync(spec.command, spec.args, { cwd: spec.cwd, env: { ...process.env, ...spec.env }, stdio: "inherit" });`,
    `  if (result.error) throw result.error;`,
    `  exitCode = result.status ?? 1;`,
    `} catch (error) {`,
    `  console.error(error instanceof Error ? error.stack ?? error.message : String(error));`,
    `} finally {`,
    `  if (!existsSync(spec.completionFile)) writeFileSync(spec.completionFile, JSON.stringify({ type: "failed", exitCode }));`,
    `  try { unlinkSync(spec.bootstrapFile); } catch {}`,
    `}`,
    `process.exit(exitCode);`,
    ``,
  ].join("\r\n");
}

function buildPowerShellLaunchScript(runtime: string, bootstrapFile: string, completionFile: string): string {
  return [
    `$ErrorActionPreference = 'Stop'`,
    `$completionFile = ${powerShellLiteral(completionFile)}`,
    `$bootstrapFile = ${powerShellLiteral(bootstrapFile)}`,
    `$exitCode = 1`,
    `try {`,
    `  & ${powerShellLiteral(runtime)} $bootstrapFile`,
    `  $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }`,
    `} catch {`,
    `  [Console]::Error.WriteLine($_.ToString())`,
    `} finally {`,
    `  if (-not (Test-Path -LiteralPath $completionFile)) {`,
    `    Set-Content -LiteralPath $completionFile -Value ('{"type":"failed","exitCode":' + $exitCode + '}') -NoNewline -Encoding UTF8`,
    `  }`,
    `  Remove-Item -LiteralPath $bootstrapFile -Force -ErrorAction SilentlyContinue`,
    `  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue`,
    `}`,
    `Write-Output "__SUBAGENT_DONE_${"${exitCode}"}__"`,
    `exit $exitCode`,
    ``,
  ].join("\r\n");
}
function resolveBootstrapRuntime(): string {
  return /^(node|bun)(\.exe)?$/i.test(path.basename(process.execPath)) ? process.execPath : "node";
}

async function observePaneCompletion(options: { handle: PaneExecutionHandle; signal?: AbortSignal; onTick?: (elapsed: number) => void }): Promise<PaneCompletionOutcome> {
  try {
    const result = await options.handle.wait(options.signal, options.onTick);
    if (result.reason === "ping" && result.ping) return { status: "completed", completion: { type: "ping", ...result.ping } };
    if (result.reason === "structured_output") return { status: "completed", completion: { type: "structured_output", value: result.structuredOutput } };
    if (result.exitCode !== 0) return { status: "completed", completion: { type: "failed", exitCode: result.exitCode } };
    return { status: "completed", completion: { type: "done" } };
  } catch (error) {
    if (options.signal?.aborted) return { status: "cancelled" };
    throw error;
  }
}
async function waitForPaneShutdown(activityFile: string, childId: string, wait: (milliseconds: number) => Promise<void>): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (readPaneActivity(activityFile, childId)?.latestEvent === "session_shutdown") return;
    await wait(25);
  }
}

async function loadMux(): Promise<TerminalMux> {
  const packageName = "pi-terminal-mux";
  return await import(packageName) as TerminalMux;
}
export function childSessionFile(ctx: ExtensionContext, conversationId: string, generation: number): string {
  const parent = ctx.sessionManager?.getSessionFile?.();
  const base = parent ? parent.replace(/\.jsonl$/i, "") : path.join(ctx.cwd, ".pi", "subagent-sessions");
  return path.join(base, "tasks", `${conversationId}-g${generation}.jsonl`);
}
export function retainedChildSessionFile(parentSessionFile: string, conversationId: string, generation: number): string {
  return path.join(parentSessionFile.replace(/\.jsonl$/i, ""), "tasks", `${conversationId}-g${generation}.jsonl`);
}
function formatStructuredOutput(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(value) ?? String(value); }
function sanitizeDisplayName(value: string | undefined): string { return value?.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, 48) || "subagent"; }
function powerShellLiteral(value: string): string { return `'${value.replaceAll("'", "''")}'`; }
function windowsCommandLineQuote(value: string): string { return `"${value.replaceAll('"', '\\"')}"`; }
function isMissingPaneError(error: unknown): boolean { const message = error instanceof Error ? error.message : String(error); return message.includes("pane_not_found") || message.includes("pane not found"); }
function clearCompletionSidecar(file: string): void { if (existsSync(file)) try { unlinkSync(file); } catch {} }
function releaseActivePane(handle: PaneExecutionHandle): void {
  activePaneHandles.delete(handle);
  handle.close();
}
function sleep(milliseconds: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, milliseconds)); }