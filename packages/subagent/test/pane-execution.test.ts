import { describe, expect, it, vi } from "vitest";
import { launchPaneExecution, observePaneCompletion, type PaneExecutionHandle } from "../src/pane-execution.js";

function fakeMux() {
  return {
    closeSurface: vi.fn(),
    createSurface: vi.fn(() => "surface-1"),
getMuxBackend: vi.fn(() => "herdr"),
isMuxAvailable: vi.fn(() => true),
    sendCommand: vi.fn(),
    sendEscape: vi.fn(),
    sendLongCommand: vi.fn(() => "command-1"),
    shellEscape: (value: string) => `[${value}]`,
    pollForExit: vi.fn().mockResolvedValue({ reason: "done", exitCode: 0 }),
  };
}

const options = (mux: ReturnType<typeof fakeMux>, writeFile = vi.fn(), sleep = vi.fn(async () => {}), platform: NodeJS.Platform = "linux"): Parameters<typeof launchPaneExecution>[0] => ({
  cwd: "/work/project",
  sessionFile: "/sessions/child.jsonl",
  prompt: "do the work",
  extensionPaths: ["/extensions/one.ts"],
  systemPrompt: "You are focused.",
  skills: ["review-correctness", "ponytail"],
  tools: ["read", "subagent_done"],
  model: "provider/model",
  thinking: "high",
  env: { TOKEN: "secret" },
piInvocation: { command: "C:\\runtime\\node.exe", args: ["C:\\pi\\cli.js"] },
  dependencies: { mux, writeFile, sleep, platform },
});

describe("pane execution launcher", () => {
  it("starts one pane-owned Pi session with upstream-compatible arguments", async () => {
const mux = fakeMux();
    const sleep = vi.fn(async () => {});
    const handle = await launchPaneExecution(options(mux, undefined, sleep));

    expect(handle.surface).toBe("surface-1");
    expect(mux.createSurface).toHaveBeenCalledOnce();
expect(sleep).toHaveBeenCalledWith(500);
    expect(mux.sendLongCommand).toHaveBeenCalledWith(
      "surface-1",
      "cd [/work/project] && TOKEN=[secret] [C:\\runtime\\node.exe] [C:\\pi\\cli.js] --session [/sessions/child.jsonl] -e [/extensions/one.ts] --model [provider/model:high] --system-prompt [You are focused.] --tools [read,subagent_done,caller_ping] [/skill:review-correctness] [/skill:ponytail] [do the work]; echo '__SUBAGENT_DONE_'$?'__'",
    );
  });
it("uses a native PowerShell launch script on Windows", async () => {
    const mux = fakeMux();
    const writeFile = vi.fn();

    await launchPaneExecution(options(mux, writeFile, undefined, "win32"));

    expect(mux.sendLongCommand).not.toHaveBeenCalled();
    expect(mux.sendCommand).toHaveBeenCalledWith(
      "surface-1",
      'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "/sessions/child.jsonl.launch.ps1"',
    );
    const [scriptPath, script, encoding] = writeFile.mock.calls[0]!;
    expect(scriptPath).toBe("/sessions/child.jsonl.launch.ps1");
expect(encoding).toBe("utf8");
    expect(script.startsWith("\ufeff")).toBe(true);
    expect(script).toContain("Set-Location -LiteralPath '/work/project'");
    expect(script).toContain("[Environment]::SetEnvironmentVariable('TOKEN', 'secret', 'Process')");
    expect(script).toContain("$arguments = @(");
expect(script).toContain("& 'C:\\runtime\\node.exe' @arguments");
    expect(script).toContain("'C:\\pi\\cli.js'");
    expect(script).toContain("'--session'");
    expect(script).toContain("'/sessions/child.jsonl'");
    expect(script).toContain("'/skill:review-correctness'");
    expect(script).toContain("'do the work'");
    expect(script).toContain("Write-Output \"__SUBAGENT_DONE_${exitCode}__\"");
expect(script).toContain("Remove-Item -LiteralPath $PSCommandPath");
    expect(script).not.toMatch(/bash|\.sh|\$\?|TOKEN=/i);
  });
it("preserves Chinese prompts in a PowerShell 5.1-compatible UTF-8 script", async () => {
    const mux = fakeMux();
    const writeFile = vi.fn();

    await launchPaneExecution({ ...options(mux, writeFile, undefined, "win32"), prompt: "只读审查：返回拒绝原因。" });

    const script = writeFile.mock.calls[0]![1] as string;
    expect(script.startsWith("\ufeff")).toBe(true);
    expect(script).toContain("'只读审查：返回拒绝原因。'");
  });
it("retries the managed Herdr layout after an empty pane ID", async () => {
    const mux = fakeMux();
    mux.getMuxBackend.mockReturnValue("herdr");
    mux.createSurface.mockReturnValueOnce("").mockReturnValueOnce("surface-2");
    const previousPaneId = process.env.HERDR_PANE_ID;
    process.env.HERDR_PANE_ID = "test:parent";
const removeFile = vi.fn();

    try {
      const handle = await launchPaneExecution({ ...options(mux), dependencies: { ...options(mux).dependencies, removeFile } });
      expect(handle.surface).toBe("surface-2");
      expect(mux.createSurface).toHaveBeenCalledTimes(2);
expect(removeFile).toHaveBeenCalledWith("/tmp/herdr-subagent-pane-test_parent.json");
    } finally {
      if (previousPaneId === undefined) delete process.env.HERDR_PANE_ID;
      else process.env.HERDR_PANE_ID = previousPaneId;
    }
  });
it("rejects a headless fallback that cannot support steering", async () => {
    const mux = fakeMux();
    mux.isMuxAvailable.mockReturnValue(false);

    await expect(launchPaneExecution(options(mux))).rejects.toThrow("steer-capable mux surface");
    expect(mux.createSurface).not.toHaveBeenCalled();
  });

  it("routes wait, steering, interrupt, and idempotent close to the same surface", async () => {
    const mux = fakeMux();
const writeFile = vi.fn();
    const handle = await launchPaneExecution(options(mux, writeFile));
    const controller = new AbortController();
    const onTick = vi.fn();

    await handle.wait(controller.signal, onTick);
    handle.send("next");
    handle.interrupt();
    handle.close();
    handle.close();

    expect(mux.pollForExit).toHaveBeenCalledWith("surface-1", controller.signal, {
      interval: 1000,
      sessionFile: "/sessions/child.jsonl",
      onTick,
    });
    expect(mux.sendCommand).toHaveBeenCalledWith("surface-1", "next");
    expect(mux.sendEscape).toHaveBeenCalledWith("surface-1");
expect(writeFile).toHaveBeenCalledWith("/sessions/child.jsonl.exit", JSON.stringify({ type: "done" }));
    expect(mux.closeSurface).toHaveBeenCalledOnce();
  });

  it("closes a partially-created surface when launch fails", async () => {
    const mux = fakeMux();
    mux.sendLongCommand.mockImplementation(() => { throw new Error("launch failed"); });

    await expect(launchPaneExecution(options(mux))).rejects.toThrow("launch failed");
    expect(mux.closeSurface).toHaveBeenCalledWith("surface-1");
  });
});

function fakeHandle(result: Awaited<ReturnType<PaneExecutionHandle["wait"]>>): PaneExecutionHandle {
  return {
    surface: "surface-1",
    send: vi.fn(),
    interrupt: vi.fn(),
    close: vi.fn(),
    wait: vi.fn().mockResolvedValue(result),
  };
}

describe("pane completion mapping", () => {
  it.each([
    [{ reason: "done", exitCode: 0 }, { type: "done" }],
    [{ reason: "ping", exitCode: 0, ping: { name: "helper", message: "need input" } }, { type: "ping", name: "helper", message: "need input" }],
    [{ reason: "structured_output", exitCode: 0, structuredOutput: { answer: 42 } }, { type: "structured_output", value: { answer: 42 } }],
    [{ reason: "sentinel", exitCode: 7 }, { type: "failed", exitCode: 7 }],
  ] as const)("maps pollForExit result %#", async (pollResult, completion) => {
    const handle = fakeHandle(pollResult);

    await expect(observePaneCompletion({ handle })).resolves.toEqual({ status: "completed", completion });
    expect(handle.close).not.toHaveBeenCalled();
  });

  it("classifies an aborted poll as cancelled without closing the retained surface", async () => {
    const controller = new AbortController();
    controller.abort();
    const handle: PaneExecutionHandle = {
      surface: "surface-1",
      send: vi.fn(),
      interrupt: vi.fn(),
      close: vi.fn(),
      wait: vi.fn().mockRejectedValue(new Error("Aborted")),
    };

    await expect(observePaneCompletion({ handle, signal: controller.signal })).resolves.toEqual({ status: "cancelled" });
    expect(handle.close).not.toHaveBeenCalled();
  });

  it("propagates watcher failures without closing the retained surface", async () => {
    const handle: PaneExecutionHandle = {
      surface: "surface-1",
      send: vi.fn(),
      interrupt: vi.fn(),
      close: vi.fn(),
      wait: vi.fn().mockRejectedValue(new Error("screen unavailable")),
    };

    await expect(observePaneCompletion({ handle })).rejects.toThrow("screen unavailable");
    expect(handle.close).not.toHaveBeenCalled();
  });
});