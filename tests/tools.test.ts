import assert from "node:assert/strict";
import test from "node:test";
import { registerTools } from "../src/tools.js";
import type { IcarusBridge } from "../src/bridge.js";
import type { PiApi, ToolDefinition } from "../src/types.js";

interface BridgeCall {
  name: string;
  params: Record<string, unknown>;
}

type RegisteredTool = ToolDefinition & { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> };

function setup(): {
  tools: Map<string, RegisteredTool>;
  calls: BridgeCall[];
} {
  const calls: BridgeCall[] = [];
  const bridge = {
    tool: async (name: string, params: Record<string, unknown>) => {
      calls.push({ name, params });
      return { status: "written", path: "/fabric/entry.md" };
    },
  } as unknown as IcarusBridge;
  const tools = new Map<string, RegisteredTool>();
  const pi: PiApi = {
    on() {},
    registerTool(tool) { tools.set(tool.name, tool); },
  };
  registerTools(pi, bridge, false);
  return { tools, calls };
}

test("fabric_write schema guides agents on the verification contract", () => {
  const { tools } = setup();
  const write = tools.get("fabric_write");
  assert.ok(write, "fabric_write is registered");

  const properties = (write!.parameters.properties ?? {}) as Record<string, { type?: string; enum?: string[]; description?: string }>;
  assert.deepEqual(properties.verified?.enum, ["true", "false"]);
  assert.match(properties.verified?.description ?? "", /only when you verified/i);
  assert.match(properties.evidence?.description ?? "", /how the result was verified/i);
  assert.match(properties.source_tool?.description ?? "", /tool that produced/i);
  assert.match(write!.description, /verified/i);
  assert.match(write!.description, /evidence/i);
  assert.match(write!.promptSnippet, /verified/i);
});

test("fabric_write forwards verified, evidence, and source_tool", async () => {
  const { tools, calls } = setup();
  await tools.get("fabric_write")!.execute("1", {
    type: "resolution",
    summary: "Fixed the bridge",
    content: "The bridge now normalizes verified.",
    verified: "true",
    evidence: "npm test passed",
    source_tool: "bash",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "fabric_write");
  assert.equal(calls[0].params.verified, "true");
  assert.equal(calls[0].params.evidence, "npm test passed");
  assert.equal(calls[0].params.source_tool, "bash");
});

test("fabric_write normalizes boolean and string verified values", async () => {
  const { tools, calls } = setup();
  const base = { type: "note", summary: "s", content: "c" };

  await tools.get("fabric_write")!.execute("1", { ...base, verified: true, evidence: "checked" });
  await tools.get("fabric_write")!.execute("2", { ...base, verified: "True", evidence: "checked" });
  await tools.get("fabric_write")!.execute("3", { ...base, verified: false });
  await tools.get("fabric_write")!.execute("4", { ...base, verified: "false" });

  assert.deepEqual(calls.map((call) => call.params.verified), ["true", "true", "false", "false"]);
});

test("fabric_write omits verified when it is not provided", async () => {
  const { tools, calls } = setup();
  await tools.get("fabric_write")!.execute("1", { type: "note", summary: "s", content: "c" });

  assert.equal(calls.length, 1);
  assert.equal("verified" in calls[0].params, false);
});

test("fabric_write rejects verified=true without evidence", async () => {
  const { tools, calls } = setup();
  const result = await tools.get("fabric_write")!.execute("1", {
    type: "resolution",
    summary: "s",
    content: "c",
    verified: true,
  }) as { details: { error?: string } };

  assert.equal(calls.length, 0, "nothing is written without evidence");
  assert.match(result.details.error ?? "", /requires evidence/);
});

test("fabric_write rejects ambiguous verified values instead of guessing", async () => {
  const { tools, calls } = setup();
  const result = await tools.get("fabric_write")!.execute("1", {
    type: "note",
    summary: "s",
    content: "c",
    verified: "maybe",
  }) as { details: { error?: string } };

  assert.equal(calls.length, 0);
  assert.match(result.details.error ?? "", /verified must be/);
});

test("other fabric tools stay pass-through", async () => {
  const { tools, calls } = setup();
  await tools.get("fabric_search")!.execute("1", { query: "needle" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "fabric_search");
  assert.deepEqual(calls[0].params, { query: "needle" });
});
