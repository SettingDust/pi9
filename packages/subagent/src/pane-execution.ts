import { execFileSync } from "node:child_process";
import { statSync, writeFileSync } from "node:fs";
import path from "node:path";

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
  pollForExit(
    surface: string,
    signal: AbortSignal,
    options: { interval: number; sessionFile?: string; onTick?: (elapsed: number) => void },
  ): Promise<PollResult>;
  createSurfaceSplit?(name: string, direction: "left" | "right" | "up" | "down", fromSurface?: string): string;
}

export interface PaneExecutionDependencies {
  mux?: TerminalMux;
  writeFile?: typeof writeFileSync;
  execFile?: typeof execFileSync;
  stat?: typeof statSync;
  sleep?: (milliseconds: number) => Promise<void>;
  platform?: NodeJS.Platform;
}

export interface PaneExecutionOptions {
  cwd: string;
  sessionFile: string;
  prompt: string;
  displayName?: string;
  extensionPaths: readonly string[];
  systemPrompt?: string;
  /** Requested skills are resolved by the child extension before the first task turn. */
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

export type PaneCompletion =
  | { type: "done" }
  | { type: "structured_output"; value: unknown }
  | { type: "ping"; name: string; message: string }
  | { type: "failed"; exitCode: number };

export type PaneCompletionOutcome =
  | { status: "completed"; completion: PaneCompletion }
  | { status: "cancelled" };

export interface PaneCompletionObserverOptions {
  handle: PaneExecutionHandle;
  signal?: AbortSignal;
  onTick?: (elapsed: number) => void;
}

const herdrSurfaces: string[] = [];
let herdrNextDirection: "right" | "down" = "right";

export async function launchPaneExecution(options: PaneExecutionOptions): Promise<PaneExecutionHandle> {
  const invocation = options.piInvocation ?? { command: "pi", args: [] };
  const args = [...(invocation.args ?? []), "--session", options.sessionFile];
  const unixArgs: PiArgument[] = (invocation.args ?? []).map(value => ({ value, escaped: true }));
  unixArgs.push({ value: "--session", escaped: false }, { value: options.sessionFile, escaped: true });
  for (const extensionPath of options.extensionPaths) {
    args.push("-e", extensionPath);
    unixArgs.push({ value: "-e", escaped: false }, { value: extensionPath, escaped: true });
  }
  if (options.model) {
    const model = options.thinking ? `${options.model}:${options.thinking}` : options.model;
    args.push("--model", model);
    unixArgs.push({ value: "--model", escaped: false }, { value: model, escaped: true });
  }
  if (options.systemPrompt?.trim()) {
    args.push("--system-prompt", options.systemPrompt);
    unixArgs.push({ value: "--system-prompt", escaped: false }, { value: options.systemPrompt, escaped: true });
  }
  if (options.tools?.length) {
    const tools = [...new Set([...options.tools, "caller_ping", "subagent_done"])].join(",");
    args.push("--tools", tools);
    unixArgs.push({ value: "--tools", escaped: false }, { value: tools, escaped: true });
  }
  args.push(options.prompt);
  unixArgs.push({ value: options.prompt, escaped: true });

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

export async function reopenPaneExecution(options: ReopenPaneExecutionOptions): Promise<PaneExecutionHandle> {
  if (!isAbsoluteSessionFile(options.sessionFile)) throw new Error("Cannot reopen a pane without an absolute session file.");
  const invocation = options.piInvocation ?? { command: "pi", args: [] };
  const args = [...(invocation.args ?? []), "--session", options.sessionFile];
  const unixArgs: PiArgument[] = (invocation.args ?? []).map(value => ({ value, escaped: true }));
  unixArgs.push({ value: "--session", escaped: false }, { value: options.sessionFile, escaped: true });
  for (const extensionPath of options.extensionPaths ?? []) {
    args.push("-e", extensionPath);
    unixArgs.push({ value: "-e", escaped: false }, { value: extensionPath, escaped: true });
  }
// Validation is immediately before pane creation; the path can still be replaced
  // between this check and the child process opening it (TOCTOU).
  const stat = options.dependencies?.stat ?? statSync;
  try {
    if (!stat(options.sessionFile).isFile()) throw new Error("Session file is not a regular file.");
  } catch (error) {
    if (error instanceof Error && error.message === "Session file is not a regular file.") throw error;
    throw new Error(`Cannot reopen pane; session file is missing or inaccessible: ${options.sessionFile}`);
  }

  return launchPiPane({
    cwd: options.cwd,
    sessionFile: options.sessionFile,
    displayName: options.displayName,
    env: options.env ?? {},
    invocation,
    args,
    unixArgs,
    mode: "viewer",
    dependencies: options.dependencies,
  });
}

export async function retainedHerdrPaneExists(surface: string, dependencies: PaneExecutionDependencies = {}): Promise<boolean> {
  const mux = dependencies.mux ?? await loadMux();
  const backend = mux.getMuxBackend();
  if (backend !== "herdr") throw new Error(`Cannot inspect a retained Herdr pane on unsupported mux backend: ${backend ?? "none"}.`);
  try {
    (dependencies.execFile ?? execFileSync)("herdr", ["pane", "get", surface], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch (error) {
    if (isPaneNotFoundError(error)) return false;
    throw error;
  }
}

function isAbsoluteSessionFile(sessionFile: string): boolean {
  return path.posix.isAbsolute(sessionFile) || path.win32.isAbsolute(sessionFile);
}

interface PiArgument {
  value: string;
  escaped: boolean;
}

interface PiPaneLaunchOptions {
  cwd: string;
  sessionFile: string;
  displayName?: string;
  env: Readonly<Record<string, string>>;
  invocation: { command: string; args?: readonly string[] };
  args: readonly string[];
  unixArgs: readonly PiArgument[];
  mode?: "run" | "viewer";
  dependencies?: PaneExecutionDependencies;
}

async function launchPiPane(options: PiPaneLaunchOptions): Promise<PaneExecutionHandle> {
  const mux = options.dependencies?.mux ?? await loadMux();
  if (!mux.isMuxAvailable()) throw new Error("No supported terminal multiplexer is available; pane-backed subagents require a steer-capable mux surface.");
  const name = sanitizeDisplayName(options.displayName);
  const mode = options.mode ?? "run";
  const herdr = mux.getMuxBackend() === "herdr" && process.env.HERDR_PANE_ID && mux.createSurfaceSplit;
  let surface: string;
  if (herdr) {
    while (true) {
      const source = herdrSurfaces.at(-1) ?? process.env.HERDR_PANE_ID!;
      try {
        surface = mux.createSurfaceSplit!(name, herdrNextDirection, source);
        break;
      } catch (error) {
        if (!isMissingPaneError(error) || herdrSurfaces.length === 0) throw error;
        herdrSurfaces.pop();
        if (herdrSurfaces.length === 0) herdrNextDirection = "right";
      }
    }
    herdrSurfaces.push(surface);
    herdrNextDirection = herdrNextDirection === "right" ? "down" : "right";
  } else {
    surface = mux.createSurface(name);
  }
  if (!surface) throw new Error("Terminal multiplexer did not return a pane ID from its managed split layout.");
  await (options.dependencies?.sleep ?? sleep)(500);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      mux.closeSurface(surface);
    } catch (error) {
      if (!isMissingPaneError(error)) throw error;
    } finally {
      const index = herdrSurfaces.indexOf(surface);
      if (index >= 0) herdrSurfaces.splice(index, 1);
      if (herdrSurfaces.length === 0) herdrNextDirection = "right";
    }
  };

  try {
    launchPiTransport(mux, surface, options);
  } catch (error) {
    close();
    throw error;
  }

  return {
    surface,
    send: text => mux.sendCommand(surface, text),
    interrupt: () => {
      try {
        mux.sendEscape(surface);
      } catch (error) {
        if (!isMissingPaneError(error)) throw error;
      }
      if (mode === "run") {
        (options.dependencies?.writeFile ?? writeFileSync)(`${options.sessionFile}.exit`, JSON.stringify({ type: "done" }));
      }
    },
    close,
    wait: mode === "viewer"
      ? async () => { throw new Error("Cannot wait on a reopened pane handle; it is a viewer handle, not a Run observer."); }
      : (signal = new AbortController().signal, onTick) => mux.pollForExit(surface, signal, {
      interval: 1000,
      sessionFile: options.sessionFile,
      ...(onTick ? { onTick } : {}),
    }),
  };
}

function launchPiTransport(mux: TerminalMux, surface: string, options: PiPaneLaunchOptions): void {
  if ((options.dependencies?.platform ?? process.platform) === "win32") {
    const scriptPath = `${options.sessionFile}.launch.ps1`;
    const writeFile = options.dependencies?.writeFile ?? writeFileSync;
    writeFile(scriptPath, `\ufeff${buildPowerShellLaunchScript(options.cwd, options.env, options.invocation.command, options.args, `${options.sessionFile}.exit`)}`, "utf8");
    mux.sendCommand(surface, `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File ${windowsCommandLineQuote(scriptPath)}`);
    return;
  }

const parts = [mux.shellEscape(options.invocation.command), ...options.unixArgs.map(argument => argument.escaped ? mux.shellEscape(argument.value) : argument.value)];
  const exitFile = mux.shellEscape(`${options.sessionFile}.exit`);
  const preamble = [
    `cd ${mux.shellEscape(options.cwd)}`,
    ...Object.entries(options.env).map(([key, value]) => `export ${key}=${mux.shellEscape(value)}`),
  ].join("\n");
  mux.sendLongCommand(surface, `(${parts.join(" ")}); __code=$?; if [ ! -e ${exitFile} ]; then printf '{"type":"failed","exitCode":%s}' "$__code" > ${exitFile}; fi; echo '__SUBAGENT_DONE_'$__code'__'`, {
    scriptPath: `${options.sessionFile}.launch.sh`,
    scriptPreamble: preamble,
  });
}

function sanitizeDisplayName(value: string | undefined): string {
  return value?.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, 48) || "subagent";
}
function buildPowerShellLaunchScript(
  cwd: string,
  env: Readonly<Record<string, string>>,
  command: string,
  args: readonly string[],
completionFile: string,
): string {
  return [
    `$ErrorActionPreference = 'Stop'`,
    `Set-Location -LiteralPath ${powerShellLiteral(cwd)}`,
    ...Object.entries(env).map(([key, value]) =>
      `[Environment]::SetEnvironmentVariable(${powerShellLiteral(key)}, ${powerShellLiteral(value)}, 'Process')`),
    `$arguments = @(${args.map(powerShellLiteral).join(", ")})`,
`$completionFile = ${powerShellLiteral(completionFile)}`,
    `$exitCode = 1`,
    `try {`,
    `  & ${powerShellLiteral(command)} @arguments`,
    `  $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }`,
    `} catch {`,
    `  [Console]::Error.WriteLine($_.ToString())`,
`  $exitCode = 1`,
    `} finally {`,
    `  if (-not (Test-Path -LiteralPath $completionFile)) {`,
    `    Set-Content -LiteralPath $completionFile -Value ('{"type":"failed","exitCode":' + $exitCode + '}') -NoNewline -Encoding UTF8`,
    `  }`,
    `  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue`,
    `}`,
    `Write-Output "__SUBAGENT_DONE_${"${exitCode}"}__"`,
    `exit $exitCode`,
    ``,
  ].join("\r\n");
}

function powerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
function windowsCommandLineQuote(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

export async function observePaneCompletion(options: PaneCompletionObserverOptions): Promise<PaneCompletionOutcome> {
  try {
    const result = await options.handle.wait(options.signal, options.onTick);
    if (result.reason === "ping" && result.ping) {
      return { status: "completed", completion: { type: "ping", ...result.ping } };
    }
    if (result.reason === "structured_output") {
      return { status: "completed", completion: { type: "structured_output", value: result.structuredOutput } };
    }
    if (result.exitCode !== 0) {
      return { status: "completed", completion: { type: "failed", exitCode: result.exitCode } };
    }
    return { status: "completed", completion: { type: "done" } };
  } catch (error) {
    if (options.signal?.aborted) return { status: "cancelled" };
    throw error;
  }
}

async function loadMux(): Promise<TerminalMux> {
  const packageName: string = "pi-terminal-mux";
  return await import(packageName) as TerminalMux;
}
function isMissingPaneError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("pane_not_found") || message.includes("pane not found");
}

function isPaneNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("pane_not_found");
}
function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}