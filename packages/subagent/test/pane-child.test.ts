import { mkdtemp, writeFile } from "node:fs/promises";
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
});

test("injects requested native skills into every child agent start", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pane-child-"));
  const skillPath = path.join(dir, "skill.md");
  await writeFile(skillPath, "---\nname: review-correctness\n---\nReview rules", "utf8");
  process.env.PI_SUBAGENT_COMPLETION_FILE = path.join(dir, "done.json");
  process.env.PI_SUBAGENT_SKILLS = JSON.stringify(["review-correctness"]);
  const { pi, handlers } = fixture([{ source: "skill", name: "skill:review-correctness", sourceInfo: { path: skillPath, baseDir: dir } }]);

  paneChild(pi);
  const before = handlers.get("before_agent_start")![0]!;
  expect(before({ systemPrompt: "Base" }).systemPrompt).toContain("<skill name=\"review-correctness\"");
  expect(before({ systemPrompt: "Base" }).systemPrompt).toContain("Review rules");
});

test("missing requested skills inject a fatal caller_ping instruction instead of throwing", () => {
  process.env.PI_SUBAGENT_COMPLETION_FILE = path.join(tmpdir(), "pane-child-missing.json");
  process.env.PI_SUBAGENT_SKILLS = JSON.stringify(["missing-skill"]);
  const { pi, handlers } = fixture([]);

  paneChild(pi);
  const before = handlers.get("before_agent_start")![0]!;
  const result = before({ systemPrompt: "Base" });

  expect(result.systemPrompt).toContain("Fatal subagent setup error");
  expect(result.systemPrompt).toContain("Requested skill is unavailable: missing-skill");
  expect(result.systemPrompt).toContain("caller_ping");
});