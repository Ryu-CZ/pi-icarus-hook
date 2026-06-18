import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import extension from "../src/index.js";
import { registerConfigIntrospection } from "../src/config-schema.js";
import { bindHooks } from "../src/hooks.js";
import type { PiApi, PiBridgeConfig } from "../src/types.js";

const IGNORED_PI_ENV_KEYS = [
  "PI_ICARUS_HOOK_ADMIN_TOOLS",
  "PI_ICARUS_HOOK_TOOLS",
  "PI_ICARUS_HOOK_HOOKS",
  "PI_CODING_AGENT_DIR",
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
  assert.deepEqual(commands, ["icarus"]);
  assert.equal(statuses["icarus"], "🪽 Icarus");
  assert.match(String(await commandHandlers["icarus"]?.("", ctx)), /hooks are off/);
  assert.equal(statuses["icarus"], undefined);
  assert.match(String(await commandHandlers["icarus"]?.("context status", ctx)), /visible/);
  assert.match(String(await commandHandlers["icarus"]?.("context hide", ctx)), /hidden/);
  assert.match(String(await commandHandlers["icarus"]?.("context show", ctx)), /visible/);
  assert.match(String(await commandHandlers["icarus"]?.("context", ctx)), /hidden/);
  await handlers.before_agent_start?.({}, ctx);
  assert.equal(statuses["icarus"], undefined);
  assert.match(String(await commandHandlers["icarus"]?.("", ctx)), /hooks are on/);
  assert.equal(statuses["icarus"], "🪽 Icarus");
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
  assert.deepEqual(commands, ["icarus"]);
  assert.deepEqual(tools, []);
});

test("runtime context visibility controls injected message display", async () => {
  const handlers: Record<string, (...args: unknown[]) => unknown> = {};
  const commands: Record<string, (args: unknown, ctx: unknown) => unknown> = {};
  const config: PiBridgeConfig = {
    icarusDir: "/tmp/icarus",
    python: "python3",
    fabricDir: "/tmp/fabric",
    agent: "pi-agent",
    projectId: "pi-icarus-hook",
    platform: "pi",
    bindHooks: true,
    registerTools: false,
    registerAdminTools: false,
    hiddenDisplay: true,
    footerStatus: "🪽 Icarus",
    callTimeoutMs: 30000,
  };
  const pi: PiApi = {
    on(event, handler) { handlers[event] = handler; },
    registerCommand(name, command) { commands[name] = command.handler; },
    registerTool() {},
  };
  const bridge = {
    hook: async () => ({ context: "remembered context" }),
    close() {},
  };

  const hookControl = bindHooks(pi, bridge as never, config);
  registerConfigIntrospection(pi, config, false, hookControl);

  const visible = await handlers.before_agent_start?.({ prompt: "hello", session_id: "s" }, {});
  assert.equal((visible as { message: { display: boolean } }).message.display, true);

  assert.match(String(await commands.icarus?.("context hide", {})), /hidden/);
  const hidden = await handlers.before_agent_start?.({ prompt: "hello", session_id: "s" }, {});
  assert.equal((hidden as { message: { display: boolean } }).message.display, false);

  assert.match(String(await commands.icarus?.("context", {})), /visible/);
  const visibleAgain = await handlers.before_agent_start?.({ prompt: "hello", session_id: "s" }, {});
  assert.equal((visibleAgain as { message: { display: boolean } }).message.display, true);
});

test("context default commands persist future startup defaults only", async (t) => {
  const handlers: Record<string, (...args: unknown[]) => unknown> = {};
  const commands: Record<string, (args: unknown, ctx: unknown) => unknown> = {};
  const root = await mkdtemp(join(tmpdir(), "pi-icarus-hook-settings-"));
  const agentDir = join(root, "agent");
  const oldEnv = saveEnv();
  t.after(async () => {
    restoreEnv(oldEnv);
    await rm(root, { recursive: true, force: true });
  });
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const config: PiBridgeConfig = {
    icarusDir: "/tmp/icarus",
    python: "python3",
    fabricDir: "/tmp/fabric",
    agent: "pi-agent",
    projectId: "pi-icarus-hook",
    platform: "pi",
    bindHooks: true,
    registerTools: false,
    registerAdminTools: false,
    hiddenDisplay: true,
    footerStatus: "🪽 Icarus",
    callTimeoutMs: 30000,
  };
  const pi: PiApi = {
    on(event, handler) { handlers[event] = handler; },
    registerCommand(name, command) { commands[name] = command.handler; },
    registerTool() {},
  };
  const bridge = {
    hook: async () => ({ context: "remembered context" }),
    close() {},
  };
  const ctx = { cwd: root, ui: { notify() {} } };

  const hookControl = bindHooks(pi, bridge as never, config);
  registerConfigIntrospection(pi, config, false, hookControl);

  assert.match(String(await commands.icarus?.("context default status", ctx)), /Startup default is visible from built-in default/);
  assert.match(String(await commands.icarus?.("context default hide", ctx)), /future Pi sessions/);

  const globalSettings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as Record<string, { contextDisplay: boolean }>;
  assert.equal(globalSettings.piIcarusHook.contextDisplay, false);

  const visible = await handlers.before_agent_start?.({ prompt: "hello", session_id: "s" }, {});
  assert.equal((visible as { message: { display: boolean } }).message.display, true);

  assert.match(String(await commands.icarus?.("context hide", ctx)), /hidden/);
  assert.match(String(await commands.icarus?.("context default show project", ctx)), /project settings/);

  const projectSettings = JSON.parse(await readFile(join(root, ".pi", "settings.json"), "utf8")) as Record<string, { contextDisplay: boolean }>;
  assert.equal(projectSettings.piIcarusHook.contextDisplay, true);

  const hidden = await handlers.before_agent_start?.({ prompt: "hello", session_id: "s" }, {});
  assert.equal((hidden as { message: { display: boolean } }).message.display, false);
});
