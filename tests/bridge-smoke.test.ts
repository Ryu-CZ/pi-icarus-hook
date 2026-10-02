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

test("fabric_write persists verified, evidence, and source_tool frontmatter", async (t) => {
  const { bridge, fabricDir } = await withBridge(t);

  const write = await bridge.tool("fabric_write", {
    type: "resolution",
    summary: "Verified metadata smoke",
    content: "Unique verified metadata token verifiedmetadataneedle.",
    status: "completed",
    training_value: "high",
    verified: "true",
    evidence: "node --test passed",
    source_tool: "bash",
  }) as Record<string, unknown>;

  assert.equal(write.status, "written");
  const path = write.path as string;
  assert.ok(path.endsWith(".md"));

  const text = await readFile(path, "utf8");
  const frontmatter = text.split("---")[1] ?? "";
  assert.match(frontmatter, /verified: "true"/);
  assert.match(frontmatter, /evidence: "node --test passed"/);
  assert.match(frontmatter, /source_tool: "bash"/);

  const plain = await bridge.tool("fabric_write", {
    type: "note",
    summary: "Unverified metadata smoke",
    content: "Unique unverified metadata token unverifiedmetadataneedle.",
  }) as Record<string, unknown>;

  const plainText = await readFile(plain.path as string, "utf8");
  const plainFrontmatter = plainText.split("---")[1] ?? "";
  assert.doesNotMatch(plainFrontmatter, /verified:/);
  assert.doesNotMatch(plainFrontmatter, /evidence:/);
});

test("persistent worker logs recalled review and revision usage once and skips rejected writes", async (t) => {
  const { bridge, fabricDir, root } = await withBridge(t);
  const sessionId = "sess-usage-telemetry";
  await bridge.hook("on_session_start", { session_id: sessionId, platform: "pi" });

  const original = await bridge.tool("fabric_write", {
    type: "note",
    summary: "Telemetry usage target",
    content: "Entry used to verify bridge usage telemetry.",
  }) as Record<string, unknown>;
  assert.equal(original.status, "written");
  const originalText = await readFile(original.path as string, "utf8");
  const originalId = /^id: "([^"]+)"$/m.exec(originalText)?.[1];
  assert.ok(originalId, "written entry must have an id");

  // Seed recall deterministically while keeping both calls in the bridge's Python worker.
  await bridge.state("log_recall", "telemetry test recall", [{ id: originalId, summary: "Telemetry usage target" }]);

  const review = await bridge.tool("fabric_write", {
    type: "review",
    summary: "Telemetry review",
    content: "Reviewed the recalled entry.",
    review_of: `pi-smoke:${originalId}`,
  }) as Record<string, unknown>;
  assert.equal(review.status, "written");

  const revision = await bridge.tool("fabric_write", {
    type: "resolution",
    summary: "Telemetry revision",
    content: "Revised the recalled entry.",
    revises: `pi-smoke:${originalId}`,
  }) as Record<string, unknown>;
  assert.equal(revision.status, "written");

  const rejected = await bridge.tool("fabric_write", {
    type: "review",
    summary: "Rejected telemetry review",
    content: "This write is rejected because its training value is invalid.",
    review_of: `pi-smoke:${originalId}`,
    training_value: "invalid",
  }) as Record<string, unknown>;
  assert.equal(typeof rejected.error, "string");

  const telemetryPath = join(root, ".hermes-pi-smoke", ".icarus-telemetry.jsonl");
  const events = (await readFile(telemetryPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const usage = events.filter((event) => event.event === "usage" && event.entry_id === originalId);
  assert.deepEqual(usage.map((event) => event.action).sort(), ["reviewed", "revised"]);
  assert.ok(usage.every((event) => event.session_id === sessionId));
  assert.equal((await readdir(fabricDir)).filter((file) => file.endsWith(".md")).length, 3);
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
