import { readFileSync, writeFileSync } from "node:fs";
import { stripFrontmatter, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createPaneActivityRecorder } from "./pane-activity.js";

type Completion =
  | { type: "done" }
  | { type: "structured_output"; value: unknown }
  | { type: "ping"; name: string; message: string };

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function requestedSkillPrompt(pi: ExtensionAPI): string | undefined {
  const raw = process.env.PI_SUBAGENT_SKILLS;
  if (!raw) return undefined;
  let names: unknown;
  try { names = JSON.parse(raw); } catch { return fatalSkillPrompt("Invalid PI_SUBAGENT_SKILLS."); }
  if (!Array.isArray(names) || names.some(name => typeof name !== "string")) return fatalSkillPrompt("Invalid PI_SUBAGENT_SKILLS.");
  const commands = pi.getCommands();
  const blocks: string[] = [];
  for (const name of names) {
    const command = commands.find(value => value.source === "skill" && (value.name === name || value.name === `skill:${name}`));
    if (!command) return fatalSkillPrompt(`Requested skill is unavailable: ${name}`);
    try {
      const sourcePath = command.sourceInfo.path;
      const body = stripFrontmatter(readFileSync(sourcePath, "utf8")).trim();
      const baseDir = command.sourceInfo.baseDir ?? sourcePath.replace(/[\\/]?[^\\/]+$/, "");
      blocks.push(`<skill name="${escapeXml(name)}" location="${escapeXml(sourcePath)}">\nReferences are relative to ${escapeXml(baseDir)}.\n\n${body}\n</skill>`);
    } catch (error) {
      return fatalSkillPrompt(`Requested skill could not be loaded: ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return blocks.length ? blocks.join("\n\n") : undefined;
}

function fatalSkillPrompt(message: string): string {
  return `<system-reminder>Fatal subagent setup error: ${escapeXml(message)} Call caller_ping immediately with this exact setup error and do not continue the delegated task.</system-reminder>`;
}

function renderDoneCall(args: { result?: unknown }, _theme: Theme): Component {
  if (args.result === undefined) return new Text("subagent_done", 0, 0);
  let text: string;
  try { text = typeof args.result === "string" ? args.result : JSON.stringify(args.result) ?? String(args.result); }
  catch { text = String(args.result); }
  return new Text(`subagent_done: ${text}`, 0, 0);
}

export default function paneChild(pi: ExtensionAPI) {
  const completionFile = process.env.PI_SUBAGENT_COMPLETION_FILE;
  if (!completionFile) return;
  const recorder = createPaneActivityRecorder(process.env.PI_SUBAGENT_RUN_ID, process.env.PI_SUBAGENT_ACTIVITY_FILE);
  const on = pi.on.bind(pi) as (event: string, handler: (value: any) => any) => void;
  let skillPrompt: string | undefined;
  let skillsResolved = false;
  on("before_agent_start", (event: any) => {
    if (!skillsResolved) {
      skillPrompt = requestedSkillPrompt(pi);
      skillsResolved = true;
    }
    return skillPrompt ? { systemPrompt: `${event.systemPrompt ?? ""}\n\n${skillPrompt}` } : undefined;
  });
  on("session_start", () => recorder.record("session_start"));
  on("agent_start", () => recorder.record("agent_start"));
  on("agent_end", () => recorder.record("agent_end"));
  on("turn_start", event => recorder.record("turn_start", { turnIndex: event.turnIndex }));
  on("turn_end", event => recorder.record("turn_end", { turnIndex: event.turnIndex }));
  on("message_update", event => recorder.record("message_update", { messageEventType: event.assistantMessageEvent?.type }));
  on("message_end", event => {
    if (event.message.role === "assistant") recorder.record("message_end", { usage: event.message.usage });
  });
  on("tool_execution_start", event => recorder.record("tool_execution_start", { toolCallId: event.toolCallId, toolName: event.toolName }));
  on("tool_execution_end", event => recorder.record("tool_execution_end", { toolCallId: event.toolCallId, toolName: event.toolName }));
  on("session_shutdown", () => recorder.record("session_shutdown"));

  const nudgeDelay = Math.max(1000, Number.parseInt(process.env.PI_SUBAGENT_NUDGE_DELAY_MS ?? "5000", 10) || 5000);
  let nudgeTimer: ReturnType<typeof setTimeout> | undefined;
  let doneCalled = false;
  let userInputAfterAgentEnd = false;
  const clearNudge = () => {
    if (nudgeTimer) clearTimeout(nudgeTimer);
    nudgeTimer = undefined;
  };
  const scheduleNudge = () => {
    clearNudge();
    if (doneCalled || process.env.PI_SUBAGENT_NUDGE_DISABLE === "1") return;
    nudgeTimer = setTimeout(() => {
      nudgeTimer = undefined;
      if (!doneCalled && !userInputAfterAgentEnd) pi.sendUserMessage("Your task is still active. Call subagent_done when finished, or caller_ping if parent input is required.", { deliverAs: "followUp" });
    }, nudgeDelay);
  };
  on("session_start", () => { doneCalled = false; userInputAfterAgentEnd = false; clearNudge(); });
  on("input", () => { userInputAfterAgentEnd = true; clearNudge(); });
  on("before_agent_start", clearNudge);
  on("agent_start", () => { userInputAfterAgentEnd = false; clearNudge(); });
  on("agent_end", scheduleNudge);
  on("session_shutdown", clearNudge);

  let settled = false;
  const finish = (completion: Completion, ctx: { shutdown(): void }) => {
    if (settled) return;
    doneCalled = true;
    clearNudge();
    settled = true;
    recorder.record(completion.type === "ping" ? "caller_ping" : "subagent_done");
    writeFileSync(completionFile, JSON.stringify(completion));
    ctx.shutdown();
  };

  pi.registerTool({
    name: "caller_ping",
    label: "Caller Ping",
    description: "Ask the parent agent for help and finish this run.",
    parameters: Type.Object({ message: Type.String() }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      finish({ type: "ping", name: process.env.PI_SUBAGENT_CONVERSATION_ID ?? "subagent", message: params.message }, ctx);
      return { content: [{ type: "text", text: "Ping sent. Shutting down this run." }], details: {} };
    },
  });

  pi.registerTool({
    name: "subagent_done",
    label: "Subagent Done",
    description: "Call when the delegated task is complete. The last assistant message is returned to the parent unless result is provided.",
    parameters: Type.Object({ result: Type.Optional(Type.Any()) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      finish(params.result === undefined ? { type: "done" } : { type: "structured_output", value: params.result }, ctx);
      return { content: [{ type: "text", text: "Shutting down subagent run." }], details: {} };
    },
    renderCall: renderDoneCall,
  });
}