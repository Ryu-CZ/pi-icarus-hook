import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectBooleanPackageSetting } from "../src/settings.js";

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
