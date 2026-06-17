import assert from "node:assert/strict";
import test from "node:test";
import { CONFIG_SCHEMA, configInspection, configSnippet } from "../src/config-schema.js";
import type { PiBridgeConfig } from "../src/types.js";

const config: PiBridgeConfig = {
  icarusDir: "/tmp/icarus",
  python: "python3",
  fabricDir: "/tmp/fabric",
  agent: "pi-agent",
  projectId: "pi-icarus-hook",
  platform: "pi",
  hermesHome: "/tmp/hermes",
  stateDbPath: "/tmp/hermes/state.db",
  bindHooks: true,
  registerTools: true,
  registerAdminTools: false,
  hiddenDisplay: false,
  footerStatus: "🪽 Icarus",
  callTimeoutMs: 30000,
};

test("config schema describes Pi settings and runtime env separately", () => {
  assert.equal(CONFIG_SCHEMA.key, "piIcarusHook");
  assert.equal(CONFIG_SCHEMA.settings.contextDisplay.default, false);
  assert.equal(CONFIG_SCHEMA.settings.footerStatus.default, "🪽 Icarus");
  assert.equal(CONFIG_SCHEMA.settings.adminTools.default, false);
  assert.equal(CONFIG_SCHEMA.runtimeEnv.ICARUS_DIR.default, "~/.hermes/plugins/icarus");
  assert.ok(!Object.hasOwn(CONFIG_SCHEMA.settings, "ICARUS_DIR"));
});

test("config inspection returns effective config and settings snippet", () => {
  assert.deepEqual(configSnippet(config), {
    piIcarusHook: {
      platform: "pi",
      hooks: true,
      tools: true,
      adminTools: false,
      timeoutMs: 30000,
      contextDisplay: false,
      footerStatus: "🪽 Icarus",
    },
  });

  const inspection = configInspection(config);
  assert.equal(inspection.package, "pi-icarus-hook");
  assert.deepEqual(inspection.settingsSnippet, configSnippet(config));
});
