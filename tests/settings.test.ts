import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectBooleanPackageSetting, writeBooleanPackageSetting } from "../src/settings.js";

for (const scope of ["global", "project"] as const) {
  test(`${scope} writes cooperate with Pi's cross-process settings transaction`, async (t) => {
    const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
    const root = await mkdtemp(join(tmpdir(), "pi-icarus-settings-lock-"));
    const globalDir = join(root, "global");
    const dir = scope === "global" ? globalDir : join(root, ".pi");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "settings.json");
    const release = join(root, "release");
    process.env.PI_CODING_AGENT_DIR = globalDir;
    await writeFile(path, JSON.stringify({ theme: "dark", icarusHook: { hiddenDisplay: true, unrelated: "keep" } }));
    // Internal host seam is pinned to the Pi development dependency, never used in production.
    const host = new URL("./core/settings-manager.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href;
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { FileSettingsStorage } from ${JSON.stringify(host)};
      import { existsSync } from 'node:fs';
      const storage = new FileSettingsStorage(${JSON.stringify(root)}, ${JSON.stringify(globalDir)});
      storage.withLock(${JSON.stringify(scope)}, current => {
        process.stdout.write('locked\\n');
        const deadline = Date.now() + 10000;
        while (!existsSync(${JSON.stringify(release)})) {
          if (Date.now() > deadline) throw new Error('release handshake timed out');
        }
        return JSON.stringify({...JSON.parse(current), theme: 'light', defaultModel: 'host-update'});
      });
    `], { stdio: ["ignore", "pipe", "pipe"] });
    const exit = once(child, "exit");
    t.after(async () => {
      child.kill();
      restoreAgentDir(savedAgentDir);
      await rm(root, { recursive: true, force: true });
    });
    await once(child.stdout, "data"); // Host holds the actual Pi lock before the plugin starts.
    const write = writeBooleanPackageSetting(scope, root, "contextDisplay", false);
    const outcome = Promise.allSettled([write]);
    await delay(100);
    await writeFile(release, "release");
    assert.equal((await exit)[0], 0);
    assert.equal((await outcome)[0].status, "fulfilled");
    const document = JSON.parse(await readFile(path, "utf8"));
    assert.equal(document.theme, "light");
    assert.equal(document.defaultModel, "host-update");
    assert.deepEqual(document.icarusHook, { hiddenDisplay: true, unrelated: "keep", contextDisplay: false });
  });
}

test("settings writes create missing documents and never replace malformed JSON", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-icarus-settings-document-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, ".pi", "settings.json");
  await writeBooleanPackageSetting("project", root, "contextDisplay", false);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { piIcarusHook: { contextDisplay: false } });
  for (const raw of ['{"broken":', '[]', 'null', '"not an object"']) {
    await writeFile(path, raw);
    await assert.rejects(writeBooleanPackageSetting("project", root, "contextDisplay", true));
    assert.equal(await readFile(path, "utf8"), raw);
  }
  await writeFile(path, '{}');
  await writeBooleanPackageSetting("project", root, "contextDisplay", true);
});

function restoreAgentDir(savedAgentDir: string | undefined): void {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
}

test("setting inspection reads the legacy alias with project-over-global precedence", async (t) => {
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "pi-icarus-hook-settings-"));
  const projectDir = join(root, "project", ".pi");
  const globalDir = join(root, "global");
  await mkdir(projectDir, { recursive: true });
  await mkdir(globalDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = globalDir;
  t.after(async () => {
    restoreAgentDir(savedAgentDir);
    await rm(root, { recursive: true, force: true });
  });

  await writeFile(join(projectDir, "settings.json"), JSON.stringify({
    piIcarusHook: { hiddenDisplay: false, unrelated: "keep" },
  }));
  await writeFile(join(globalDir, "settings.json"), JSON.stringify({
    piIcarusHook: { contextDisplay: true },
  }));

  assert.deepEqual(await inspectBooleanPackageSetting("contextDisplay", true, join(root, "project")), {
    value: false,
    source: "project",
    path: join(projectDir, "settings.json"),
    packageKey: "piIcarusHook",
  });
});

test("setting inspection finds a legacy alias in global settings", async (t) => {
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "pi-icarus-hook-settings-"));
  const globalDir = join(root, "global");
  await mkdir(globalDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = globalDir;
  t.after(async () => {
    restoreAgentDir(savedAgentDir);
    await rm(root, { recursive: true, force: true });
  });

  await writeFile(join(globalDir, "settings.json"), JSON.stringify({
    piIcarusHook: { hiddenDisplay: false },
  }));

  const setting = await inspectBooleanPackageSetting("contextDisplay", true, join(root, "project"));
  assert.equal(setting.value, false);
  assert.equal(setting.source, "global");
});

test("canonical contextDisplay takes precedence over hiddenDisplay in the same scope", async (t) => {
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "pi-icarus-hook-settings-"));
  const projectDir = join(root, ".pi");
  await mkdir(projectDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = join(root, "global");
  t.after(async () => {
    restoreAgentDir(savedAgentDir);
    await rm(root, { recursive: true, force: true });
  });

  await writeFile(join(projectDir, "settings.json"), JSON.stringify({
    piIcarusHook: { contextDisplay: true, hiddenDisplay: false },
  }));

  assert.equal((await inspectBooleanPackageSetting("contextDisplay", true, root)).value, true);
});
