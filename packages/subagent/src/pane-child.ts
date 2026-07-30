import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createPaneActivityRecorder } from "./pane-activity.js";

type Completion =
  | { type: "done" }
  | { type: "structured_output"; value: unknown }
  | { type: "ping"; name: string; message: string };

export default function paneChild(pi: ExtensionAPI) {
  const completionFile = process.env.PI_SUBAGENT_COMPLETION_FILE;
  if (!completionFile) return;
  const recorder = createPaneActivityRecorder(process.env.PI_SUBAGENT_RUN_ID, process.env.PI_SUBAGENT_ACTIVITY_FILE);
  const on = pi.on.bind(pi) as (event: string, handler: (value: any) => void) => void;
  on("session_start", () => recorder.record("session_start"));
  on("agent_start", () => recorder.record("agent_start"));
  on("agent_end", () => recorder.record("agent_end"));
  on("turn_start", event => recorder.record("turn_start", { turnIndex: event.turnIndex }));
  on("turn_end", event => recorder.record("turn_end", { turnIndex: event.turnIndex }));
  on("message_update", event => recorder.record("message_update", { messageEventType: event.assistantMessageEvent?.type }));
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
      if (!doneCalled && !userInputAfterAgentEnd) {
        pi.sendUserMessage("Your task is still active. Call subagent_done when finished, or caller_ping if parent input is required.", { deliverAs: "followUp" });
      }
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
  });
}