import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import paneChild from "../src/pane-child.js";

const originalEnv = { ...process.env };
const fixtureCleanups: Array<() => void> = [];

afterEach(() => {
  vi.useRealTimers();
  process.env = { ...originalEnv };
  for (const cleanup of fixtureCleanups.splice(0)) cleanup();
});

function fixture() {
  const handlers = new Map<string, Array<(event?: any, ctx?: any) => void>>();
  const tools = new Map<string, any>();
  const activityDirectory = mkdtempSync(join(tmpdir(), "pi9-pane-child-"));
  fixtureCleanups.push(() => rmSync(activityDirectory, { recursive: true, force: true }));
  const activityFile = join(activityDirectory, "activity.json");
  const pi = {
    on: vi.fn((event: string, handler: (value?: any, ctx?: any) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }),
registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    sendUserMessage: vi.fn(),
    getCommands: vi.fn(() => []) as any,
  };
  process.env.PI_SUBAGENT_COMPLETION_FILE = "completion.exit";
  process.env.PI_SUBAGENT_RUN_ID = "run-1";
  process.env.PI_SUBAGENT_ACTIVITY_FILE = activityFile;
  paneChild(pi as any);
  const emit = (event: string, value: any = {}) => {
    for (const handler of handlers.get(event) ?? []) handler(value, {});
  };
  return {
    pi,
    tools,
    emit,
    readActivity: () => JSON.parse(readFileSync(activityFile, "utf8")),
    handlers,
};
}

describe("pane child completion rendering", () => {
  it("renders the supplied subagent_done result", () => {
    const { tools } = fixture();
    const renderCall = tools.get("subagent_done")?.renderCall;
    expect(renderCall({ result: { summary: "finished" } }, {} as any, {} as any).text).toContain("summary");
    expect(tools.get("caller_ping")?.renderCall).toBeUndefined();
  });

  it("loads all requested skills into every turn without extra prompt turns", () => {
    const f = fixture();
    const skillA = join(tmpdir(), `pi9-skill-a-${Date.now()}.md`);
    const skillB = join(tmpdir(), `pi9-skill-b-${Date.now()}.md`);
    writeFileSync(skillA, "---\nname: skill-a\ndescription: A\n---\nA instructions");
    writeFileSync(skillB, "---\nname: skill-b\ndescription: B\n---\nB instructions");
    fixtureCleanups.push(() => { rmSync(skillA, { force: true }); rmSync(skillB, { force: true }); });
    f.pi.getCommands.mockReturnValue([
      { name: "skill:skill-a", source: "skill", sourceInfo: { path: skillA, baseDir: tmpdir() } },
      { name: "skill:skill-b", source: "skill", sourceInfo: { path: skillB, baseDir: tmpdir() } },
    ]);
    process.env.PI_SUBAGENT_SKILLS = JSON.stringify(["skill-a", "skill-b"]);
    const event: any = [...(f.handlers.get("before_agent_start") ?? [])][0]({ systemPrompt: "base" });
    expect(event.systemPrompt).toContain("A instructions");
    expect(event.systemPrompt).toContain("B instructions");
    expect(event.systemPrompt.match(/<skill /g)).toHaveLength(2);
const followUp: any = [...(f.handlers.get("before_agent_start") ?? [])][0]({ systemPrompt: "next" });
    expect(followUp.systemPrompt).toContain("A instructions");
    expect(followUp.systemPrompt).toContain("B instructions");
    expect(f.pi.getCommands).toHaveBeenCalledOnce();
  });
});

describe("pane child activity", () => {
  it("forwards only assistant message usage", () => {
    const { emit, readActivity } = fixture();
    const usage = {
      input: 120,
      output: 30,
      cacheRead: 40,
      cacheWrite: 5,
      totalTokens: 195,
      cost: { input: 0.0012, output: 0.0009, cacheRead: 0.00004, cacheWrite: 0.00005, total: 0.00219 },
    };

    emit("message_end", { message: { role: "assistant", usage } });
    expect(readActivity()).toMatchObject({ latestEvent: "message_end", usage });

    emit("message_end", { message: { role: "user", usage: { ...usage, totalTokens: 999 } } });
    expect(readActivity()).toMatchObject({ latestEvent: "message_end", usage });
  });
});

describe("pane child completion nudge", () => {
  it("nudges after an idle agent end", () => {
    vi.useFakeTimers();
    const { pi, emit } = fixture();

    emit("agent_end");
    vi.advanceTimersByTime(4_999);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(pi.sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("subagent_done"),
      { deliverAs: "followUp" },
    );
  });

  it("cancels the pending nudge when new activity starts", () => {
    vi.useFakeTimers();
    const { pi, emit } = fixture();

    emit("agent_end");
    emit("agent_start");
    vi.advanceTimersByTime(5_000);

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });
});