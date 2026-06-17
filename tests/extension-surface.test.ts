import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import extension from "../src/index.js";

const IGNORED_PI_ENV_KEYS = [
  "PI_ICARUS_HOOK_ADMIN_TOOLS",
  "PI_ICARUS_HOOK_TOOLS",
  "PI_ICARUS_HOOK_HOOKS",
];

function saveEnv(): Record<string, string | undefined> {
  return Object.fromEntries(IGNORED_PI_ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test("extension registers hook bindings and normal fabric tools", async (t) => {
  const events: string[] = [];
  const tools: string[] = [];
  const root = await mkdtemp(join(tmpdir(), "pi-icarus-hook-extension-"));
  const oldCwd = process.cwd();
  const oldEnv = saveEnv();
  t.after(async () => {
    process.chdir(oldCwd);
    restoreEnv(oldEnv);
    await rm(root, { recursive: true, force: true });
  });

  process.chdir(root);
  await mkdir(join(root, ".pi"), { recursive: true });
  await writeFile(join(root, ".pi", "settings.json"), JSON.stringify({
    piIcarusHook: {
      adminTools: false,
      tools: true,
      hooks: true,
    },
  }), "utf8");
  process.env.PI_ICARUS_HOOK_ADMIN_TOOLS = "0";
  process.env.PI_ICARUS_HOOK_TOOLS = "1";
  process.env.PI_ICARUS_HOOK_HOOKS = "1";

  extension({
    on(event, _handler) { events.push(event); },
    registerTool(tool) { tools.push(tool.name); },
  });

  assert.deepEqual(events, ["session_start", "before_agent_start", "agent_end", "session_shutdown"]);
  assert.ok(tools.includes("fabric_write"));
  assert.ok(tools.includes("fabric_recall"));
  assert.ok(!tools.includes("fabric_train"));
});

test("extension closes bridge on shutdown when hook bindings are disabled", async (t) => {
  const events: string[] = [];
  const root = await mkdtemp(join(tmpdir(), "pi-icarus-hook-extension-disabled-"));
  const oldCwd = process.cwd();
  const oldEnv = saveEnv();
  t.after(async () => {
    process.chdir(oldCwd);
    restoreEnv(oldEnv);
    await rm(root, { recursive: true, force: true });
  });

  process.chdir(root);
  await mkdir(join(root, ".pi"), { recursive: true });
  await writeFile(join(root, ".pi", "settings.json"), JSON.stringify({
    piIcarusHook: {
      adminTools: false,
      tools: false,
      hooks: false,
    },
  }), "utf8");
  process.env.PI_ICARUS_HOOK_ADMIN_TOOLS = "0";
  process.env.PI_ICARUS_HOOK_TOOLS = "0";
  process.env.PI_ICARUS_HOOK_HOOKS = "0";

  extension({
    on(event, _handler) { events.push(event); },
    registerTool(_tool) {},
  });

  assert.deepEqual(events, ["session_shutdown"]);
});
