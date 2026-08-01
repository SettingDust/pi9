import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";

import { AgentRegistry } from "../../src/agents.js";

test("AgentRegistry loads package agents from standard pi.agents manifests", async () => {
  const root = await mkdtemp(join(process.cwd(), "tmp-agent-package-"));
  const packageDir = join(root, "package");
  const agentDir = join(packageDir, "agents", "nested");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(packageDir, "package.json"), JSON.stringify({ pi: { agents: ["./agents"] } }));
  await writeFile(join(agentDir, "pkg.md"), "---\nname: packaged\ndescription: from package\n---\nbody");

  try {
    const registry = new AgentRegistry();
    await registry.reload(root, { packageManager: { listConfiguredPackages: () => [{ installedPath: packageDir }] } as any });
    const agent = registry.agents.get("packaged");
    assert.equal(agent?.source, "package");
    assert.equal(agent?.systemPrompt, "body");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});