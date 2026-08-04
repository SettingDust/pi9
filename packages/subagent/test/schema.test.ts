import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createSubagentParamsSchema, parseSubagentInvocation } from "../src/schema.js";

const id = "airy-acorn";
const valid: Record<string, Record<string, unknown>> = {
  agents: { action: "agents" },
  list: { action: "list" },
  spawn: { action: "spawn", spawns: [{ agent: "helper", prompt: "work", label: "Worker" }] },
  resume: { action: "resume", resumes: [{ subagentId: id, prompt: "continue" }] },
  steer: { action: "steer", messages: [{ subagentId: id, message: "adjust" }] },
  cancel: { action: "cancel", subagentIds: [id] },
  inspect: { action: "inspect", subagentIds: [id] },
  join: { action: "join", subagentIds: [id] },
  remove: { action: "remove", subagentIds: [id] },
};

const text = (value: unknown) => JSON.stringify(value);
const requestSchema = (schema: any) => schema.properties.request;
const spawnBranch = (schema: any) => requestSchema(schema).anyOf.find((branch: any) => branch.properties?.action?.enum?.includes("spawn"));

describe("parseSubagentInvocation", () => {
  for (const [action, invocation] of Object.entries(valid)) {
    it(`parses a minimal ${action} invocation`, () => {
      assert.equal((parseSubagentInvocation(invocation) as any).action, action);
      assert.doesNotMatch(text(parseSubagentInvocation(invocation)), /error/);
    });

    it(`rejects an extra property for ${action}`, () => {
      assert.match(text(parseSubagentInvocation({ ...invocation, extra: true })), /Property extra is not allowed/);
    });
  }

  it("rejects a missing or unknown action", () => {
    assert.match(text(parseSubagentInvocation({})), /Provide an action/);
    assert.match(text(parseSubagentInvocation({ action: "explode" })), /Unknown action/);
  });

  it("rejects a spawn task without a label", () => {
    const result = parseSubagentInvocation({ action: "spawn", spawns: [{ agent: "helper", prompt: "work" }] });
    assert.match(text(result), /label must be a non-empty string/);
  });

  it("wraps the strict action union in an ordinary root object", () => {
    const schema: any = createSubagentParamsSchema();
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ["request"]);
    assert.equal("anyOf" in schema, false);
    assert.equal(requestSchema(schema).anyOf.length, 9);
    assert.ok(requestSchema(schema).anyOf.every((branch: any) => branch.additionalProperties === false));
  });

  it("uses required nullable properties for strict provider schemas", () => {
    const schema: any = createSubagentParamsSchema();
    const visit = (node: any): void => {
      if (node?.type === "object") {
        assert.deepEqual(node.required, Object.keys(node.properties ?? {}));
        for (const property of Object.values(node.properties ?? {})) visit(property);
      }
      for (const branch of node?.anyOf ?? []) visit(branch);
      if (node?.items) visit(node.items);
    };
    visit(schema);
    const list = requestSchema(schema).anyOf.find((branch: any) => branch.properties.action.enum.includes("list"));
    assert.equal(list.properties.joined.anyOf.some((branch: any) => branch.type === "null"), true);
    assert.equal(list.properties.statuses.anyOf.some((branch: any) => branch.type === "null"), true);
    assert.equal("minItems" in list.properties.statuses.anyOf.find((branch: any) => branch.type === "array"), false);
  });

  it("exposes dynamic agent and model enums for spawn", () => {
    const schema: any = createSubagentParamsSchema({ agentNames: ["handler", "reviewer"], modelIds: ["provider/alpha", "provider/beta"] });
    const spawn = spawnBranch(schema).properties.spawns.items;
    assert.deepEqual(spawn.properties.agent.enum, ["handler", "reviewer"]);
    assert.deepEqual(spawn.properties.model.anyOf.find((branch: any) => branch.enum)?.enum, ["provider/alpha", "provider/beta"]);

    const fallback: any = createSubagentParamsSchema();
    assert.equal(spawnBranch(fallback).properties.spawns.items.properties.agent.type, "string");
    assert.equal(spawnBranch(fallback).properties.spawns.items.properties.model.anyOf.find((branch: any) => branch.type === "string").type, "string");
  });

  for (const action of ["join", "cancel"] as const) {
    it(`reports duplicate subagentIds in ${action}`, () => {
      assert.match(text(parseSubagentInvocation({ action, subagentIds: [id, id] })), /Duplicate subagentId/);
    });
  }

  it("reports duplicate subagentIds in resume", () => {
    assert.match(text(parseSubagentInvocation({ action: "resume", resumes: [
      { subagentId: id, prompt: "one" }, { subagentId: id, prompt: "two" },
    ] })), /Duplicate subagentId/);
  });

  it("reports duplicate subagentIds in steer", () => {
    assert.match(text(parseSubagentInvocation({ action: "steer", messages: [
      { subagentId: id, message: "one" }, { subagentId: id, message: "two" },
    ] })), /Duplicate subagentId/);
  });

  it("distinguishes malformed and unknown plausible IDs", () => {
    assert.match(text(parseSubagentInvocation({ action: "join", subagentIds: ["Not-An-Id!"] })), /Invalid subagentId format/);
    assert.match(text(parseSubagentInvocation({ action: "join", subagentIds: ["hello-world"] })), /was not found/);
  });

  it("enforces maxTasks", () => {
    const invocation = { action: "spawn", spawns: [
      { agent: "helper", prompt: "one", label: "One" },
      { agent: "helper", prompt: "two", label: "Two" },
    ] };
    assert.match(text(parseSubagentInvocation(invocation, { maxTasks: 1 })), /Too many tasks/);
  });
});
