import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { beforeEach, expect, test, vi } from "vitest";
import { launchPaneExecution, createPaneGenerationExecutor, resetPaneExecutionStateForTests } from "../src/pane-execution.js";
import { Conversation } from "../src/conversation.js";

beforeEach(() => resetPaneExecutionStateForTests());
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

test("completed pane retention keeps a total budget of three child panes", async () => {
  const fakeMux = mux();
  let nextSurface = 0;
  fakeMux.createSurface.mockImplementation(() => `pane-${++nextSurface}`);

  for (let i = 0; i < 4; i++) await runPane(fakeMux, `done ${i}`, String(i));

  expect(fakeMux.closeSurface).toHaveBeenCalledTimes(1);
  expect(fakeMux.closeSurface).toHaveBeenCalledWith("pane-1");
});

test("active panes immediately trim retained completed allowance", async () => {
  const fakeMux = mux();
  let nextSurface = 0;
  fakeMux.createSurface.mockImplementation(() => `active-${++nextSurface}`);

  for (let i = 0; i < 3; i++) await runPane(fakeMux, `done ${i}`, `complete-${i}`);
  expect(fakeMux.closeSurface).not.toHaveBeenCalled();

  let releaseActive!: () => void;
  fakeMux.pollForExit.mockImplementationOnce(() => new Promise(resolve => { releaseActive = () => resolve({ reason: "done", exitCode: 0 }); }));
  const activePromise = runPane(fakeMux, "wait", "active");
  await vi.waitFor(() => expect(releaseActive).toBeTypeOf("function"));

  expect(fakeMux.closeSurface).toHaveBeenCalledWith("active-1");
  releaseActive();
  await activePromise;
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