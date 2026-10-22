import type { TestEventHandler } from "./pi-test-helpers.js";
import assert from "node:assert/strict";
import test from "node:test";
import { bindHooks } from "../src/hooks.js";
import { loadConfig } from "../src/config.js";
import type { PiApi } from "../src/types.js";

function setup() {
  const handlers: Record<string, TestEventHandler> = {};
  const calls: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const bridge = {
    async hook(name: string, payload: Record<string, unknown>) { calls.push({ name, payload }); },
    close() {},
  };
  const pi: PiApi = { on(name, handler) { handlers[name] = handler; return () => {}; }, registerTool() {} };
  bindHooks(pi, bridge as never, loadConfig());
  const emit = (name: string, event: Record<string, unknown> = {}) => handlers[name]?.(event, {
    sessionManager: { getSessionId: () => "session" },
  });
  const start = () => emit("before_agent_start", { messageType: "user", prompt: "original" });
  const end = (messages: unknown[]) => emit("agent_end", { messages });
  const settle = (aborted = false) => emit("agent_settled", { aborted });
  const captures = () => calls.filter((call) => call.name === "post_llm_call");
  return { emit, start, end, settle, captures, calls };
}

for (const intermediate of ["error", "toolUse"]) {
  test(`captures once after ${intermediate} continuation with original attribution`, async () => {
    const f = setup();
    await f.start();
    await f.end([
      { role: "user", content: "original" },
      { role: "assistant", content: "partial", stopReason: intermediate },
    ]);
    assert.equal(f.captures().length, 0);
    await f.end([{ role: "assistant", content: "finished", stopReason: "stop" }]);
    await f.settle();
    await f.settle();
    assert.deepEqual(f.captures().map((call) => call.payload), [{
      session_id: "session", user_message: "original", assistant_response: "finished", platform: "pi",
    }]);
  });
}

for (const stopReason of ["error", "aborted", "length", "toolUse"]) {
  test(`does not capture unsuccessful ${stopReason} settlement`, async () => {
    const f = setup();
    await f.start();
    await f.end([{ role: "assistant", content: "partial", stopReason }]);
    await f.settle();
    assert.equal(f.captures().length, 0);
  });
}

test("aborted settlement discards even a completed response and does not leak to next run", async () => {
  const f = setup();
  await f.start();
  await f.end([{ role: "assistant", content: "discard", stopReason: "stop" }]);
  await f.settle(true);
  await f.start();
  await f.settle();
  assert.equal(f.captures().length, 0);
});

test("custom triggers neither recall nor capture nor consume first eligible prompt", async () => {
  const f = setup();
  await f.emit("before_agent_start", { messageType: "custom", message: { content: "automation" } });
  await f.end([{ role: "assistant", content: "automated", stopReason: "stop" }]);
  await f.settle();
  assert.equal(f.calls.length, 0);
  await f.start();
  assert.equal(f.calls[0]?.payload.is_first_turn, true);
});

test("groups queued user messages with the final answer", async () => {
  const f = setup();
  await f.start();
  await f.end([{ role: "user", content: "original" }, { role: "assistant", content: "first", stopReason: "stop" }]);
  await f.end([{ role: "user", content: [{ type: "text", text: "follow up" }] }, { role: "assistant", content: "final", stopReason: "stop" }]);
  await f.settle();
  assert.equal(f.captures()[0]?.payload.user_message, "original\n\nfollow up");
  assert.equal(f.captures()[0]?.payload.assistant_response, "final");
});

test("session replacement clears pending capture and finalizes outgoing session", async () => {
  const f = setup();
  await f.start();
  await f.end([{ role: "assistant", content: "pending", stopReason: "stop" }]);
  await f.emit("session_shutdown", { reason: "resume" });
  await f.emit("session_start", { reason: "resume" });
  await f.settle();
  assert.equal(f.captures().length, 0);
  assert.equal(f.calls.filter((call) => call.name === "on_session_end").length, 1);
});
