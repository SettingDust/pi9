import { afterEach, describe, expect, it, vi } from "vitest";
import paneChild from "../src/pane-child.js";

const originalEnv = { ...process.env };

afterEach(() => {
  vi.useRealTimers();
  process.env = { ...originalEnv };
});

function fixture() {
  const handlers = new Map<string, Array<(event?: any, ctx?: any) => void>>();
  const tools = new Map<string, any>();
  const pi = {
    on: vi.fn((event: string, handler: (value?: any, ctx?: any) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    sendUserMessage: vi.fn(),
  };
  process.env.PI_SUBAGENT_COMPLETION_FILE = "completion.exit";
  paneChild(pi as any);
  const emit = (event: string, value: any = {}) => {
    for (const handler of handlers.get(event) ?? []) handler(value, {});
  };
  return { pi, tools, emit };
}

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