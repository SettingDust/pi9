import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentRegistry } from "../../src/domain/agent-registry.js";

test("registry honors discovery options and default retainConversation", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-registry-config-"));
  const projectAgents = join(root, ".pi", "agents");
  await mkdir(projectAgents, { recursive: true });
  await writeFile(join(projectAgents, "helper.md"), `---\nname: helper\ndescription: Helps\n---\nHelp prompt`);

  const disabled = new AgentRegistry();
  await disabled.reload(root, { discovery: { includeProjectAgents: false, includeUserAgents: false } });
  assert.equal(disabled.agents.has("helper"), false);

  const enabled = new AgentRegistry();
  await enabled.reload(root, { discovery: { includeUserAgents: false }, defaultRetainConversation: true });
  assert.equal(enabled.agents.get("helper")?.retainConversation, true);
});

test("registry skips invalid descriptions and only warns when configured", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-registry-description-"));
  const projectAgents = join(root, ".pi", "agents");
  await mkdir(projectAgents, { recursive: true });
  await writeFile(join(projectAgents, "invalid.md"), `---\nname: invalid\ndescription: "   "\n---\nPrompt`);

  const silentWarnings: string[] = [];
  const silent = new AgentRegistry();
  await silent.reload(root, { discovery: { includeUserAgents: false }, onWarning: warning => silentWarnings.push(warning) });
  assert.equal(silent.agents.has("invalid"), false);
  assert.deepEqual(silentWarnings, []);

  const warnings: string[] = [];
  const warning = new AgentRegistry();
  await warning.reload(root, {
    discovery: { warnOnInvalidAgents: true, includeUserAgents: false },
    onWarning: message => warnings.push(message),
  });
  assert.equal(warning.agents.has("invalid"), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Invalid subagent definition.*Expected required field "description"/);
});

test("registry skips invalid thinking levels and warns through the configured channel", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-registry-thinking-"));
  const projectAgents = join(root, ".pi", "agents");
  await mkdir(projectAgents, { recursive: true });
  await writeFile(join(projectAgents, "invalid.md"), `---\nname: invalid\ndescription: Invalid thinking\nthinking: extreme\n---\nPrompt`);

  const warnings: string[] = [];
  const registry = new AgentRegistry();
  await registry.reload(root, {
    discovery: { warnOnInvalidAgents: true, includeUserAgents: false },
    onWarning: message => warnings.push(message),
  });

  assert.equal(registry.agents.has("invalid"), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Invalid subagent definition.*Expected field "thinking" to be one of/);
});

test("registry loads markdown files from ctx cwd project dir and keys by frontmatter name", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-registry-"));
  const projectAgents = join(root, ".pi", "agents");
  await mkdir(projectAgents, { recursive: true });
  await writeFile(
    join(projectAgents, "filename.md"),
    `---\nname: runtime-name\ndescription: Runtime description\nretainConversation: true\n---\nSystem prompt`,
  );

  const registry = new AgentRegistry();
  await registry.reload(root, { discovery: { includeUserAgents: false } });

  assert.equal(registry.agents.has("filename"), false);
  assert.equal(registry.agents.get("runtime-name")?.systemPrompt, "System prompt");
  assert.equal(registry.agents.get("runtime-name")?.retainConversation, true);
});


test("registry discovers package agents from both supported manifest shapes recursively", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-registry-packages-"));
  const legacyPackage = join(root, "legacy-package");
  const piPackage = join(root, "pi-package");
  await mkdir(join(legacyPackage, "agents", "nested"), { recursive: true });
  await mkdir(join(piPackage, "defs", "nested"), { recursive: true });
  await writeFile(join(legacyPackage, "package.json"), JSON.stringify({ "pi-subagents": { agents: ["./agents"] } }));
  await writeFile(join(piPackage, "package.json"), JSON.stringify({ pi: { subagents: { agents: ["./defs"] } } }));
  await writeFile(join(legacyPackage, "agents", "nested", "package-agent.md"), "---\nname: package-agent\ndescription: Package agent\n---\nPackage prompt");
  await writeFile(join(piPackage, "defs", "nested", "pi-agent.md"), "---\nname: pi-agent\ndescription: Pi package agent\n---\nPi prompt");
  await writeFile(join(piPackage, "defs", "ignored.chain.md"), "---\nname: chain\ndescription: Not an agent\n---\nChain");

  const registry = new AgentRegistry();
  await registry.reload(root, { packageRoots: [legacyPackage, piPackage], discovery: { includeUserAgents: false } });

  assert.equal(registry.agents.get("package-agent")?.source, "package");
  assert.equal(registry.agents.get("pi-agent")?.source, "package");
  assert.equal(registry.agents.has("chain"), false);
});

test("registry skips uninspectable package paths without hiding valid agents", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-registry-package-path-"));
  const packageRoot = join(root, "package");
  await mkdir(join(packageRoot, "agents"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    "pi-subagents": { agents: ["invalid\0path", "./agents"] },
  }));
  await writeFile(join(packageRoot, "agents", "valid.md"), "---\nname: valid\ndescription: Valid\n---\nValid");

  const warnings: string[] = [];
  const registry = new AgentRegistry();
  await registry.reload(root, {
    packageRoots: [packageRoot],
    discovery: { includeUserAgents: false, warnOnInvalidAgents: true },
    onWarning: message => warnings.push(message),
  });

  assert.equal(registry.agents.get("valid")?.source, "package");
  assert.ok(warnings.some(message => message.includes("Invalid package subagent path")));
});

test("registry ignores invalid package declarations and preserves higher-precedence agents", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-registry-package-invalid-"));
  const packageRoot = join(root, "package");
  const projectAgents = join(root, ".pi", "agents");
  await mkdir(join(packageRoot, "agents"), { recursive: true });
  await mkdir(projectAgents, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    "pi-subagents": { agents: ["./missing", 4] },
    pi: { subagents: { agents: ["./agents"] } },
  }));
  await writeFile(join(packageRoot, "agents", "same.md"), "---\nname: same\ndescription: Package\n---\nPackage");
  await writeFile(join(projectAgents, "same.md"), "---\nname: same\ndescription: Project\n---\nProject");

  const warnings: string[] = [];
  const registry = new AgentRegistry();
  await registry.reload(root, {
    packageRoots: [packageRoot, join(root, "missing-package")],
    discovery: { includeUserAgents: false, warnOnInvalidAgents: true },
    onWarning: message => warnings.push(message),
  });

  assert.equal(registry.agents.get("same")?.source, "project");
  assert.equal(registry.agents.get("same")?.systemPrompt, "Project");
  assert.ok(warnings.some(message => message.includes("Invalid package subagent path")));
});


test("registry skips an uninspectable project directory without hiding package agents", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-registry-directory-error-"));
  const packageRoot = join(root, "package");
  await mkdir(join(packageRoot, "agents"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ "pi-subagents": { agents: ["./agents"] } }));
  await writeFile(join(packageRoot, "agents", "valid.md"), "---\nname: valid\ndescription: Valid\n---\nValid");

  const warnings: string[] = [];
  const registry = new AgentRegistry();
  await registry.reload("invalid\0cwd", {
    packageRoots: [packageRoot],
    discovery: { includeUserAgents: false, warnOnInvalidAgents: true },
    onWarning: message => warnings.push(message),
  });

  assert.equal(registry.agents.get("valid")?.source, "package");
  assert.ok(warnings.some(message => message.includes("Failed to inspect subagent directory")));
});
