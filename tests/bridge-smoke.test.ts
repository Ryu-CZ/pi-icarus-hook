import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { IcarusBridge } from "../src/bridge.js";
import type { PiBridgeConfig } from "../src/types.js";

const icarusDir = process.env.ICARUS_DIR || join(homedir(), ".hermes", "plugins", "icarus");

function skipIfNoIcarus(t: test.TestContext): void {
  if (!existsSync(join(icarusDir, "hooks.py")) || !existsSync(join(icarusDir, "tools.py"))) {
    t.skip(`Icarus checkout not found at ${icarusDir}`);
  }
}

async function withBridge(t: test.TestContext): Promise<{ bridge: IcarusBridge; root: string; fabricDir: string }> {
  skipIfNoIcarus(t);
  const root = await mkdtemp(join(tmpdir(), "pi-icarus-hook-"));
  const fabricDir = join(root, "fabric");
  const hermesHome = join(root, ".hermes-pi-smoke");
  await mkdir(fabricDir, { recursive: true });
  await mkdir(hermesHome, { recursive: true });

  const oldEnv = {
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    OPENROUTER_FULL_API_KEY: process.env.OPENROUTER_FULL_API_KEY,
    OPENROUTER_DS_API_KEY: process.env.OPENROUTER_DS_API_KEY,
  };
  process.env.DEEPSEEK_API_KEY = "";
  process.env.OPENROUTER_API_KEY = "";
  process.env.OPENROUTER_FULL_API_KEY = "";
  process.env.OPENROUTER_DS_API_KEY = "";

  const config: PiBridgeConfig = {
    icarusDir,
    python: process.env.ICARUS_PYTHON || "python3",
    fabricDir,
    agent: "pi-smoke",
    projectId: "pi-icarus-hook-smoke",
    platform: "pi",
    hermesHome,
    bindHooks: true,
    registerTools: true,
    registerAdminTools: false,
    hiddenDisplay: false,
    footerStatus: "🪽 Icarus",
    callTimeoutMs: 10000,
  };
  const bridge = new IcarusBridge(config);

  t.after(async () => {
    bridge.close();
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  return { bridge, root, fabricDir };
}

test("bridged Icarus tools are pass-through", async (t) => {
  const { bridge } = await withBridge(t);

  const write = await bridge.tool("fabric_write", {
    type: "note",
    summary: "Pi bridge smoke note",
    content: "Unique bridge tool token bridgetoolneedle.",
    training_value: "normal",
  }) as Record<string, unknown>;

  assert.equal(write.status, "written");
  assert.equal(typeof write.path, "string");

  const search = await bridge.tool("fabric_search", { query: "bridgetoolneedle" }) as Record<string, unknown>;
  assert.equal(search.count, 1);
});

test("persistent worker preserves Icarus hook session state", async (t) => {
  const { bridge, fabricDir } = await withBridge(t);

  await bridge.hook("on_session_start", { session_id: "sess-persistent", platform: "pi" });
  await bridge.hook("post_llm_call", {
    session_id: "sess-persistent",
    platform: "pi",
    user_message: "Please implement the bridge persistence smoke test and explain the resulting behavior with enough concrete detail.",
    assistant_response: "Completed the bridge persistence smoke test because Icarus session state must survive across calls in the same Python worker. Result: the post hook records this exchange, and the session end hook can then score and persist it instead of seeing an empty transcript. The outcome is verified by checking Fabric files for the sess-persistent session id.",
  });
  await bridge.hook("on_session_end", { session_id: "sess-persistent", platform: "pi", completed: true });

  const files = (await readdir(fabricDir)).filter((file) => file.endsWith(".md"));
  assert.ok(files.length >= 1, "expected Icarus to write at least one Fabric entry");

  const contents = await Promise.all(files.map((file) => readFile(join(fabricDir, file), "utf8")));
  assert.ok(contents.some((content) => content.includes("session_id: \"sess-persistent\"")));
});
