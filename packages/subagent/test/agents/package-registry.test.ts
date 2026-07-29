import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { AgentRegistry } from "../../src/agents.js";

async function agent(dir: string, name: string, description = name) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.md`), `---\nname: ${name}\ndescription: ${description}\n---\n${description}`);
}

function packages(...installedPath: string[]) {
  return { listConfiguredPackages: () => installedPath.map((path, index) => ({ source: `pkg-${index}`, scope: "user" as const, filtered: false, installedPath: path })) };
}

test("discovers only standard pi.agents recursively and keeps project precedence", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-package-registry-"));
  const standard = join(root, "standard");
  const legacy = join(root, "legacy");
  const nested = join(root, "nested");
  await agent(join(standard, "agents", "deep"), "same", "Package");
  await writeFile(join(standard, "package.json"), JSON.stringify({ pi: { agents: ["./agents"] } }));
  await agent(join(legacy, "agents"), "legacy");
  await writeFile(join(legacy, "package.json"), JSON.stringify({ "pi-subagents": { agents: ["./agents"] } }));
  await agent(join(nested, "agents"), "nested");
  await writeFile(join(nested, "package.json"), JSON.stringify({ pi: { subagents: { agents: ["./agents"] } } }));
  await agent(join(root, ".pi", "agents"), "same", "Project");

  const registry = new AgentRegistry();
  await registry.reload(root, { discovery: { includeUserAgents: false }, packageManager: packages(standard, legacy, nested) });

  assert.equal(registry.agents.get("same")?.source, "project");
  assert.equal(registry.agents.get("same")?.systemPrompt, "Project");
  assert.equal(registry.agents.has("legacy"), false);
  assert.equal(registry.agents.has("nested"), false);
});

test("isolates invalid manifests, missing and escaping paths, and directory errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-package-errors-"));
  const valid = join(root, "valid");
  const invalid = join(root, "invalid");
  await agent(join(valid, "agents"), "valid");
  await writeFile(join(valid, "package.json"), JSON.stringify({ pi: { agents: ["./missing", "../outside", "./agents"] } }));
  await mkdir(invalid);
  await writeFile(join(invalid, "package.json"), "{");
  const warnings: string[] = [];
  const registry = new AgentRegistry();
  await registry.reload(root, {
    discovery: { includeUserAgents: false, includeProjectAgents: false, warnOnInvalidAgents: true },
    packageManager: packages(invalid, join(root, "missing-package"), valid),
    onWarning: warning => warnings.push(warning),
  });
  assert.equal(registry.agents.get("valid")?.source, "package");
  assert.ok(warnings.some(warning => warning.includes("Invalid package manifest")));
  assert.ok(warnings.some(warning => warning.includes("Invalid package subagent path")));
});

test("does not follow package agent symlink files outside the declared directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-package-symlink-"));
  const packageRoot = join(root, "package");
  const agents = join(packageRoot, "agents");
  await mkdir(agents, { recursive: true });
  const outside = join(root, "outside.md");
  await writeFile(outside, "---\nname: escaped\ndescription: Escaped\n---\nEscaped");
  await symlink(outside, join(agents, "escaped.md"));
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ pi: { agents: ["./agents"] } }));

  const registry = new AgentRegistry();
  await registry.reload(root, {
    discovery: { includeUserAgents: false, includeProjectAgents: false },
    packageManager: packages(packageRoot),
  });
  assert.equal(registry.agents.has("escaped"), false);
});

test("isolates package-manager failure from project discovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-package-manager-error-"));
  await agent(join(root, ".pi", "agents"), "project");
  const warnings: string[] = [];
  const registry = new AgentRegistry();
  await registry.reload(root, {
    discovery: { includeUserAgents: false, warnOnInvalidAgents: true },
    packageManager: { listConfiguredPackages: () => { throw new Error("manager failed"); } },
    onWarning: warning => warnings.push(warning),
  });
  assert.equal(registry.agents.get("project")?.source, "project");
  assert.ok(warnings.some(warning => warning.includes("manager failed")));
});
