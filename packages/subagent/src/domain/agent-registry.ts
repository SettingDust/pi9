import { statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { AgentConfig, AgentSource, BuildAgentConfig } from "./agent-config.js";
import { DEFAULT_SUBAGENT_SETTINGS, type SubagentAgentDiscoverySettings } from "../config/settings.js";

export interface AgentRegistryOptions {
  discovery?: Partial<SubagentAgentDiscoverySettings>;
  defaultRetainConversation?: boolean;
  packageRoots?: string[];
  onWarning?: (message: string) => void;
}

export class AgentRegistry {

  private _agents = new Map<string, AgentConfig>();
  get agents(): Map<string, AgentConfig> { return this._agents }

  /**
   * Load agent configs from installed Pi packages, the user agent directory, and
   * the nearest project agent directory.
   */
  async reload(cwd: string = process.cwd(), options: AgentRegistryOptions = {}): Promise<void> {
    const discovery = { ...DEFAULT_SUBAGENT_SETTINGS.agentDiscovery, ...options.discovery };
    const globalDir = discovery.includeUserAgents ? join(getAgentDir(), "agents") : undefined;
    const agents = new Map<string, AgentConfig>();
    const extensions = new Set(discovery.agentFileExtensions);
    const warn = (message: string) => {
      if (discovery.warnOnInvalidAgents) options.onWarning?.(message);
    };
    const projectDir = discovery.includeProjectAgents && discovery.projectAgentsStrategy !== "off"
      ? nearestProjectAgentsDir(cwd, warn)
      : undefined;

    async function loadAgents(dir: string | undefined, source: AgentSource, recursive = false): Promise<void> {
      if (!dir) return;
      try {
        if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return;
      } catch (error) {
        warn(`Failed to inspect subagent directory ${dir}: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }

      let files: string[];
      try {
        files = recursive
          ? await listAgentFilesRecursive(dir, extensions, warn)
          : (await readdir(dir)).filter(file => extensions.has(extname(file))).map(file => join(dir, file));
      } catch (error) {
        warn(`Failed to enumerate subagent directory ${dir}: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }

      for (const path of files) {
        let content: string;

        try {
          content = await readFile(path, { encoding: "utf-8" });
        } catch (error) {
          warn(`Failed to read subagent definition ${path}: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }

        const result = BuildAgentConfig(content, source, { defaultRetainConversation: options.defaultRetainConversation });
        if ("error" in result) {
          warn(`Invalid subagent definition ${path}: ${result.error.message}`);
          continue;
        }
        agents.set(result.name, { ...result, sourcePath: path });
      }
    }

    for (const packageRoot of options.packageRoots ?? []) {
      for (const dir of await readPackageAgentDirs(packageRoot, warn)) {
        await loadAgents(dir, "package", true);
      }
    }

    const loadOrder: Array<[string | undefined, AgentSource]> = discovery.duplicateNamePolicy === "userOverridesProject"
      ? [[projectDir, "project"], [globalDir, "user"]]
      : [[globalDir, "user"], [projectDir, "project"]];
    for (const [dir, source] of loadOrder) await loadAgents(dir, source);
    this._agents = agents;
  }

  summarizeAgent(): string {
    return Array.from(this.agents.values())
      .map(agent => `${agent.name} (${agent.source}) — ${agent.description}`).join("\n");
  }
}

async function readPackageAgentDirs(packageRoot: string, warn: (message: string) => void): Promise<string[]> {
  const manifestPath = join(packageRoot, "package.json");
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      warn(`Invalid package manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return [];
  }

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return [];
  const agents = objectValue((manifest as Record<string, unknown>).pi)?.agents;
  if (!Array.isArray(agents)) return [];

  const dirs: string[] = [];
  for (const entry of agents) {
    if (typeof entry !== "string" || !entry.trim()) continue;
    try {
      const dir = resolve(packageRoot, entry);
      if (statSync(dir, { throwIfNoEntry: false })?.isDirectory()) dirs.push(dir);
      else warn(`Invalid package subagent path ${dir}; expected a directory.`);
    } catch (error) {
      warn(`Invalid package subagent path ${entry}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return [...new Set(dirs)];
}

async function listAgentFilesRecursive(dir: string, extensions: Set<string>, warn: (message: string) => void): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    warn(`Failed to enumerate subagent directory ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    return files;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listAgentFilesRecursive(path, extensions, warn));
    else if ((entry.isFile() || entry.isSymbolicLink()) && extensions.has(extname(entry.name)) && !basename(entry.name).endsWith(".chain.md")) files.push(path);
  }
  return files;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function nearestProjectAgentsDir(cwd: string, warn: (message: string) => void): string | undefined {
  let dir = cwd;
  while (true) {
    const candidate = join(dir, ".pi", "agents");
    try {
      if (statSync(candidate, { throwIfNoEntry: false })?.isDirectory()) return candidate;
    } catch (error) {
      warn(`Failed to inspect subagent directory ${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
