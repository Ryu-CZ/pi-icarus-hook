import assert from "node:assert/strict";
import test from "node:test";
import extension from "../src/index.js";

test("extension registers hook bindings and normal fabric tools", () => {
  const events: string[] = [];
  const tools: string[] = [];
  const oldEnv = {
    PI_ICARUS_HOOK_ADMIN_TOOLS: process.env.PI_ICARUS_HOOK_ADMIN_TOOLS,
    PI_ICARUS_HOOK_TOOLS: process.env.PI_ICARUS_HOOK_TOOLS,
    PI_ICARUS_HOOK_HOOKS: process.env.PI_ICARUS_HOOK_HOOKS,
  };
  process.env.PI_ICARUS_HOOK_ADMIN_TOOLS = "0";
  process.env.PI_ICARUS_HOOK_TOOLS = "1";
  process.env.PI_ICARUS_HOOK_HOOKS = "1";

  try {
    extension({
      on(event, _handler) { events.push(event); },
      registerTool(tool) { tools.push(tool.name); },
    });
  } finally {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  assert.deepEqual(events, ["session_start", "before_agent_start", "agent_end", "session_shutdown"]);
  assert.ok(tools.includes("fabric_write"));
  assert.ok(tools.includes("fabric_recall"));
  assert.ok(!tools.includes("fabric_train"));
});
