import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";

const ENV_KEYS = [
  "ICARUS_DIR",
  "ICARUS_PYTHON",
  "FABRIC_DIR",
  "HERMES_AGENT_NAME",
  "FABRIC_AGENT",
  "HERMES_HOME",
  "STATE_DB_PATH",
  "HERMES_STATE_DB",
  "FABRIC_PROJECT_ID",
  "PI_CODING_AGENT_DIR",
];

const IGNORED_PI_ENV_KEYS = [
  "PI_ICARUS_HOOK_PLATFORM",
  "PI_ICARUS_HOOK_HOOKS",
  "PI_ICARUS_HOOK_TOOLS",
  "PI_ICARUS_HOOK_ADMIN_TOOLS",
  "PI_ICARUS_HOOK_CONTEXT_DISPLAY",
  "PI_ICARUS_HOOK_FOOTER_STATUS",
  "PI_ICARUS_HOOK_TIMEOUT_MS",
];

const ALL_ENV_KEYS = [...ENV_KEYS, ...IGNORED_PI_ENV_KEYS];

function saveEnv(): Record<string, string | undefined> {
  return Object.fromEntries(ALL_ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const key of ALL_ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test("loads pi-icarus-hook settings from project .pi/settings.json", async (t) => {
  const saved = saveEnv();
  const root = await mkdtemp(join(tmpdir(), "pi-icarus-hook-config-"));
  t.after(async () => {
    restoreEnv(saved);
    await rm(root, { recursive: true, force: true });
  });
  for (const key of ALL_ENV_KEYS) delete process.env[key];

  await mkdir(join(root, ".pi"), { recursive: true });
  await writeFile(join(root, ".pi", "settings.json"), JSON.stringify({
    piIcarusHook: {
      icarusDir: "./icarus",
      hermesHome: "./hermes",
      fabricDir: "./fabric",
      agent: "settings-agent",
      projectId: "settings-project",
      platform: "pi-settings",
      tools: false,
      adminTools: true,
      contextDisplay: true,
      footerStatus: "🪽 Project Icarus",
      timeoutMs: 1234,
    },
  }), "utf8");

  const config = loadConfig(root);

  assert.equal(config.icarusDir, join(root, ".pi", "icarus"));
  assert.equal(config.hermesHome, join(root, ".pi", "hermes"));
  assert.equal(config.fabricDir, join(root, ".pi", "fabric"));
  assert.equal(config.agent, "settings-agent");
  assert.equal(config.projectId, "settings-project");
  assert.equal(config.platform, "pi-settings");
  assert.equal(config.registerTools, false);
  assert.equal(config.registerAdminTools, true);
  assert.equal(config.hiddenDisplay, true);
  assert.equal(config.footerStatus, "🪽 Project Icarus");
  assert.equal(config.callTimeoutMs, 1234);
});

test("loads footer status from global Pi settings", async (t) => {
  const saved = saveEnv();
  const root = await mkdtemp(join(tmpdir(), "pi-icarus-hook-global-config-"));
  const agentDir = join(root, "agent");
  t.after(async () => {
    restoreEnv(saved);
    await rm(root, { recursive: true, force: true });
  });
  for (const key of ALL_ENV_KEYS) delete process.env[key];
  process.env.PI_CODING_AGENT_DIR = agentDir;

  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    piIcarusHook: {
      footerStatus: "🪽 Global Icarus",
    },
  }), "utf8");

  const config = loadConfig(root);

  assert.equal(config.footerStatus, "🪽 Global Icarus");
  assert.equal(config.hiddenDisplay, true);
});

test("Pi extension behavior is Pi settings only, not environment variables", async (t) => {
  const saved = saveEnv();
  const root = await mkdtemp(join(tmpdir(), "pi-icarus-hook-pi-settings-"));
  t.after(async () => {
    restoreEnv(saved);
    await rm(root, { recursive: true, force: true });
  });
  for (const key of ALL_ENV_KEYS) delete process.env[key];
  process.env.PI_ICARUS_HOOK_PLATFORM = "env-platform";
  process.env.PI_ICARUS_HOOK_HOOKS = "1";
  process.env.PI_ICARUS_HOOK_TOOLS = "1";
  process.env.PI_ICARUS_HOOK_ADMIN_TOOLS = "1";
  process.env.PI_ICARUS_HOOK_CONTEXT_DISPLAY = "1";
  process.env.PI_ICARUS_HOOK_FOOTER_STATUS = "env-footer";
  process.env.PI_ICARUS_HOOK_TIMEOUT_MS = "9999";

  await mkdir(join(root, ".pi"), { recursive: true });
  await writeFile(join(root, ".pi", "settings.json"), JSON.stringify({
    piIcarusHook: {
      platform: "settings-platform",
      hooks: false,
      tools: false,
      adminTools: false,
      contextDisplay: false,
      footerStatus: "settings-footer",
      timeoutMs: 1234,
    },
  }), "utf8");

  const config = loadConfig(root);

  assert.equal(config.platform, "settings-platform");
  assert.equal(config.bindHooks, false);
  assert.equal(config.registerTools, false);
  assert.equal(config.registerAdminTools, false);
  assert.equal(config.hiddenDisplay, false);
  assert.equal(config.footerStatus, "settings-footer");
  assert.equal(config.callTimeoutMs, 1234);
});

test("external runtime environment variables override Pi settings", async (t) => {
  const saved = saveEnv();
  const root = await mkdtemp(join(tmpdir(), "pi-icarus-hook-env-"));
  t.after(async () => {
    restoreEnv(saved);
    await rm(root, { recursive: true, force: true });
  });
  for (const key of ALL_ENV_KEYS) delete process.env[key];

  await mkdir(join(root, ".pi"), { recursive: true });
  await writeFile(join(root, ".pi", "settings.json"), JSON.stringify({
    "pi-icarus-hook": {
      icarusDir: "./settings-icarus",
      tools: false,
    },
  }), "utf8");
  process.env.ICARUS_DIR = join(root, "env-icarus");

  const config = loadConfig(root);

  assert.equal(config.icarusDir, join(root, "env-icarus"));
  assert.equal(config.registerTools, false);
});
