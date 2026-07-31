import { describe, expect, it, vi } from "vitest";
import {
  launchPaneExecution,
  observePaneCompletion,
  reopenPaneExecution,
  retainedHerdrPaneExists,
  type PaneExecutionHandle,
} from "../src/pane-execution.js";

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
      "cd [/work/project] && TOKEN=[secret] [C:\\runtime\\node.exe] [C:\\pi\\cli.js] --session [/sessions/child.jsonl] -e [/extensions/one.ts] --model [provider/model:high] --system-prompt [You are focused.] --tools [read,subagent_done,caller_ping] [do the work]; echo '__SUBAGENT_DONE_'$?'__'",
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
    expect(script).not.toContain("'/skill:review-correctness'");
    expect(script).not.toContain("'/skill:ponytail'");
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
it("alternates Herdr splits within the child region", async () => {
    const mux = fakeMux();
    const split = vi.fn()
      .mockReturnValueOnce("surface-a")
      .mockReturnValueOnce("surface-b")
      .mockReturnValueOnce("surface-c");
    (mux as any).createSurfaceSplit = split;
    const previousPaneId = process.env.HERDR_PANE_ID;
    process.env.HERDR_PANE_ID = "parent";

    try {
      const first = await launchPaneExecution(options(mux));
      const second = await launchPaneExecution(options(mux));
      const third = await launchPaneExecution(options(mux));
      expect(split.mock.calls).toEqual([
        ["subagent", "right", "parent"],
        ["subagent", "down", "surface-a"],
        ["subagent", "right", "surface-b"],
      ]);
      third.close();
      second.close();
      first.close();
    } finally {
      if (previousPaneId === undefined) delete process.env.HERDR_PANE_ID;
      else process.env.HERDR_PANE_ID = previousPaneId;
    }
  });

it("restarts the Herdr child region when the previous source disappeared", async () => {
    const mux = fakeMux();
    const split = vi.fn()
      .mockReturnValueOnce("surface-stale")
      .mockImplementationOnce(() => { throw new Error("pane_not_found"); })
      .mockReturnValueOnce("surface-recovered");
    (mux as any).createSurfaceSplit = split;
    const previousPaneId = process.env.HERDR_PANE_ID;
    process.env.HERDR_PANE_ID = "parent";

    try {
      await launchPaneExecution(options(mux));
      const recovered = await launchPaneExecution(options(mux));
      expect(split.mock.calls).toEqual([
        ["subagent", "right", "parent"],
        ["subagent", "down", "surface-stale"],
        ["subagent", "right", "parent"],
      ]);
      recovered.close();
    } finally {
      if (previousPaneId === undefined) delete process.env.HERDR_PANE_ID;
      else process.env.HERDR_PANE_ID = previousPaneId;
    }
  });

  it("does not retry non-missing-pane split failures", async () => {
    const mux = fakeMux();
    const split = vi.fn(() => { throw new Error("mux unavailable"); });
    (mux as any).createSurfaceSplit = split;
    const previousPaneId = process.env.HERDR_PANE_ID;
    process.env.HERDR_PANE_ID = "parent";

    try {
      await expect(launchPaneExecution(options(mux))).rejects.toThrow("mux unavailable");
      expect(split).toHaveBeenCalledOnce();
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
it("treats an already-closed pane as an idempotent interrupt", async () => {
    const mux = fakeMux();
    const writeFile = vi.fn();
    mux.sendEscape.mockImplementation(() => { throw new Error('pane_not_found: pane not found'); });
    const handle = await launchPaneExecution(options(mux, writeFile));

    expect(() => handle.interrupt()).not.toThrow();
    expect(writeFile).toHaveBeenCalledWith("/sessions/child.jsonl.exit", JSON.stringify({ type: "done" }));
  });

  it("propagates non-missing-pane interrupt failures", async () => {
    const mux = fakeMux();
    mux.sendEscape.mockImplementation(() => { throw new Error("mux unavailable"); });
    const handle = await launchPaneExecution(options(mux));

    expect(() => handle.interrupt()).toThrow("mux unavailable");
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
describe("pane display names", () => {
  it("sanitizes, trims, caps, and falls back display names for regular panes", async () => {
    const mux = fakeMux();

    await launchPaneExecution(options(mux));
    await launchPaneExecution({ ...options(mux), displayName: "\u0000\u007f" });
    await launchPaneExecution({ ...options(mux), displayName: `  ${"x".repeat(60)}  ` });

    expect((mux.createSurface.mock.calls as unknown as [string][]).map(([name]) => name)).toEqual(["subagent", "subagent", "x".repeat(48)]);
  });

  it("passes the sanitized display name to managed Herdr splits", async () => {
    const mux = fakeMux();
    const split = vi.fn(() => "surface-herdr");
    (mux as any).createSurfaceSplit = split;
    const previousPaneId = process.env.HERDR_PANE_ID;
    process.env.HERDR_PANE_ID = "parent";

    try {
      const handle = await launchPaneExecution({ ...options(mux), displayName: "  child\u0007 pane  " });

      expect(split).toHaveBeenCalledWith("child pane", "right", "parent");
      handle.close();
    } finally {
      if (previousPaneId === undefined) delete process.env.HERDR_PANE_ID;
      else process.env.HERDR_PANE_ID = previousPaneId;
    }
  });
});

describe("retained Herdr pane probing", () => {
  it("classifies successful and missing pane probes", async () => {
    const execFile = vi.fn();
    const mux = fakeMux();

    await expect(retainedHerdrPaneExists("surface-1", { mux, execFile })).resolves.toBe(true);
    execFile.mockImplementationOnce(() => { throw new Error("pane_not_found"); });
    await expect(retainedHerdrPaneExists("surface-2", { mux, execFile })).resolves.toBe(false);
    expect(execFile).toHaveBeenNthCalledWith(1, "herdr", ["pane", "get", "surface-1"], expect.any(Object));
    expect(execFile).toHaveBeenNthCalledWith(2, "herdr", ["pane", "get", "surface-2"], expect.any(Object));
  });

  it("rethrows unrelated probe failures", async () => {
    const execFile = vi.fn(() => { throw new Error("herdr unavailable"); });

    await expect(retainedHerdrPaneExists("surface-1", { mux: fakeMux(), execFile })).rejects.toThrow("herdr unavailable");
  });

  it("rejects unsupported mux backends without probing", async () => {
    const execFile = vi.fn();
    const mux = fakeMux();
    mux.getMuxBackend.mockReturnValue("tmux");

    await expect(retainedHerdrPaneExists("surface-1", { mux, execFile })).rejects.toThrow("unsupported mux backend: tmux");
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe("pane execution reopen", () => {
  it("reopens Unix with only the explicit invocation, session, and extensions", async () => {
    const mux = fakeMux();
    const handle = await reopenPaneExecution({
      cwd: "/work/project",
      sessionFile: "/sessions/reopen-unix.jsonl",
      displayName: "reopen",
      extensionPaths: ["/extensions/one.ts", "/extensions/two.ts"],
      env: { TOKEN: "secret" },
      piInvocation: { command: "C:\\runtime\\node.exe", args: ["C:\\pi\\cli.js"] },
      dependencies: { mux, platform: "linux", stat: vi.fn(() => ({ isFile: () => true }) as any) },
    });

    const command = (mux.sendLongCommand.mock.calls as unknown as [string, string][])[0]![1];
    expect(command).toContain("[C:\\runtime\\node.exe] [C:\\pi\\cli.js] --session [/sessions/reopen-unix.jsonl]");
    expect(command).toContain("-e [/extensions/one.ts] -e [/extensions/two.ts]");
    expect(command).not.toContain("do the work");
    expect(command).not.toContain("/skill:");
    expect(command).not.toMatch(/--(?:model|tools|system-prompt)/);
    handle.close();
  });

  it("reopens Windows through PowerShell without a prompt or Bash transport", async () => {
    const mux = fakeMux();
    const writeFile = vi.fn();
    const handle = await reopenPaneExecution({
      cwd: "C:\\work\\project",
      sessionFile: "C:\\sessions\\reopen-windows.jsonl",
      displayName: "reopen",
      extensionPaths: ["C:\\extensions\\one.ts", "C:\\extensions\\two.ts"],
      env: { TOKEN: "secret" },
      piInvocation: { command: "C:\\runtime\\node.exe", args: ["C:\\pi\\cli.js"] },
      dependencies: { mux, writeFile, platform: "win32", stat: vi.fn(() => ({ isFile: () => true }) as any) },
    });

    const script = writeFile.mock.calls[0]![1] as string;
    expect(script).toContain("& 'C:\\runtime\\node.exe' @arguments");
    expect(script).toContain("'C:\\pi\\cli.js'");
    expect(script).toContain("'--session'");
    expect(script).toContain("'C:\\sessions\\reopen-windows.jsonl'");
    expect(script).toContain("'-e', 'C:\\extensions\\one.ts', '-e', 'C:\\extensions\\two.ts'");
    expect(script).not.toContain("do the work");
    expect(script).not.toContain("/skill:");
    expect(script).not.toMatch(/--(?:model|tools|system-prompt)/);
    expect(script).not.toMatch(/bash|\.sh/i);
    expect(mux.sendCommand).toHaveBeenCalledWith("surface-1", expect.stringContaining("powershell.exe"));
    handle.close();
  });

it("rejects a non-absolute session file before stat or surface creation", async () => {
    const mux = fakeMux();
    const stat = vi.fn();

    await expect(reopenPaneExecution({
      cwd: "/work/project",
      sessionFile: "sessions/reopen.jsonl",
      extensionPaths: [],
      dependencies: { mux, stat },
    })).rejects.toThrow("absolute session file");
    expect(stat).not.toHaveBeenCalled();
    expect(mux.createSurface).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", vi.fn(() => { throw new Error("ENOENT"); })],
    ["non-file", vi.fn(() => ({ isFile: () => false }) as any)],
  ])("rejects a %s session before creating a surface", async (_label, stat) => {
    const mux = fakeMux();

    await expect(reopenPaneExecution({
      cwd: "/work/project",
      sessionFile: "/sessions/reopen.jsonl",
      extensionPaths: [],
      dependencies: { mux, stat },
    })).rejects.toThrow(_label === "non-file" ? "regular file" : "missing or inaccessible");
    expect(mux.createSurface).not.toHaveBeenCalled();
  });

  it("returns a viewer handle that cannot wait or write a completion sidecar", async () => {
    const mux = fakeMux();
    const writeFile = vi.fn();
    const handle = await reopenPaneExecution({
      cwd: "/work/project",
      sessionFile: "/sessions/reopen.jsonl",
      extensionPaths: [],
      dependencies: { mux, writeFile, platform: "linux", stat: vi.fn(() => ({ isFile: () => true }) as any) },
    });

    await expect(handle.wait()).rejects.toThrow("viewer handle");
    expect(() => handle.interrupt()).not.toThrow();
    expect(writeFile).not.toHaveBeenCalledWith("/sessions/reopen.jsonl.exit", expect.anything());
    handle.close();
  });

  it("does not consume a stale completion sidecar when reopening", async () => {
    const mux = fakeMux();
    const handle = await reopenPaneExecution({
      cwd: "/work/project",
      sessionFile: "/sessions/reopen.jsonl",
      extensionPaths: [],
      dependencies: { mux, platform: "linux", stat: vi.fn(() => ({ isFile: () => true }) as any) },
    });

    expect(mux.pollForExit).not.toHaveBeenCalled();
    handle.close();
  });
});