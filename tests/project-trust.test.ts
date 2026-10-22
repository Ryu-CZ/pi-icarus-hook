import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import extension from "../src/index.js";
import { loadConfig } from "../src/config.js";
import type { PiApi } from "../src/types.js";
import { commandReply, type TestEventHandler } from "./pi-test-helpers.js";

const core = new URL("./core/", import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createExtensionRuntime, loadExtensionFromFactory } = await import(new URL("extensions/loader.js", core).href);
const { ExtensionRunner, emitSessionShutdownEvent } = await import(new URL("extensions/runner.js", core).href);
const { SessionManager } = await import(new URL("session-manager.js", core).href);
const { createEventBus } = await import(new URL("event-bus.js", core).href);
const ENV_KEYS = ["PI_CODING_AGENT_DIR", "ICARUS_DIR", "ICARUS_PYTHON", "FABRIC_DIR", "HERMES_HOME", "HERMES_AGENT_NAME", "FABRIC_AGENT", "FABRIC_PROJECT_ID", "STATE_DB_PATH", "HERMES_STATE_DB"];

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-icarus-trust-"));
  const cwd = process.cwd();
  const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  t.after(async () => {
    process.chdir(cwd);
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await rm(root, { recursive: true, force: true });
  });
  for (const key of ENV_KEYS) delete process.env[key];
  const globalDir = join(root, "global");
  const project = join(root, "project");
  await mkdir(globalDir);
  await mkdir(join(project, ".pi"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = globalDir;
  process.chdir(project);
  async function worker(base: string, label: string) {
    const path = join(base, "icarus");
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "__init__.py"), "");
    await writeFile(join(path, "hooks.py"), `import json, os\ndef on_session_start(**kwargs):\n with open(${JSON.stringify(join(root, "startup.jsonl"))}, "a") as f: f.write(json.dumps({"label": ${JSON.stringify(label)}, "session": kwargs.get("session_id")}) + "\\n")\n return {"context": ${JSON.stringify(label)} + ":" + os.environ["FABRIC_DIR"]}\ndef on_session_end(**kwargs): return {}\n`);
    return path;
  }
  const globalWorker = await worker(join(root, "global-worker"), "global");
  await writeFile(join(globalDir, "settings.json"), JSON.stringify({ piIcarusHook: { icarusDir: globalWorker, python: "python3", fabricDir: join(root, "global-fabric"), hooks: true, tools: true, adminTools: false, contextDisplay: true, timeoutMs: 1000 } }));
  const writeProject = (settings: unknown) => writeFile(join(project, ".pi", "settings.json"), JSON.stringify(settings));
  async function host(trusted: boolean) {
    const runtime = createExtensionRuntime();
    const messages: Array<{ content: string }> = [];
    runtime.sendMessage = (message: { content: string }) => messages.push(message);
    const loaded = await loadExtensionFromFactory(extension, project, createEventBus(), runtime, "icarus-trust-test");
    const runner = new ExtensionRunner([loaded], runtime, project, SessionManager.inMemory(project), {});
    // Set the host trust decision; handlers still receive the real Pi-created context.
    runner.isProjectTrustedFn = () => trusted;
    const errors: unknown[] = [];
    runner.onError((error: unknown) => errors.push(error));
    const exitListeners = process.listenerCount("exit");
    t.after(async () => {
      await emitSessionShutdownEvent(runner, { type: "session_shutdown", reason: "exit" });
      runner.invalidate();
      assert.deepEqual(errors, []);
      assert.equal(process.listenerCount("exit"), exitListeners);
    });
    return { runner, loaded, messages, exitListeners };
  }
  return { root, project, worker, writeProject, host };
}

test("real Pi denied trust ignores project executable, storage, aliases, and admin tools", async t => {
  const f = await fixture(t);
  const executable = join(f.root, "untrusted-python");
  const marker = join(f.root, "executed");
  await writeFile(executable, `#!/bin/sh\nprintf ran > '${marker}'\n`, { mode: 0o755 });
  await f.writeProject({ "pi-icarus-hook": { python: executable, fabric_dir: "../project-fabric", bindHooks: false, registerTools: false, registerAdminTools: true } });
  assert.equal(loadConfig(f.project).python, "python3", "public config loader fails closed by default");
  const h = await f.host(false);
  assert.equal(h.loaded.tools.size, 0, "factory does not register tools from undecided settings");
  assert.equal(h.messages.length, 0, "factory does not start a worker");
  await h.runner.emit({ type: "session_start", reason: "startup" });
  assert.equal(existsSync(marker), false);
  assert.deepEqual(h.messages.map(m => m.content), ["global:" + join(f.root, "global-fabric")]);
  assert.ok(h.loaded.tools.has("fabric_write"));
  assert.ok(!h.loaded.tools.has("fabric_train"));
  const inspect = await h.loaded.tools.get("icarus_hook_config").definition.execute("inspect", {}, undefined, undefined, {});
  assert.equal(inspect.details.effective.fabricDir, join(f.root, "global-fabric"));
  const handlerCount = [...h.loaded.handlers.values()].reduce((sum: number, handlers: unknown[]) => sum + handlers.length, 0);
  await h.runner.emit({ type: "session_start", reason: "reload" });
  assert.equal([...h.loaded.handlers.values()].reduce((sum: number, handlers: unknown[]) => sum + handlers.length, 0), handlerCount);
  assert.equal(process.listenerCount("exit"), h.exitListeners + 1);
});

test("real Pi trusted startup applies project aliases, relative storage and admin tools immediately", async t => {
  const f = await fixture(t);
  await f.worker(join(f.project, "project-worker"), "project");
  await f.writeProject({ "pi-icarus-hook": { icarus_dir: "../project-worker/icarus", fabric_dir: "../project-fabric", bindHooks: true, registerTools: true, registerAdminTools: true } });
  const h = await f.host(true);
  await h.runner.emit({ type: "session_start", reason: "startup" });
  assert.deepEqual(h.messages.map(m => m.content), ["project:" + join(f.project, "project-fabric")]);
  assert.ok(h.loaded.tools.has("fabric_train"));
});

test("real Pi trusted project can disable hooks and tools; environment paths retain precedence", async t => {
  const f = await fixture(t);
  await f.writeProject({ icarusHook: { hooks: false, tools: false, adminTools: true, icarusDir: "../other/icarus", fabricDir: "../other-fabric" } });
  process.env.FABRIC_DIR = join(f.root, "env-fabric");
  process.env.ICARUS_DIR = join(f.root, "env-icarus");
  const config = loadConfig(f.project, { projectTrusted: true });
  assert.equal(config.fabricDir, process.env.FABRIC_DIR);
  assert.equal(config.icarusDir, process.env.ICARUS_DIR);
  const h = await f.host(true);
  await h.runner.emit({ type: "session_start", reason: "startup" });
  assert.equal(h.messages.length, 0);
  assert.equal(h.loaded.tools.size, 0);
});

test("missing host trust fails closed, including config command project reads and writes", async t => {
  const f = await fixture(t);
  await f.writeProject({ piIcarusHook: { python: "/untrusted/python", hooks: false, tools: false, contextDisplay: false } });
  const handlers = new Map<string, TestEventHandler[]>();
  const commands = new Map<string, Parameters<NonNullable<PiApi["registerCommand"]>>[1]>();
  const tools = new Map<string, unknown>();
  extension({
    on(name, handler) { handlers.set(name, [...handlers.get(name) ?? [], handler]); return () => {}; },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
    sendMessage() {},
  });
  const ctx = { cwd: f.project };
  for (const handler of [...handlers.get("session_start") ?? []]) await handler({ reason: "startup" }, ctx);
  t.after(async () => { for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx); });
  assert.ok(tools.has("fabric_write"));
  const projectPath = join(f.project, ".pi", "settings.json");
  const before = await readFile(projectPath, "utf8");
  assert.match(await commandReply(commands.get("icarus")?.handler, "context default status", ctx), /visible from global settings/);
  assert.match(await commandReply(commands.get("icarus")?.handler, "context default show project", ctx), /has not granted project trust/);
  assert.match(await commandReply(commands.get("icarus")?.handler, "context default hide", ctx), /global settings/);
  const globalSettings = JSON.parse(await readFile(join(f.root, "global", "settings.json"), "utf8"));
  assert.equal(globalSettings.piIcarusHook.contextDisplay, false);
  assert.equal(await readFile(projectPath, "utf8"), before);
});

for (const trusted of [false, true]) {
  test(`real CLI ${trusted ? "trusted" : "denied"} replacement refreshes config without duplicate startup or listener accumulation`, async t => {
    const f = await fixture(t);
    await f.worker(join(f.project, "project-worker"), "project");
    const projectConfig = (hooks: boolean) => ({ "pi-icarus-hook": {
      icarus_dir: "../project-worker/icarus", fabric_dir: "../project-fabric",
      bindHooks: hooks, registerTools: false, registerAdminTools: true,
    } });
    await f.writeProject(projectConfig(true));
    const cli = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
    const child = spawn(process.execPath, [cli, trusted ? "--approve" : "--no-approve", "--no-extensions", "-e", fileURLToPath(new URL("../src/index.js", import.meta.url)), "--mode", "rpc"], {
      cwd: f.project, env: process.env, stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    let stderr = "";
    let nextId = 0;
    const records: any[] = [];
    const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const record = JSON.parse(line);
        records.push(record);
        const request = pending.get(record.id);
        if (record.type === "response" && request) {
          clearTimeout(request.timer);
          pending.delete(record.id);
          request.resolve(record);
        }
      }
    });
    const command = (type: string, extra = {}) => new Promise<any>((resolve, reject) => {
      const id = String(++nextId);
      const timer = setTimeout(() => reject(new Error(`RPC ${type} timed out: ${stderr}`)), 10000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, type, ...extra })}\n`);
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    });
    try {
      let state = await command("get_state");
      assert.equal(state.success, true);
      const sessionIds = [state.data.sessionId];
      assert.equal((await command("prompt", { message: "/icarus config" })).data.disposition, "handled");
      for (let index = 1; index <= 12; index++) {
        await f.writeProject(projectConfig(index % 2 === 0));
        const replacement = await command("new_session");
        assert.equal(replacement.success, true);
        assert.equal(replacement.data.cancelled, false);
        state = await command("get_state");
        assert.equal(state.success, true);
        sessionIds.push(state.data.sessionId);
        assert.equal((await command("prompt", { message: "/icarus config" })).data.disposition, "handled");
      }
      child.stdin.end();
      assert.equal(await exited, 0, stderr);
      const starts = (await readFile(join(f.root, "startup.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      const expectedIds = trusted ? sessionIds.filter((_, index) => index % 2 === 0) : sessionIds;
      assert.deepEqual(starts.map(start => start.session), expectedIds);
      assert.ok(starts.every(start => start.label === (trusted ? "project" : "global")));
      const inspections = records.filter(record => record.type === "extension_ui_request" && record.method === "notify" && record.message?.startsWith("{"))
        .map(record => JSON.parse(record.message).effective);
      assert.equal(inspections.length, sessionIds.length);
      for (const [index, config] of inspections.entries()) {
        assert.equal(config.hooks, trusted ? index % 2 === 0 : true);
        assert.equal(config.tools, !trusted);
        assert.equal(config.adminTools, trusted);
        assert.equal(config.fabricDir, trusted ? join(f.project, "project-fabric") : join(f.root, "global-fabric"));
      }
      assert.doesNotMatch(stderr, /MaxListenersExceededWarning|stale|Failed to load extension/);
    } finally {
      for (const request of pending.values()) clearTimeout(request.timer);
      if (child.exitCode === null) child.kill("SIGKILL");
      await exited;
    }
  });
}

