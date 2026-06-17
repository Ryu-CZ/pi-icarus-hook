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
  const commands: string[] = [];
  const commandHandlers: Record<string, (args: unknown, ctx: unknown) => unknown> = {};
  const tools: string[] = [];
  const handlers: Record<string, (...args: unknown[]) => unknown> = {};
  const statuses: Record<string, string | undefined> = {};
  const ctx = {
    ui: {
      setStatus(key: string, value: string | undefined) { statuses[key] = value; },
      notify(_message: string, _level?: string) {},
    },
  };
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
    on(event, handler) { events.push(event); handlers[event] = handler; },
    registerCommand(name, command) { commands.push(name); commandHandlers[name] = command.handler; },
    registerTool(tool) { tools.push(tool.name); },
  });

  await handlers.before_agent_start?.({}, ctx);

  assert.deepEqual(events, ["session_start", "before_agent_start", "agent_end", "session_shutdown"]);
  assert.deepEqual(commands, ["icarus-hook"]);
  assert.equal(statuses["icarus-hook"], "🪽 Icarus");
  assert.match(String(await commandHandlers["icarus-hook"]?.("", ctx)), /hooks are off/);
  assert.equal(statuses["icarus-hook"], undefined);
  await handlers.before_agent_start?.({}, ctx);
  assert.equal(statuses["icarus-hook"], undefined);
  assert.match(String(await commandHandlers["icarus-hook"]?.("", ctx)), /hooks are on/);
  assert.equal(statuses["icarus-hook"], "🪽 Icarus");
  assert.ok(tools.includes("icarus_hook_config"));
  assert.ok(tools.includes("fabric_write"));
  assert.ok(tools.includes("fabric_recall"));
  assert.ok(!tools.includes("fabric_train"));
});

test("extension closes bridge on shutdown when hook bindings are disabled", async (t) => {
  const events: string[] = [];
  const commands: string[] = [];
  const tools: string[] = [];
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
    registerCommand(name, _command) { commands.push(name); },
    registerTool(tool) { tools.push(tool.name); },
  });

  assert.deepEqual(events, ["session_shutdown"]);
  assert.deepEqual(commands, ["icarus-hook"]);
  assert.deepEqual(tools, []);
});
