import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import paneChild from "../src/pane-child.js";

function fixture(commands: any[] = []) {
  const handlers = new Map<string, Function[]>();
  const tools: any[] = [];
  const pi = {
    on: vi.fn((event: string, handler: Function) => handlers.set(event, [...(handlers.get(event) ?? []), handler])),
    getCommands: vi.fn(() => commands),
    registerTool: vi.fn((tool: any) => tools.push(tool)),
    sendUserMessage: vi.fn(),
  } as any;
  return { pi, handlers, tools };
}

beforeEach(() => {
  delete process.env.PI_SUBAGENT_COMPLETION_FILE;
  delete process.env.PI_SUBAGENT_SKILLS;
  delete process.env.PI_SUBAGENT_RUN_ID;
  delete process.env.PI_SUBAGENT_ACTIVITY_FILE;
delete process.env.PI_SUBAGENT_READONLY;
});

test("injects requested native skills into every child agent start", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pane-child-"));
  const skillPath = path.join(dir, "skill.md");
  await writeFile(skillPath, "---\nname: review-correctness\n---\nReview rules", "utf8");
  process.env.PI_SUBAGENT_COMPLETION_FILE = path.join(dir, "done.json");
  process.env.PI_SUBAGENT_SKILLS = JSON.stringify(["review-correctness"]);
  const { pi, handlers } = fixture([{ source: "skill", name: "skill:review-correctness", sourceInfo: { path: skillPath, baseDir: dir } }]);

  paneChild(pi);
  handlers.get("session_start")![0]!({}, { shutdown: vi.fn() });
  const before = handlers.get("before_agent_start")![0]!;
  expect(before({ systemPrompt: "Base" }).systemPrompt).toContain("<skill name=\"review-correctness\"");
  expect(before({ systemPrompt: "Base" }).systemPrompt).toContain("Review rules");
});

test("missing requested skills terminate setup with an explicit completion error", async () => {
  const completionFile = path.join(await mkdtemp(path.join(tmpdir(), "pane-child-missing-")), "done.json");
  process.env.PI_SUBAGENT_COMPLETION_FILE = completionFile;
  process.env.PI_SUBAGENT_SKILLS = JSON.stringify(["missing-skill"]);
  const { pi, handlers } = fixture([]);
  const shutdown = vi.fn();

  paneChild(pi);
  handlers.get("session_start")![0]!({}, { shutdown });

  expect(shutdown).toHaveBeenCalledOnce();
  await expect(readFile(completionFile, "utf8")).resolves.toBe(JSON.stringify({
    type: "ping",
    name: "__subagent_setup_error__",
    message: "Requested skill is unavailable: missing-skill",
  }));
});
test("read-only viewer handles every input without registering execution tools", () => {
  process.env.PI_SUBAGENT_READONLY = "1";
  const { pi, handlers, tools } = fixture();

  paneChild(pi);
  const input = handlers.get("input")![0]!;
  expect(input({ text: "hello", source: "interactive" })).toEqual({ action: "handled" });
  expect(input({ text: "resume", source: "rpc" })).toEqual({ action: "handled" });
  expect(input({ text: "steer", source: "extension" })).toEqual({ action: "handled" });
  expect(tools).toHaveLength(0);
});