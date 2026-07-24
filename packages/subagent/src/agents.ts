import { statSync } from "node:fs";
import { readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { DefaultPackageManager, getAgentDir, parseFrontmatter, SettingsManager, type PackageManager } from "@earendil-works/pi-coding-agent";
import type { SpawnRequest } from "./schema.js";
import { DEFAULT_SUBAGENT_SETTINGS, type SubagentAgentDiscoverySettings } from "./settings.js";

export const MODEL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function isModelThinkingLevel(value: unknown): value is ModelThinkingLevel {
  return typeof value === "string" && (MODEL_THINKING_LEVELS as readonly string[]).includes(value);
}

export type AgentSource = "package" | "user" | "project";

export interface AgentConfig {
  name: string;
  description: string;
  model?: string;
  thinking?: ModelThinkingLevel;
  tools?: string[];
  skills?: string[];
  systemPrompt: string;
  source: AgentSource;
  sourcePath?: string;
}

export function BuildAgentConfig(
  content: string,
  source: AgentSource,
): AgentConfig | { error: Error } {
  try {
    const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
    const result = {
      name: parseRequiredString(frontmatter.name, "name"),
      description: parseRequiredString(frontmatter.description, "description"),
      model: parseString(frontmatter.model, "model"),
      thinking: parseThinkingLevel(frontmatter.thinking),
      tools: parseCSVStrings(frontmatter.tools, "tools"),
      skills: parseCSVStrings(frontmatter.skills, "skills"),
      systemPrompt: body.trim(),
      source,
      sourcePath: undefined,
    }

    return result;
  } catch (error) {
    return { error: error as Error }
  }
}

function parseString(val: unknown, field: string): string | undefined {
  if (val == null) return undefined;
  if (typeof val === "string") return val;
  throw new Error(`Expected field "${field}" to be a string, but got ${typeof val}.`);
}

function parseRequiredString(val: unknown, field: string): string {
  const value = parseString(val, field);
  if (value === undefined || value.trim() === "") {
    throw new Error(`Expected required field "${field}" to be a non-empty string.`);
  }
  return value;
}

function parseThinkingLevel(val: unknown): ModelThinkingLevel | undefined {
  const thinking = parseString(val, "thinking");
  if (thinking === undefined || isModelThinkingLevel(thinking)) return thinking;
  throw new Error(`Expected field "thinking" to be one of: ${MODEL_THINKING_LEVELS.join(", ")}.`);
}

function parseCSVStrings(val: unknown, field: string): Array<string> | undefined {
  if (val == null) return undefined;
  if (typeof val != "string") {
    throw new Error(`Expected field "${field}" to be a string, but got ${typeof val}.`);
  }

  const trimmed = val.trim();
  if (!trimmed || trimmed == "none") return undefined;

  const items = trimmed
    .split(",")
    .map(t => t.trim())
    .filter(Boolean);

  return (items.length > 0)
    ? items
    : undefined
}

export interface AgentRegistryOptions {
  discovery?: Partial<SubagentAgentDiscoverySettings>;
  onWarning?: (message: string) => void;
  packageManager?: Pick<PackageManager, "listConfiguredPackages">;
}

export class AgentRegistry {

  private _agents = new Map<string, AgentConfig>();
  get agents(): Map<string, AgentConfig> { return this._agents }

  /**
   * Load agent configs from the following directories:
   *   - Project: <cwd>/.pi/agents/*.md
   *   - Global:  <pi-dir>/agents/*.md
   */
  async reload(cwd: string = process.cwd(), options: AgentRegistryOptions = {}): Promise<void> {
    const discovery = { ...DEFAULT_SUBAGENT_SETTINGS.agentDiscovery, ...options.discovery };
    const globalDir = discovery.includeUserAgents ? join(getAgentDir(), "agents") : undefined;
    const agents = new Map<string, AgentConfig>();
    const extensions = new Set(discovery.agentFileExtensions);
    const warn = (message: string) => { if (discovery.warnOnInvalidAgents) options.onWarning?.(message); };
    const projectDir = discovery.includeProjectAgents && discovery.projectAgentsStrategy !== "off"
      ? nearestProjectAgentsDir(cwd, warn)
      : undefined;

    async function loadAgents(dir: string | undefined, source: AgentSource, recursive = false): Promise<void> {
      if (!dir) return;
      let files: string[];
      try {
        if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return;
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

        const result = BuildAgentConfig(content, source);
        if ("error" in result) {
          warn(`Invalid subagent definition ${path}: ${result.error.message}`);
          continue;
        } else {
          agents.set(result.name, { ...result, sourcePath: path });
        }
      }
    }

    for (const packageRoot of await packageRoots(cwd, options.packageManager, warn)) {
      for (const dir of await readPackageAgentDirs(packageRoot, warn)) await loadAgents(dir, "package", true);
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

export function serializeAgentConfig(config: AgentConfig) {
  return {
    name: config.name,
    description: config.description,
    source: config.source,
    model: config.model,
    thinking: config.thinking,
    tools: config.tools,
    skills: config.skills,
    sourcePath: config.sourcePath,
  };
}

export function listAgentDefinitions(registry: AgentRegistry) {
  return Array.from(registry.agents.values()).map(serializeAgentConfig);
}

async function packageRoots(cwd: string, injected: Pick<PackageManager, "listConfiguredPackages"> | undefined, warn: (message: string) => void): Promise<string[]> {
  try {
    let manager = injected;
    if (!manager) {
      const agentDir = getAgentDir();
      const settings = SettingsManager.create(cwd, agentDir);
      await settings.reload();
      manager = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
    }
    return [...new Set(manager.listConfiguredPackages().map(pkg => pkg.installedPath).filter((path): path is string => !!path))];
  } catch (error) {
    warn(`Failed to discover Pi packages: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

async function readPackageAgentDirs(packageRoot: string, warn: (message: string) => void): Promise<string[]> {
  const manifestPath = join(packageRoot, "package.json");
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    const entries = objectValue(manifest) && objectValue((manifest as Record<string, unknown>).pi)?.agents;
    if (!Array.isArray(entries)) return [];
    const canonicalRoot = await realpath(packageRoot);
    const dirs: string[] = [];
    for (const entry of entries) {
      if (typeof entry !== "string" || !entry.trim() || isAbsolute(entry)) continue;
      try {
        const dir = resolve(packageRoot, entry);
        const canonical = await realpath(dir);
        const outside = relative(canonicalRoot, canonical);
        if (outside.startsWith("..") || isAbsolute(outside) || !statSync(canonical).isDirectory()) {
          warn(`Invalid package subagent path ${entry}; path must be a directory inside the package.`);
          continue;
        }
        dirs.push(canonical);
      } catch (error) {
        warn(`Invalid package subagent path ${entry}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return [...new Set(dirs)];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") warn(`Invalid package manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

async function listAgentFilesRecursive(dir: string, extensions: Set<string>, warn: (message: string) => void): Promise<string[]> {
  const files: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) files.push(...await listAgentFilesRecursive(path, extensions, warn));
      else if ((entry.isFile() || entry.isSymbolicLink()) && extensions.has(extname(entry.name)) && !basename(entry.name).endsWith(".chain.md")) files.push(path);
    }
  } catch (error) {
    warn(`Failed to enumerate subagent directory ${dir}: ${error instanceof Error ? error.message : String(error)}`);
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

export interface AgentRequestedConfig {
  readonly model?: string;
  readonly thinking?: ModelThinkingLevel;
  readonly skills?: readonly string[];
  readonly tools?: readonly string[];
  readonly cwd?: string;
}

/** Resolve spawn-over-definition precedence. */
export function resolveRequestedConfig(
  config: AgentConfig,
  spawn: SpawnRequest,
): AgentRequestedConfig {
  const skills = spawn.skills ?? config.skills;
  return {
    model: spawn.model ?? config.model,
    thinking: spawn.thinking ?? config.thinking,
    skills: skills !== undefined ? [...skills] : undefined,
    tools: config.tools !== undefined ? [...config.tools] : undefined,
    cwd: spawn.cwd,
  };
}
