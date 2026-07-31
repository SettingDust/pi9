import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";

export type PaneActivityEvent =
  | "session_start" | "agent_start" | "agent_end" | "turn_start" | "turn_end"
  | "message_update" | "message_end" | "tool_execution_start" | "tool_execution_end" | "caller_ping" | "subagent_done" | "session_shutdown";

export interface PaneActivityState {
  version: 1;
  runningChildId: string;
  sequence: number;
  updatedAt: number;
  latestEvent: PaneActivityEvent;
  phase: "starting" | "active" | "waiting" | "done";
  turnIndex?: number;
  messageEventType?: string;
  usage?: Usage;
  toolCallId?: string;
  toolName?: string;
  toolStartedAt?: number;
  toolEndedAt?: number;
}

export function readPaneActivity(file: string, runningChildId: string): PaneActivityState | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<PaneActivityState>;
    if (value.version !== 1 || value.runningChildId !== runningChildId || !Number.isInteger(value.sequence)
      || typeof value.updatedAt !== "number" || typeof value.latestEvent !== "string" || typeof value.phase !== "string") return undefined;
    return value as PaneActivityState;
  } catch {
    return undefined;
  }
}

export function createPaneActivityRecorder(runningChildId: string | undefined, file: string | undefined, now = Date.now) {
  if (!runningChildId || !file) return { record(_event: PaneActivityEvent, _fields?: Partial<PaneActivityState>) {} };
  const state: PaneActivityState = { version: 1, runningChildId, sequence: 0, updatedAt: now(), latestEvent: "session_start", phase: "starting" };

  return {
    record(event: PaneActivityEvent, fields: Partial<PaneActivityState> = {}) {
      state.sequence += 1;
      state.updatedAt = now();
      state.latestEvent = event;
      Object.assign(state, fields);
      if (event === "agent_start" || event === "turn_start" || event === "message_update" || event === "tool_execution_start") state.phase = "active";
      if (event === "agent_end") state.phase = "waiting";
      if (event === "caller_ping" || event === "subagent_done" || event === "session_shutdown") state.phase = "done";
      if (event === "tool_execution_start") {
        state.toolStartedAt = state.updatedAt;
        delete state.toolEndedAt;
      }
      if (event === "tool_execution_end") state.toolEndedAt = state.updatedAt;

      const dir = dirname(file);
      const temp = join(dir, `${runningChildId}.${process.pid}.${state.sequence}.tmp`);
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          mkdirSync(dir, { recursive: true });
          writeFileSync(temp, `${JSON.stringify(state)}\n`, "utf8");
          renameSync(temp, file);
          return;
        } catch {
          try { unlinkSync(temp); } catch {}
        }
      }
    },
  };
}