import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { loadSubagentSettings, type SubagentSettingsLoadContext } from "../config/load-settings.js";
import type { SubagentSettings, SubagentSettingsStore, SubagentAgentDiscoverySettings } from "../config/settings.js";
import { discoverInstalledPackageRoots } from "./extension-paths.js";

export interface PrepareSubagentRuntimeContext extends SubagentSettingsLoadContext {
  cwd: string;
}

export interface PrepareSubagentRuntimeAgentManager {
  configure?(options: { maxRunning?: number }): void;
}

export interface PrepareSubagentRuntimeAgentRegistry {
  reload(cwd: string, options: {
    discovery?: Partial<SubagentAgentDiscoverySettings>;
    defaultRetainConversation?: boolean;
    packageRoots?: string[];
    onWarning?: (message: string) => void;
  }): Promise<void>;
}

export interface PrepareSubagentRuntimeOptions {
  ctx: PrepareSubagentRuntimeContext;
  settingsStore: Pick<SubagentSettingsStore, "load">;
  agentManager: PrepareSubagentRuntimeAgentManager;
  agentRegistry?: PrepareSubagentRuntimeAgentRegistry;
  discoverPackageRoots?: (cwd: string, agentDir: string) => Promise<string[]>;
}

export async function prepareSubagentRuntime({
  ctx,
  settingsStore,
  agentManager,
  agentRegistry,
  discoverPackageRoots = discoverInstalledPackageRoots,
}: PrepareSubagentRuntimeOptions): Promise<SubagentSettings> {
  const settings = await loadSubagentSettings(ctx, settingsStore);
  agentManager.configure?.({ maxRunning: settings.runtime.maxConcurrentSubagents });
  if (agentRegistry) {
    const onWarning = (message: string) => ctx.ui?.notify?.(message, "warning");
    const packageRoots = await discoverPackageRoots(ctx.cwd, getAgentDir()).catch(error => {
      onWarning(`Failed to discover installed package agents: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    });
    await agentRegistry.reload(ctx.cwd, {
      discovery: settings.agentDiscovery,
      defaultRetainConversation: settings.runtime.defaultRetainConversation,
      packageRoots,
      onWarning,
    });
  }
  return settings;
}
