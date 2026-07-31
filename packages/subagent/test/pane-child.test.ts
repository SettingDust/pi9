import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  };
}

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