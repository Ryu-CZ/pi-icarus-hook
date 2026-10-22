import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { getEventListeners } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { IcarusBridge } from "../src/bridge.js";
import type { PiApi, PiBridgeConfig } from "../src/types.js";
import { registerTools } from "../src/tools.js";

const python = process.env.ICARUS_PYTHON || "python3";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-icarus-bridge-"));
  const icarusDir = join(root, "trusted", "icarus");
  await mkdir(icarusDir, { recursive: true });
  await writeFile(join(icarusDir, "__init__.py"), "");
  await writeFile(join(icarusDir, "tools.py"), `
import os
import time

def echo(args):
    return args

def runtime(args):
    return {"state_db": os.environ.get("STATE_DB_PATH"), "cwd": os.getcwd()}

def slow(args):
    time.sleep(0.5)
    with open(args["marker"], "a") as f:
        f.write("written\\n")
    return "written"

def fabric_search(args):
    if args.get("started"):
        with open(args["started"], "w") as f:
            f.write("started")
        while not os.path.exists(args["release"]):
            time.sleep(0.005)
    return args

def fabric_write(args):
    with open(args["marker"], "w") as f:
        f.write("mutation")
    return "written"

def partial_exit(args):
    os.write(1, b'{"id":')
    os._exit(1)
`);
  const config: PiBridgeConfig = {
    icarusDir, python, fabricDir: join(root, "fabric"), agent: "test", projectId: "test",
    platform: "pi", bindHooks: true, registerTools: true, registerAdminTools: false,
    hiddenDisplay: false, footerStatus: "Icarus", callTimeoutMs: 3000,
  };
  const bridge = new IcarusBridge(config);
  t.after(async () => { bridge.close(); await rm(root, { recursive: true, force: true }); });
  return { root, icarusDir, config, bridge };
}

function registeredTools(bridge: IcarusBridge) {
  const tools = new Map<string, Parameters<PiApi["registerTool"]>[0]>();
  registerTools({ on() { return () => {}; }, registerTool(tool) { tools.set(tool.name, tool as Parameters<PiApi["registerTool"]>[0]); } }, bridge, false);
  return (name: string, params: Record<string, unknown>, signal?: AbortSignal) =>
    tools.get(name)!.execute("test", params, signal, undefined, {} as never);
}

test("already-aborted tool calls never start a worker or submit a mutation", async (t) => {
  const { root, icarusDir, bridge } = await fixture(t);
  const startup = join(root, "startup");
  const marker = join(root, "mutation");
  await writeFile(join(icarusDir, "__init__.py"), `with open(${JSON.stringify(startup)}, "w") as f: f.write("started")\n`);
  const execute = registeredTools(bridge);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(execute("fabric_write", { marker }, controller.signal), /abort/i);
  assert.equal(existsSync(startup), false);
  assert.equal(existsSync(marker), false);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("aborting a queued write retires its worker without mutation or replay, then recovers", async (t) => {
  const { root, bridge } = await fixture(t);
  const execute = registeredTools(bridge);
  const started = join(root, "started");
  const release = join(root, "release");
  const marker = join(root, "mutation");
  const reader = new AbortController();
  const writer = new AbortController();
  const read = execute("fabric_search", { started, release }, reader.signal);
  const readOutcome = Promise.allSettled([read]);
  const deadline = Date.now() + 2000;
  while (!existsSync(started) && Date.now() < deadline) await delay(5);
  assert.equal(existsSync(started), true, "Python read must start before queueing the write");
  const write = execute("fabric_write", { marker }, writer.signal);
  const writeOutcome = Promise.allSettled([write]);
  writer.abort();
  // Unblock the old worker if cancellation was ignored; red must finish without a timeout.
  await writeFile(release, "release");
  for (const result of [...await readOutcome, ...await writeOutcome]) {
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") assert.match(result.reason.message, /abort.*indeterminate.*session state.*not replayed/i);
  }
  assert.equal(existsSync(marker), false);
  assert.equal(getEventListeners(reader.signal, "abort").length, 0);
  assert.equal(getEventListeners(writer.signal, "abort").length, 0);
  const fresh = execute("fabric_search", { healthy: true });
  reader.abort(); // The retired generation must not affect its replacement.
  assert.deepEqual((await fresh).details, { healthy: true });
  assert.equal(existsSync(marker), false);
});

test("settled tool calls remove abort listeners on success and Python failure", async (t) => {
  const { bridge } = await fixture(t);
  const execute = registeredTools(bridge);
  const success = new AbortController();
  await execute("fabric_search", { healthy: true }, success.signal);
  assert.equal(getEventListeners(success.signal, "abort").length, 0);
  const failure = new AbortController();
  await assert.rejects(execute("fabric_write", {}, failure.signal));
  assert.equal(getEventListeners(failure.signal, "abort").length, 0);
  const next = execute("fabric_search", { healthy: true });
  success.abort();
  failure.abort();
  assert.deepEqual((await next).details, { healthy: true });
});

for (const reason of ["timeout", "close", "exit", "spawn"] as const) {
  test(`${reason} retirement removes cancellation listeners and allows recovery`, async (t) => {
    const { root, config, bridge } = await fixture(t);
    const controller = new AbortController();
    if (reason === "spawn") config.python = join(root, "missing-python");
    if (reason === "timeout") config.callTimeoutMs = 50;
    const call = bridge.tool(reason === "exit" ? "partial_exit" : "fabric_search", {
      started: join(root, "started"), release: join(root, "never-release"),
    }, controller.signal);
    const rejected = assert.rejects(call);
    if (reason === "close") bridge.close();
    await rejected;
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    config.python = python;
    config.callTimeoutMs = 3000;
    const next = bridge.tool("echo", { recovered: true });
    controller.abort();
    assert.deepEqual(await next, { recovered: true });
  });
}

test("an abort during listener registration rejects before writing to the worker", async (t) => {
  const { root, bridge } = await fixture(t);
  const controller = new AbortController();
  const signal = controller.signal;
  const add = signal.addEventListener.bind(signal);
  t.mock.method(signal, "addEventListener", (...args: Parameters<typeof add>) => {
    add(...args);
    controller.abort();
  });
  const marker = join(root, "never-written");
  await assert.rejects(bridge.tool("fabric_write", { marker }, signal), /abort/i);
  assert.equal(getEventListeners(signal, "abort").length, 0);
  assert.equal(existsSync(marker), false);
  assert.deepEqual(await bridge.tool("echo", { recovered: true }), { recovered: true });
});

test("worker pipe failure rejects without an unhandled stream error crashing the host", async (t) => {
  const { config } = await fixture(t);
  // Node is deliberately not a Python interpreter: it exits while the large write is pending.
  const script = `
    import { IcarusBridge } from ${JSON.stringify(new URL("../src/bridge.js", import.meta.url).href)};
    const bridge = new IcarusBridge(${JSON.stringify({ ...config, python: process.execPath })});
    try {
      await bridge.tool("echo", {content: "a".repeat(1024 * 1024)});
      process.exitCode = 2;
    } catch (error) {
      console.log("caught", error.message);
    } finally { bridge.close(); }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /caught/);
  assert.doesNotMatch(result.stderr, /Unhandled 'error' event/);
});

test("failed spawn is retired and a repaired interpreter can start a new worker", async (t) => {
  const { root, config, bridge } = await fixture(t);
  const executable = spawnSync(python, ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" });
  assert.equal(executable.status, 0, executable.stderr);
  config.python = join(root, "missing-python");
  await assert.rejects(bridge.tool("echo", {}), /ENOENT/);
  await symlink(executable.stdout.trim(), config.python);
  assert.deepEqual(await bridge.tool("echo", { recovered: true }), { recovered: true });
});

test("trusted worker cwd preserves caller-relative interpreter and state database settings", async (t) => {
  const { root, config, bridge } = await fixture(t);
  const executable = spawnSync(python, ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" });
  assert.equal(executable.status, 0, executable.stderr);
  const interpreter = join(root, "python");
  await symlink(executable.stdout.trim(), interpreter);
  config.python = relative(process.cwd(), interpreter);
  config.stateDbPath = relative(process.cwd(), join(root, "state.db"));
  assert.deepEqual(await bridge.tool("runtime", {}), {
    state_db: join(root, "state.db"), cwd: join(root, "trusted"),
  });
});

test("deadline retires the serial queue without late writes or replay and permits explicit recovery", async (t) => {
  const { root, config, bridge } = await fixture(t);
  await bridge.tool("echo", {});
  config.callTimeoutMs = 80;
  const slowMarker = join(root, "slow-write");
  const queuedMarker = join(root, "queued-write");
  const results = await Promise.allSettled([
    bridge.tool("slow", { marker: slowMarker }),
    bridge.tool("slow", { marker: queuedMarker }),
  ]);
  for (const result of results) {
    assert.equal(result.status, "rejected");
  }
  config.callTimeoutMs = 3000;
  assert.deepEqual(await bridge.tool("echo", { recovered: true }), { recovered: true });
  await delay(550);
  assert.equal(existsSync(slowMarker), false, "timed-out mutation must not run later");
  assert.equal(existsSync(queuedMarker), false, "queued mutation must not run later or be replayed");
  for (const result of results) {
    if (result.status === "rejected") assert.match(result.reason.message, /timed out.*indeterminate.*session state.*not replayed/);
  }
});

test("close is idempotent and stale exits cannot reject a replacement worker's calls", async (t) => {
  const { config } = await fixture(t);
  // Isolate the regression: the broken implementation can orphan the replacement process.
  const script = `
    import { IcarusBridge } from ${JSON.stringify(new URL("../src/bridge.js", import.meta.url).href)};
    const bridge = new IcarusBridge(${JSON.stringify(config)});
    try {
      await bridge.tool("echo", {});
      bridge.close();
      bridge.close();
      console.log(JSON.stringify(await bridge.tool("echo", { generation: 2 })));
      console.log(JSON.stringify(await bridge.tool("echo", { stillAlive: true })));
      bridge.close();
      process.exit(0);
    } catch (error) { console.error(error); bridge.close(); process.exit(1); }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"generation":2/);
  assert.match(result.stdout, /"stillAlive":true/);
});

test("partial output from an exited worker cannot corrupt the replacement protocol", async (t) => {
  const { bridge } = await fixture(t);
  await assert.rejects(bridge.tool("partial_exit", {}), /worker (exited|closed)/);
  assert.deepEqual(await bridge.tool("echo", { fresh: true }), { fresh: true });
});

async function untrustedProject(t: test.TestContext, root: string, shadowStdlib = false) {
  const cwd = process.cwd();
  const pythonPath = process.env.PYTHONPATH;
  const project = join(root, "untrusted-project");
  await mkdir(join(project, "icarus"), { recursive: true });
  const marker = join(root, "untrusted-code-executed");
  const malicious = `with open(${JSON.stringify(marker)}, "a") as f: f.write("executed\\n")\n`;
  await writeFile(join(project, "icarus", "__init__.py"), malicious);
  // Even stdlib imports must not be resolved from the untrusted working directory.
  if (shadowStdlib) await writeFile(join(project, "contextlib.py"), malicious + "raise RuntimeError('untrusted stdlib shadow')\n");
  process.chdir(project);
  t.after(() => {
    process.chdir(cwd);
    if (pythonPath === undefined) delete process.env.PYTHONPATH;
    else process.env.PYTHONPATH = pythonPath;
  });
  return { project, marker };
}

test("configured checkout wins over cwd package shadow, preserving absolute dependency paths", async (t) => {
  const { root, icarusDir, bridge } = await fixture(t);
  const { project, marker } = await untrustedProject(t, root);
  const dependencies = join(root, "external-dependencies");
  await mkdir(dependencies);
  await writeFile(join(dependencies, "icarus_test_dependency.py"), "VALUE = 'external dependency'\n");
  await writeFile(join(icarusDir, "tools.py"), "import icarus_test_dependency\ndef echo(args): return icarus_test_dependency.VALUE\n");
  process.env.PYTHONPATH = ["", ".", "relative-dependency", project, dependencies].join(delimiter);
  assert.equal(await bridge.tool("echo", {}), "external dependency");
  assert.equal(existsSync(marker), false);
});

test("stdlib modules cannot be shadowed by the project working directory", async (t) => {
  const { root, bridge } = await fixture(t);
  const { project, marker } = await untrustedProject(t, root, true);
  process.env.PYTHONPATH = ["", ".", project].join(delimiter);
  assert.deepEqual(await bridge.tool("echo", { safe: true }), { safe: true });
  assert.equal(existsSync(marker), false);
});

test("missing configured checkout fails safely without falling back to project or another PYTHONPATH package", async (t) => {
  const { root, config, bridge } = await fixture(t);
  const { project, marker } = await untrustedProject(t, root);
  const fallback = join(root, "other-package");
  await mkdir(join(fallback, "icarus"), { recursive: true });
  await writeFile(join(fallback, "icarus", "__init__.py"), `with open(${JSON.stringify(marker)}, "a") as f: f.write("fallback\\n")\n`);
  process.env.PYTHONPATH = [project, fallback, "."].join(delimiter);
  config.icarusDir = join(root, "nonexistent-parent", "icarus");
  await assert.rejects(bridge.tool("echo", {}));
  assert.equal(existsSync(marker), false);
});

test("package import diagnostics cannot corrupt the JSON protocol", async (t) => {
  const { icarusDir, bridge } = await fixture(t);
  await writeFile(join(icarusDir, "__init__.py"), "print('import diagnostic', end='')\n");
  assert.deepEqual(await bridge.tool("echo", { ok: true }), { ok: true });
});
