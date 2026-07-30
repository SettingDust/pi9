import { writeFileSync } from "node:fs";

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
  sendLongCommand(surface: string, command: string, options?: { scriptPath?: string }): string;
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
sleep?: (milliseconds: number) => Promise<void>;
platform?: NodeJS.Platform;
}

export interface PaneExecutionOptions {
  cwd: string;
  sessionFile: string;
  prompt: string;
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
  const mux = options.dependencies?.mux ?? await loadMux();
  if (!mux.isMuxAvailable()) throw new Error("No supported terminal multiplexer is available; pane-backed subagents require a steer-capable mux surface.");
  const herdr = mux.getMuxBackend() === "herdr" && process.env.HERDR_PANE_ID && mux.createSurfaceSplit;
  let surface: string;
if (herdr) {
    while (true) {
      const source = herdrSurfaces.at(-1) ?? process.env.HERDR_PANE_ID!;
      try {
        surface = mux.createSurfaceSplit!("subagent", herdrNextDirection, source);
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
    surface = mux.createSurface("subagent");
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

const invocation = options.piInvocation ?? { command: "pi", args: [] };
  const args = [...(invocation.args ?? []), "--session", options.sessionFile];
  for (const extensionPath of options.extensionPaths) args.push("-e", extensionPath);
  if (options.model) {
    args.push("--model", options.thinking ? `${options.model}:${options.thinking}` : options.model);
  }
  if (options.systemPrompt?.trim()) args.push("--system-prompt", options.systemPrompt);
  if (options.tools?.length) {
    args.push("--tools", [...new Set([...options.tools, "caller_ping", "subagent_done"])].join(","));
  }
  for (const skill of options.skills ?? []) args.push(`/skill:${skill}`);
  args.push(options.prompt);

  try {
    if ((options.dependencies?.platform ?? process.platform) === "win32") {
const scriptPath = `${options.sessionFile}.launch.ps1`;
      const writeFile = options.dependencies?.writeFile ?? writeFileSync;
      writeFile(scriptPath, `\ufeff${buildPowerShellLaunchScript(options.cwd, options.env, invocation.command, args)}`, "utf8");
      mux.sendCommand(surface, `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File ${windowsCommandLineQuote(scriptPath)}`);
    } else {
const parts = [mux.shellEscape(invocation.command), ...(invocation.args ?? []).map(mux.shellEscape), "--session", mux.shellEscape(options.sessionFile)];
      for (const extensionPath of options.extensionPaths) parts.push("-e", mux.shellEscape(extensionPath));
      if (options.model) parts.push("--model", mux.shellEscape(options.thinking ? `${options.model}:${options.thinking}` : options.model));
      if (options.systemPrompt?.trim()) parts.push("--system-prompt", mux.shellEscape(options.systemPrompt));
      if (options.tools?.length) parts.push("--tools", mux.shellEscape([...new Set([...options.tools, "caller_ping", "subagent_done"])].join(",")));
      for (const skill of options.skills ?? []) parts.push(mux.shellEscape(`/skill:${skill}`));
      parts.push(mux.shellEscape(options.prompt));
      const env = Object.entries(options.env).map(([key, value]) => `${key}=${mux.shellEscape(value)}`).join(" ");
      const piCommand = `cd ${mux.shellEscape(options.cwd)} && ${env ? `${env} ` : ""}${parts.join(" ")}`;
      mux.sendLongCommand(surface, `${piCommand}; echo '__SUBAGENT_DONE_'$?'__'`);
    }
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
      (options.dependencies?.writeFile ?? writeFileSync)(`${options.sessionFile}.exit`, JSON.stringify({ type: "done" }));
    },
    close,
    wait: (signal = new AbortController().signal, onTick) => mux.pollForExit(surface, signal, {
      interval: 1000,
      sessionFile: options.sessionFile,
      ...(onTick ? { onTick } : {}),
    }),
  };
}
function buildPowerShellLaunchScript(
  cwd: string,
  env: Readonly<Record<string, string>>,
  command: string,
  args: readonly string[],
): string {
  return [
    `$ErrorActionPreference = 'Stop'`,
    `Set-Location -LiteralPath ${powerShellLiteral(cwd)}`,
    ...Object.entries(env).map(([key, value]) =>
      `[Environment]::SetEnvironmentVariable(${powerShellLiteral(key)}, ${powerShellLiteral(value)}, 'Process')`),
    `$arguments = @(${args.map(powerShellLiteral).join(", ")})`,
    `$exitCode = 1`,
    `try {`,
    `  & ${powerShellLiteral(command)} @arguments`,
    `  $exitCode = $LASTEXITCODE`,
    `} catch {`,
    `  [Console]::Error.WriteLine($_.ToString())`,
    `}`,
    `Write-Output "__SUBAGENT_DONE_${"${exitCode}"}__"`,
`Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue`,
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
function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}