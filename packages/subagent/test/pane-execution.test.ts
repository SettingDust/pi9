import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { beforeEach, expect, test, vi } from "vitest";
import { launchPaneExecution, createPaneGenerationExecutor, readPaneCompletionOutput, reopenPaneExecution, resetPaneExecutionStateForTests } from "../src/pane-execution.js";
import { Conversation } from "../src/conversation.js";

beforeEach(() => {
  vi.unstubAllEnvs();
  resetPaneExecutionStateForTests();
});
function mux() {
  return {
    closeSurface: vi.fn(),
    createSurface: vi.fn(() => "pane-1"),
    getMuxBackend: vi.fn(() => "test"),
    isMuxAvailable: vi.fn(() => true),
    sendCommand: vi.fn(),
    sendEscape: vi.fn(),
    sendLongCommand: vi.fn(() => "script"),
    shellEscape: vi.fn(value => `'${String(value).replaceAll("'", "'\\''")}'`),
    pollForExit: vi.fn(async (_surface, _signal, options) => {
      options.onTick?.(0);
      return { reason: "done", exitCode: 0 };
    }),
  };
}

function herdrMux() {
  const fakeMux = mux();
  let nextSurface = 0;
  const createSurfaceSplit = vi.fn((_name: string, _direction: "left" | "right" | "up" | "down", _source?: string) => `pane-${++nextSurface}`);
  fakeMux.getMuxBackend.mockReturnValue("herdr");
  return { fakeMux: Object.assign(fakeMux, { createSurfaceSplit }), createSurfaceSplit };
}

async function launchHerdrPane(fakeMux: ReturnType<typeof herdrMux>["fakeMux"], directory: string, index: number) {
  return launchPaneExecution({
    cwd: directory,
    sessionFile: path.join(directory, `child-${index}.jsonl`),
    prompt: `work ${index}`,
    extensionPaths: [],
    env: {},
    piInvocation: { command: "pi", args: [] },
    dependencies: { mux: fakeMux as any, sleep: async () => undefined, platform: "linux" },
  });
}

const definition = { name: "worker", description: "", systemPrompt: "System", source: "project" as const };

function ctx(tmp: string) {
  return {
    cwd: tmp,
    model: { provider: "provider", id: "model" },
    modelRegistry: { getAll: () => [{ provider: "provider", id: "model" }] },
    sessionManager: { getSessionFile: () => path.join(tmp, "parent.jsonl") },
  } as any;
}

test("unix launcher stores prompt as one bash argv array element", async () => {
  const fakeMux = mux();
  const sessionFile = path.join(await mkdtemp(path.join(tmpdir(), "pane-launch-")), "child.jsonl");
  const prompt = "handoff:\n  objective: review correctness\n  details: keep words together";
  await launchPaneExecution({
    cwd: path.dirname(sessionFile),
    sessionFile,
    prompt,
    extensionPaths: [],
    env: {},
    piInvocation: { command: "pi", args: [] },
    dependencies: { mux: fakeMux as any, sleep: async () => undefined, platform: "linux" },
  });

  expect(fakeMux.sendCommand).not.toHaveBeenCalled();
  const [surface, command, options] = fakeMux.sendLongCommand.mock.calls[0] as unknown as [string, string, { scriptPath: string; scriptPreamble: string }];
  expect(surface).toBe("pane-1");
  expect(options.scriptPath).toBe(`${sessionFile}.launch.sh`);
  expect(options.scriptPreamble).toContain("cd ");
  expect(options.scriptPreamble).toContain("__args=(");
  expect(options.scriptPreamble).toContain(prompt);
  expect(command).toContain('(\"${__args[@]}\")');
  expect(command).toContain("__code=$?");
  expect(command).not.toContain(prompt);
  expect(command).not.toContain("/skill");
});

test("Herdr creates child panes in the approved source cycle", async () => {
  vi.stubEnv("HERDR_PANE_ID", "main");
  const directory = await mkdtemp(path.join(tmpdir(), "pane-herdr-layout-"));
  const { fakeMux, createSurfaceSplit } = herdrMux();
  const handles = [];

  try {
    for (let index = 1; index <= 9; index++) handles.push(await launchHerdrPane(fakeMux, directory, index));
    expect(createSurfaceSplit.mock.calls.map(([, direction, source]) => [source, direction])).toEqual([
      ["main", "right"],
      ["pane-1", "right"],
      ["pane-1", "down"],
      ["pane-2", "down"],
      ["pane-1", "down"],
      ["pane-2", "down"],
      ["pane-3", "down"],
      ["pane-4", "down"],
      ["pane-1", "down"],
    ]);
  } finally {
    for (const handle of handles.reverse()) handle.close();
  }
});

test("Herdr keeps the P5+ source cycle after closing a non-anchor pane", async () => {
  vi.stubEnv("HERDR_PANE_ID", "main");
  const directory = await mkdtemp(path.join(tmpdir(), "pane-herdr-close-cycle-"));
  const { fakeMux, createSurfaceSplit } = herdrMux();
  const handles = [];

  try {
    for (let index = 1; index <= 5; index++) handles.push(await launchHerdrPane(fakeMux, directory, index));
    handles[4]!.close();
    handles.push(await launchHerdrPane(fakeMux, directory, 6));
    expect(createSurfaceSplit.mock.calls.at(-1)?.slice(1)).toEqual(["down", "pane-2"]);
  } finally {
    for (const handle of handles.reverse()) handle.close();
  }
});

test("Herdr removes the missing selected source and recomputes the split", async () => {
  vi.stubEnv("HERDR_PANE_ID", "main");
  const directory = await mkdtemp(path.join(tmpdir(), "pane-herdr-recovery-"));
  const { fakeMux, createSurfaceSplit } = herdrMux();
  createSurfaceSplit.mockImplementation((_name: string, direction: "left" | "right" | "up" | "down", source?: string) => {
    if (source === "pane-1" && direction === "down") throw new Error("pane_not_found");
    return `pane-${createSurfaceSplit.mock.results.filter(result => result.type === "return").length + 1}`;
  });
  const handles = [];

  try {
    for (let index = 1; index <= 4; index++) handles.push(await launchHerdrPane(fakeMux, directory, index));
    expect(createSurfaceSplit.mock.calls.map(([, direction, source]) => [source, direction])).toEqual([
      ["main", "right"],
      ["pane-1", "right"],
      ["pane-1", "down"],
      ["pane-2", "right"],
      ["pane-2", "down"],
    ]);
    expect(createSurfaceSplit.mock.results[2]?.type).toBe("throw");
    expect(createSurfaceSplit.mock.calls[3]?.slice(1)).toEqual(["right", "pane-2"]);
  } finally {
    for (const handle of handles.reverse()) handle.close();
  }
});

test("pane Generation reports running after control binding and before completion", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "pane-running-"));
  const fakeMux = mux();
  let release!: () => void;
  fakeMux.pollForExit.mockImplementationOnce(() => new Promise(resolve => {
    release = () => resolve({ reason: "done", exitCode: 0 });
  }));
  const statuses: string[] = [];
  const conversation = new Conversation("running-pane" as any, definition, { kind: "spawn", agent: "worker", prompt: "wait", label: "wait" }, (changed, kind) => {
    if (kind === "status") statuses.push(changed.status.kind);
  });
  const executor = createPaneGenerationExecutor({ mux: fakeMux as any, sleep: async () => undefined, platform: "linux", loadExtensionPaths: async () => [] });

  expect(conversation.status.kind).toBe("queued");
  const execution = executor(ctx(tmp), conversation, conversation.latestGeneration);
  await vi.waitFor(() => expect(statuses).toEqual(["running"]));
  expect(conversation.status.kind).toBe("running");
  release();
  await execution;
});

test("windows launcher keeps large prompts out of PowerShell native argv", async () => {
  const fakeMux = mux();
  const directory = await mkdtemp(path.join(tmpdir(), "pane-win-"));
  const sessionFile = path.join(directory, "child.jsonl");
  const captureFile = path.join(directory, "argv.json");
  const captureScript = path.join(directory, "capture.cjs");
  const prompt = JSON.stringify({ handoff: { objective: "Repair only Markdown lint defects", task: "word ".repeat(400) } });
  await writeFile(captureScript, `require("node:fs").writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)))\n`);
  await launchPaneExecution({
    cwd: directory,
    sessionFile,
    prompt,
    extensionPaths: Array.from({ length: 20 }, (_, index) => path.join(directory, `package-${index}`, "extension.ts")),
    systemPrompt: "System ".repeat(800),
    env: {},
    piInvocation: { command: process.execPath, args: [captureScript, captureFile] },
    dependencies: { mux: fakeMux as any, sleep: async () => undefined, platform: "win32" },
  });

  const powerShellScript = await readFile(`${sessionFile}.launch.ps1`, "utf8");
  const nodeScript = await readFile(`${sessionFile}.launch.cjs`, "utf8");
  expect(powerShellScript.charCodeAt(0)).toBe(0xfeff);
  expect(powerShellScript).not.toContain(prompt);
  expect(powerShellScript).toContain(".launch.cjs");
  expect(nodeScript).toContain("spawnSync");
  expect(nodeScript).toContain("completionFile");
  execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", `${sessionFile}.launch.ps1`]);
  const argv = JSON.parse(await readFile(captureFile, "utf8")) as string[];
  expect(argv.at(-1)).toBe(prompt);
  expect(argv.filter(argument => argument === prompt)).toHaveLength(1);
expect(JSON.parse(await readFile(`${sessionFile}.exit`, "utf8"))).toEqual({ type: "failed", exitCode: 0 });
await expect(readFile(`${sessionFile}.launch.cjs`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  expect(fakeMux.sendCommand.mock.calls[0]?.[1]).toContain("powershell.exe");
});

test("reserved setup-error pings fail live panes and are not recovered as successful output", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "pane-skill-error-"));
  const fakeMux = mux();
  (fakeMux.pollForExit as any).mockResolvedValue({
    reason: "ping",
    exitCode: 0,
    ping: { name: "__subagent_setup_error__", message: "Requested skill is unavailable: missing" },
  });
  const executor = createPaneGenerationExecutor({ mux: fakeMux as any, sleep: async () => undefined, platform: "linux", loadExtensionPaths: async () => [] });
  const conversation = new Conversation("skill-error" as any, definition, { kind: "spawn", agent: "worker", prompt: "test", label: "test" }, () => {});

  await expect(executor(ctx(tmp), conversation, conversation.latestGeneration)).resolves.toMatchObject({
    status: { kind: "done", outcome: "error", error: "Requested skill is unavailable: missing" },
  });

  const sessionFile = path.join(tmp, "recovered.jsonl");
  await writeFile(`${sessionFile}.exit`, JSON.stringify({ type: "ping", name: "__subagent_setup_error__", message: "missing" }), "utf8");
  expect(readPaneCompletionOutput(sessionFile)).toBeUndefined();
});
test("reopened panes load the read-only child extension in a separate pane", async () => {
  const fakeMux = mux();
  const sessionFile = path.join(await mkdtemp(path.join(tmpdir(), "pane-viewer-")), "child.jsonl");
  await writeFile(sessionFile, "", "utf8");

  await reopenPaneExecution({
    cwd: path.dirname(sessionFile),
    sessionFile,
    extensionPaths: ["ignored-extension.ts"],
    env: { OTHER: "value" },
    piInvocation: { command: "pi", args: [] },
    dependencies: { mux: fakeMux as any, sleep: async () => undefined, platform: "linux" },
  });

  const [, command, options] = fakeMux.sendLongCommand.mock.calls[0] as unknown as [string, string, { scriptPreamble: string }];
  expect(options.scriptPreamble).toContain("PI_SUBAGENT_READONLY='1'");
  expect(options.scriptPreamble).toContain("pane-child.ts");
expect(options.scriptPreamble).not.toContain("'--no-extensions'");
  expect(options.scriptPreamble).toContain("ignored-extension.ts");
  expect(command).not.toContain("pane-child.ts");
});

test("pane Generation executor launches one child prompt and projects activity", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "pane-exec-"));
  await mkdir(path.join(tmp, "skills", "review"), { recursive: true });
  const fakeMux = mux();
  fakeMux.pollForExit.mockImplementationOnce(async (_surface, _signal, options) => {
    const activityFile = path.join(tmp, "parent", "tasks", "calm-otter-g1.jsonl.activity.json");
    await import("node:fs/promises").then(fs => fs.mkdir(path.dirname(activityFile), { recursive: true }).then(() => fs.writeFile(activityFile, JSON.stringify({
      version: 1,
      runningChildId: "calm-otter:1",
      sequence: 1,
      updatedAt: Date.now(),
      latestEvent: "turn_end",
      phase: "done",
      turnIndex: 0,
    }))));
    options.onTick?.(0);
    return { reason: "structured_output", exitCode: 0, structuredOutput: "done" };
  });

  const executor = createPaneGenerationExecutor({ mux: fakeMux as any, sleep: async () => undefined, platform: "linux", loadExtensionPaths: async () => [], getPiInvocation: () => ({ command: "node", args: ["/current/pi.js"] }) });
  const conversation = new Conversation("calm-otter" as any, definition, { kind: "spawn", agent: "worker", prompt: "handoff:\n  objective: review", label: "review" }, () => {});
  const result = await executor(ctx(tmp), conversation, conversation.latestGeneration);

  expect(result.status).toMatchObject({ kind: "done", outcome: "completed", output: "done" });
  const [, command, options] = fakeMux.sendLongCommand.mock.calls[0] as unknown as [string, string, { scriptPreamble: string }];
  expect(options.scriptPreamble).toContain("'node'");
  expect(options.scriptPreamble).toContain("'/current/pi.js'");
  expect(command).not.toContain(" pi ");
  expect(options.scriptPreamble).toContain("handoff:\n  objective: review");
  expect(options.scriptPreamble).toContain("When finished, call the subagent_done tool");
  expect(command).toContain('("${__args[@]}")');
  expect(command).not.toContain("handoff:\n  objective: review");
  expect(command).not.toContain("/skill");
  expect(result.activity.turns).toBe(1);
});
test("completed pane closes after child session shutdown is recorded", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "pane-shutdown-"));
  const fakeMux = mux();
  (fakeMux.pollForExit as any).mockResolvedValue({ reason: "structured_output", exitCode: 0, structuredOutput: "done" });
  const activityFile = path.join(tmp, "parent", "tasks", "shutdown-g1.jsonl.activity.json");
  const executor = createPaneGenerationExecutor({
    mux: fakeMux as any,
    platform: "linux",
    loadExtensionPaths: async () => [],
    sleep: async () => {
      expect(fakeMux.closeSurface).not.toHaveBeenCalled();
      await writeFile(activityFile, JSON.stringify({ version: 1, runningChildId: "shutdown:1", sequence: 1, updatedAt: Date.now(), latestEvent: "session_shutdown", phase: "done" }));
    },
  });
  const conversation = new Conversation("shutdown" as any, definition, { kind: "spawn", agent: "worker", prompt: "done", label: "done" }, () => {});

  await executor(ctx(tmp), conversation, conversation.latestGeneration);

  expect(fakeMux.closeSurface).toHaveBeenCalledWith("pane-1");
});
test("pane Generation executor resumes with the retained child session file", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "pane-resume-"));
  const fakeMux = mux();
  (fakeMux.pollForExit as any).mockResolvedValue({ reason: "structured_output", exitCode: 0, structuredOutput: "done" });
  const executor = createPaneGenerationExecutor({ mux: fakeMux as any, sleep: async () => undefined, platform: "linux", loadExtensionPaths: async () => [] });
  const conversation = new Conversation("calm-otter" as any, definition, { kind: "spawn", agent: "worker", prompt: "first", label: "review" }, () => {});

  await executor(ctx(tmp), conversation, conversation.latestGeneration);
  conversation.markJoined(conversation.latestGeneration);
  const retained = conversation.sessionFileForResume();
  const resume = conversation.beginResume("continue");
  await executor(ctx(tmp), conversation, resume);

  expect(conversation.sessionFileForResume()).toBe(retained);
  const [, secondCommand, secondOptions] = (fakeMux.sendLongCommand.mock.calls as unknown as [string, string, { scriptPreamble: string }][])[1]!;
  expect(secondOptions.scriptPreamble).toContain(`${retained}`);
  expect(secondOptions.scriptPreamble).toContain("continue");
  expect(secondCommand).toContain('("${__args[@]}")');
  expect(secondCommand).not.toContain("continue");
});
async function runPane(fakeMux: ReturnType<typeof mux>, prompt: string, suffix = prompt) {
  const tmp = await mkdtemp(path.join(tmpdir(), `pane-${suffix.replace(/\W/g, "")}-`));
  const executor = createPaneGenerationExecutor({ mux: fakeMux as any, sleep: async () => undefined, platform: "linux", loadExtensionPaths: async () => [] });
  const conversation = new Conversation(`conv-${suffix}` as any, definition, { kind: "spawn", agent: "worker", prompt, label: prompt }, () => {});
  return executor(ctx(tmp), conversation, conversation.latestGeneration);
}

test("terminal pane generations close automatically", async () => {
  const fakeMux = mux();
  let nextSurface = 0;
  fakeMux.createSurface.mockImplementation(() => `pane-${++nextSurface}`);

  for (let i = 0; i < 4; i++) await runPane(fakeMux, `done ${i}`, String(i));

  expect(fakeMux.closeSurface).toHaveBeenCalledTimes(4);
  expect(fakeMux.closeSurface.mock.calls.map(call => call[0])).toEqual(["pane-1", "pane-2", "pane-3", "pane-4"]);
});
test("cancelled pane generations are closed instead of retained", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "pane-cancel-"));
  const fakeMux = mux();
  let release!: () => void;
  fakeMux.pollForExit.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ reason: "done", exitCode: 0 }); }));
  const executor = createPaneGenerationExecutor({ mux: fakeMux as any, sleep: async () => undefined, platform: "linux", loadExtensionPaths: async () => [] });
  const conversation = new Conversation("cancel-pane" as any, definition, { kind: "spawn", agent: "worker", prompt: "wait", label: "wait" }, () => {});

  const execution = executor(ctx(tmp), conversation, conversation.latestGeneration);
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  await conversation.abort("cancelled");
  release();
  await execution;

  expect(fakeMux.closeSurface).toHaveBeenCalledWith("pane-1");
});