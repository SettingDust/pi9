import { expect, test, vi } from "vitest";
import { SubagentSettingsComponent } from "../../src/command/settings.js";
import {
  createDefaultSubagentSettings,
  DEFAULT_SUBAGENT_SETTINGS,
  normalizeSettings,
} from "../../src/settings.js";

test("widget preview dims the editor bars without dimming its placeholder", () => {
  const theme = {
    fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  } as any;
  const component = new SubagentSettingsComponent(
    DEFAULT_SUBAGENT_SETTINGS,
    theme,
    undefined,
    vi.fn(),
    vi.fn(),
  );

  const rendered = component.render(200).join("\n");
  expect(rendered).toContain("<dim>│</dim> <text>Ask Pi anything…</text>       <dim>│</dim>");
  expect(rendered).not.toContain("<text>│ Ask Pi anything…       │</text>");
});


test("recovered conversation settings default and validation", () => {
  expect(createDefaultSubagentSettings().runtime.maxRecoveredConversations).toBe(20);
  expect(normalizeSettings({ runtime: { maxRecoveredConversations: 7 } }).settings.runtime.maxRecoveredConversations).toBe(7);

  for (const maxRecoveredConversations of [0, 1.5]) {
    const result = normalizeSettings({ runtime: { maxRecoveredConversations } });
    expect(result.settings.runtime.maxRecoveredConversations).toBe(20);
    expect(result.warning).toContain("maxRecoveredConversations");
  }
});
