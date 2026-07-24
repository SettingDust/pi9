import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SUBAGENT_SETTINGS } from "../../src/settings.js";
import { SubagentOverlayComponent, type OverlayOptions } from "../../src/command/overlay.js";
import { fakeAgent, fakeRunSection } from "../helpers/fake-agent.js";

function overlay(conversations: any[], overrides: Partial<OverlayOptions> = {}, terminal?: { rows: number }) {
  let listener: (() => void) | undefined;
  const unsubscribe = vi.fn();
  const requestRender = vi.fn();
  const callbacks = {
    notify: vi.fn(),
    onStart: vi.fn(),
    onResume: vi.fn(),
    onRemove: vi.fn(),
    onSettingsChange: vi.fn(),
  };
  const manager = {
    listConversations: () => conversations,
    onConversationUpdate: (next: () => void) => { listener = next; return unsubscribe; },
  };
  const component = new SubagentOverlayComponent(
    manager as any,
    { requestRender, terminal } as any,
    {} as any,
    undefined,
    vi.fn(),
    {
      initialPage: "conversations",
      agents: [{ name: "worker", description: "Works", source: "project" } as any],
      settings: DEFAULT_SUBAGENT_SETTINGS,
      ...callbacks,
      ...overrides,
    },
  );
  component.focused = true;
  return { component, callbacks, requestRender, unsubscribe, update: () => listener?.() };
}

describe("subagent overlay behavior", () => {
  it("starts an agent from the agent page", () => {
    const { component, callbacks } = overlay([], { initialPage: "agents" });

    component.handleInput("\r");
    component.handleInput("do work");
    component.handleInput("\r");

    expect(callbacks.onStart).toHaveBeenCalledWith("worker", "do work");
  });

  it("keeps the selected conversation stable while the catalog reorders", () => {
    const first = fakeAgent({ conversationId: "conversation-1", canResume: true });
    const second = fakeAgent({ conversationId: "conversation-2", canResume: true });
    const conversations = [first, second];
    const { component, callbacks } = overlay(conversations);

    component.handleInput("\x1b[B");
    conversations.reverse();
    component.handleInput("r");
    component.handleInput("follow up");
    component.handleInput("\r");

    expect(callbacks.onResume).toHaveBeenCalledWith("conversation-2", "follow up");
  });

  it("does not resume active or non-resumable conversations", () => {
    for (const conversation of [
      fakeAgent({ status: { kind: "running" }, canResume: true }),
      fakeAgent({ status: { kind: "completed" }, canResume: false }),
    ]) {
      const { component, callbacks } = overlay([conversation]);
      component.handleInput("r");
      component.handleInput("prompt");
      component.handleInput("\r");
      expect(callbacks.onResume).not.toHaveBeenCalled();
    }
  });

  it("removes the selected conversation", () => {
    const { component, callbacks } = overlay([fakeAgent({ conversationId: "conversation-1" })]);
    component.handleInput("x");
    expect(callbacks.onRemove).toHaveBeenCalledWith("conversation-1");
  });

  it("rerenders on manager updates and unsubscribes on disposal", () => {
    const { component, requestRender, unsubscribe, update } = overlay([]);
    update();
    expect(requestRender).toHaveBeenCalled();
    component.dispose();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("renders wide and narrow views without throwing", () => {
    const { component } = overlay([fakeAgent()]);
    expect(() => component.render(120)).not.toThrow();
    expect(() => component.render(56)).not.toThrow();
  });

  it("renders conversation chronology with compact previous-run statistics", () => {
    const previous = fakeRunSection({
      runId: "scan-deeply",
      prompt: "Initial risk scan",
      turns: 3,
      compactions: 1,
      activeTools: ["read", "grep", "read", "grep", "read"],
    });
    const conversation = fakeAgent({
      conversationId: "amber-fox",
      runId: "inspect-carefully",
      label: "risk review",
      prompt: "Review session handling.",
      turns: 4,
      activeTools: ["read", "grep"],
      previousRuns: [previous],
      status: { kind: "completed", response: "Final findings." },
    });
    const { component } = overlay([conversation]);
    const output = component.render(120).map(line => line.trimEnd()).join("\n");

    expect(output).toContain("Previous runs");
    expect(output).toContain("risk review · scan-deeply · completed · 3 turns · 5 tools");
    expect(output).not.toContain("run scan-deeply");
    expect(output).not.toContain("spawn · completed");
    expect(output.indexOf("Previous runs")).toBeLessThan(output.indexOf("Current prompt"));
    expect(output.indexOf("Current prompt")).toBeLessThan(output.indexOf("Activity"));
    expect(output.indexOf("Activity")).toBeLessThan(output.indexOf("Final output"));
    expect(output).toContain("Final findings.");
  });

  it("opens earlier completed and failed runs with their real outcome", () => {
    const completed = fakeRunSection({ runId: "old-complete", prompt: "Earlier prompt", status: { kind: "completed", response: "Earlier final output" } });
    const failed = fakeRunSection({ runId: "old-failed", prompt: "Failed prompt", status: { kind: "interrupted", error: "Connection interrupted" } });
    const conversation = fakeAgent({ runId: "current", previousRuns: [completed, failed], status: { kind: "running" } });
    const { component } = overlay([conversation]);

    component.handleInput("\r");
    component.handleInput("\x1b[A");
    let output = component.render(120).join("\n");
    expect(output).toContain("old-failed");
    expect(output).toContain("Activity · interrupted");
    expect(output).toContain("Connection interrupted");
    expect(output).toContain("◆ Error");

    component.handleInput("\x1b[A");
    output = component.render(120).join("\n");
    expect(output).toContain("old-complete");
    expect(output).toContain("Activity · completed");
    expect(output).toContain("Earlier final output");
    expect(output).toContain("◆ Final output");
  });

  it("scrolls overflowing earlier-run detail and clamps safely after resize", () => {
    const terminal = { rows: 20 };
    const output = Array.from({ length: 40 }, (_, index) => `chronology-line-${index}`).join("\n");
    const previous = fakeRunSection({ runId: "older", prompt: "Older prompt", status: { kind: "interrupted", error: output } });
    const conversation = fakeAgent({ previousRuns: [previous], status: { kind: "completed", response: "latest" } });
    const { component } = overlay([conversation], {}, terminal);
    component.handleInput("\r");
    component.handleInput("\x1b[A");

    const first = component.render(120).join("\n");
    expect(first).toContain("Older prompt");
    expect(first).not.toContain("chronology-line-39");

    component.handleInput("\x1b[6~");
    const scrolled = component.render(120).join("\n");
    expect(scrolled).not.toContain("Older prompt");
    expect(scrolled).toContain("chronology-line-");

    terminal.rows = 60;
    expect(() => component.render(56)).not.toThrow();
    component.handleInput("\x1b[H");
    expect(component.render(56).join("\n")).toContain("Older prompt");
  });

  it("renders unlabelled, unindented agent instructions below metadata", () => {
    const agent = {
      name: "scout",
      description: "A long agent description that should wrap naturally instead of being indented as subordinate metadata.",
      source: "project",
      model: "anthropic/sonnet",
      thinking: "medium",
      tools: ["read", "grep"],
      systemPrompt: "Inspect the repository without modifying files.\n\nReturn evidence-backed findings.",
    } as any;
    const { component } = overlay([], { initialPage: "agents", agents: [agent] });
    const output = component.render(120).map(line => line.trimEnd()).join("\n");

    expect(output).not.toContain("Instructions");
    expect(output).toContain("model anthropic/sonnet · thinking medium");
    expect(output).toContain("│  Inspect the repository without modifying files.");
    expect(output).toContain("Return evidence-backed findings.");
  });
});
