import type { TestEventHandler } from "./pi-test-helpers.js";
import assert from "node:assert/strict";
import test from "node:test";
import { bindHooks } from "../src/hooks.js";
import type { PiApi, PiBridgeConfig } from "../src/types.js";

type HookName = "on_session_start" | "pre_llm_call" | "post_llm_call" | "on_session_end";
type HookCall = { name: HookName; payload: Record<string, unknown> };

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

function setup(results: Partial<Record<HookName, unknown>> = {}) {
  const handlers: Record<string, TestEventHandler> = {};
  const calls: HookCall[] = [];
  const messages: Array<{
    message: Parameters<NonNullable<PiApi["sendMessage"]>>[0];
    options?: { triggerTurn?: boolean };
  }> = [];
  let closeCount = 0;
  const pi: PiApi = {
    on(event, handler) { handlers[event] = handler; return () => {}; },
    registerTool() {},
    sendMessage(message, options) { messages.push({ message, options }); },
  };
  const bridge = {
    async hook(name: HookName, payload: Record<string, unknown>) {
      calls.push({ name, payload });
      const result = results[name];
      if (result instanceof Error) throw result;
      return result;
    },
    close() { closeCount += 1; },
  };
  const control = bindHooks(pi, bridge as never, config);
  const ctx = (id: string) => ({ sessionManager: { getSessionId: () => id } });
  return { handlers, calls, messages, control, ctx, closed: () => closeCount };
}

test("session_start sends nonempty context through Pi without returning a model-turn message", async () => {
  const fake = setup({ on_session_start: { context: "startup memory" } });
  fake.control.setContextVisible(false);
  const result = await fake.handlers.session_start?.(
    { type: "session_start", reason: "startup" },
    fake.ctx("startup-session"),
  );

  assert.equal(result, undefined);
  assert.deepEqual(fake.messages, [{
    message: {
      customType: "icarus-session-context",
      content: "startup memory",
      display: false,
    },
    options: { triggerTurn: false },
  }]);
  assert.deepEqual(fake.calls[0], {
    name: "on_session_start",
    payload: { session_id: "startup-session", platform: "pi" },
  });
});

test("startup context skips empty text and honors visible display", async () => {
  const empty = setup({ on_session_start: { context: "  " } });
  await empty.handlers.session_start?.({ type: "session_start", reason: "startup" }, empty.ctx("s1"));
  assert.deepEqual(empty.messages, []);

  const visible = setup({ on_session_start: { context: "visible memory" } });
  visible.control.setContextVisible(true);
  await visible.handlers.session_start?.({ type: "session_start", reason: "startup" }, visible.ctx("s2"));
  assert.deepEqual(visible.messages, [{
    message: {
      customType: "icarus-session-context",
      content: "visible memory",
      display: true,
    },
    options: { triggerTurn: false },
  }]);
});

test("before_agent_start tracks eligible prompts and resets at session start", async () => {
  const fake = setup({ pre_llm_call: { context: "memory" }, on_session_start: {} });
  const ctx = fake.ctx("session-a");
  const event = (prompt: string) => ({ type: "before_agent_start", messageType: "user", prompt });

  fake.control.setEnabled(false);
  await fake.handlers.before_agent_start?.(event("disabled prompt"), ctx);
  fake.control.setEnabled(true);
  await fake.handlers.before_agent_start?.(event(""), ctx);
  await fake.handlers.before_agent_start?.(event("  \n  "), ctx);
  assert.equal(fake.calls.length, 0, "disabled and empty prompts must not consume the first turn");
  await fake.handlers.before_agent_start?.(event("first"), ctx);
  await fake.handlers.before_agent_start?.(event("second"), ctx);
  assert.deepEqual(fake.calls.filter((call) => call.name === "pre_llm_call").map((call) => call.payload), [
    { session_id: "session-a", user_message: "first", is_first_turn: true },
    { session_id: "session-a", user_message: "second", is_first_turn: false },
  ]);

  await fake.handlers.session_start?.({ type: "session_start", reason: "reload" }, fake.ctx("session-b"));
  await fake.handlers.before_agent_start?.(event("after reload"), fake.ctx("session-b"));
  assert.deepEqual(fake.calls.filter((call) => call.name === "pre_llm_call").at(-1)?.payload, {
    session_id: "session-b",
    user_message: "after reload",
    is_first_turn: true,
  });
});

test("each lifecycle hook uses the session manager ID and shutdown omits completed", async () => {
  const fake = setup({
    on_session_start: {},
    pre_llm_call: {},
    post_llm_call: {},
    on_session_end: {},
  });
  const ctx = fake.ctx("manager-session-id");

  await fake.handlers.session_start?.({ type: "session_start", reason: "new" }, ctx);
  await fake.handlers.before_agent_start?.({ type: "before_agent_start", messageType: "user", prompt: "hello" }, ctx);
  await fake.handlers.agent_end?.({
    type: "agent_end",
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world", stopReason: "stop" },
    ],
  }, ctx);
  assert.equal(fake.calls.some((call) => call.name === "post_llm_call"), false);
  await fake.handlers.agent_settled?.({ type: "agent_settled", aborted: false }, ctx);
  await fake.handlers.session_shutdown?.({ type: "session_shutdown", reason: "quit" }, ctx);

  assert.deepEqual(fake.calls.map((call) => call.payload.session_id), [
    "manager-session-id", "manager-session-id", "manager-session-id", "manager-session-id",
  ]);
  assert.deepEqual(fake.calls.find((call) => call.name === "post_llm_call")?.payload, {
    session_id: "manager-session-id",
    user_message: "hello",
    assistant_response: "world",
    platform: "pi",
  });
  const shutdown = fake.calls.find((call) => call.name === "on_session_end")?.payload;
  assert.deepEqual(shutdown, { session_id: "manager-session-id", platform: "pi" });
  assert.equal(Object.hasOwn(shutdown ?? {}, "completed"), false);
  assert.equal(fake.closed(), 1);
});

test("duplicate startup for one session preserves first-prompt and pending-capture state", async () => {
  const fake = setup({ on_session_start: { context: "startup" } });
  const ctx = fake.ctx("same-session");
  await fake.handlers.session_start?.({ reason: "new" }, ctx);
  await fake.handlers.before_agent_start?.({ messageType: "user", prompt: "first" }, ctx);
  await fake.handlers.agent_end?.({ messages: [{ role: "assistant", content: "answer", stopReason: "stop" }] }, ctx);
  await fake.handlers.session_start?.({ reason: "new" }, ctx);
  await fake.handlers.agent_settled?.({ aborted: false }, ctx);
  await fake.handlers.before_agent_start?.({ messageType: "user", prompt: "second" }, ctx);

  assert.equal(fake.calls.filter(call => call.name === "on_session_start").length, 1);
  assert.equal(fake.messages.length, 1);
  assert.equal(fake.calls.filter(call => call.name === "post_llm_call").length, 1);
  assert.deepEqual(fake.calls.filter(call => call.name === "pre_llm_call").map(call => call.payload.is_first_turn), [true, false]);
  const next = fake.ctx("next-session");
  await fake.handlers.session_start?.({ reason: "new" }, next);
  await fake.handlers.before_agent_start?.({ messageType: "user", prompt: "new session" }, next);
  assert.equal(fake.calls.filter(call => call.name === "on_session_start").length, 2);
  assert.equal(fake.calls.filter(call => call.name === "pre_llm_call").at(-1)?.payload.is_first_turn, true);
});

test("concurrent startup notifications attempt initialization only once", async () => {
  let release!: (value: unknown) => void;
  const startup = new Promise(resolve => { release = resolve; });
  const fake = setup({ on_session_start: startup });
  const ctx = fake.ctx("concurrent-session");
  const first = fake.handlers.session_start?.({ reason: "new" }, ctx);
  const second = fake.handlers.session_start?.({ reason: "new" }, ctx);
  assert.equal(fake.calls.filter(call => call.name === "on_session_start").length, 1);
  release({ context: "startup" });
  await Promise.all([first, second]);
  assert.equal(fake.messages.length, 1);
});

test("startup without a usable session ID retains normal initialization behavior", async () => {
  for (const ctx of [{}, { sessionManager: { getSessionId: () => "" } }]) {
    const fake = setup();
    await fake.handlers.session_start?.({ reason: "startup" }, ctx);
    await fake.handlers.session_start?.({ reason: "new" }, ctx);
    assert.equal(fake.calls.filter(call => call.name === "on_session_start").length, 2);
  }
});

for (const reenable of [false, true]) {
  for (const hook of ["on_session_start", "pre_llm_call"] as const) {
    test(`${hook} discards awaited context after disabling${reenable ? " and reenabling" : ""}`, async () => {
      let release!: (value: unknown) => void;
      const fake = setup({ [hook]: new Promise(resolve => { release = resolve; }) });
      const ctx = fake.ctx("same-session");
      const result = hook === "on_session_start"
        ? fake.handlers.session_start?.({ reason: "startup" }, ctx)
        : fake.handlers.before_agent_start?.({ messageType: "user", prompt: "request" }, ctx);
      fake.control.setEnabled(false);
      if (reenable) fake.control.setEnabled(true);
      release({ context: "stale private memory" });
      assert.equal(await result, undefined);
      assert.deepEqual(fake.messages, []);
      await fake.handlers.agent_end?.({ messages: [{ role: "assistant", content: "answer", stopReason: "stop" }] }, ctx);
      await fake.handlers.agent_settled?.({ aborted: false }, ctx);
      assert.equal(fake.calls.filter(call => call.name === "post_llm_call").length, 0);
    });
  }
}

for (const boundary of ["replacement", "shutdown"] as const) {
  test(`${boundary} invalidates awaited startup and recall context`, async () => {
    for (const hook of ["on_session_start", "pre_llm_call"] as const) {
      let release!: (value: unknown) => void;
      const results = { [hook]: new Promise(resolve => { release = resolve; }) };
      const fake = setup(results);
      const ctx = fake.ctx("old-session");
      const result = hook === "on_session_start"
        ? fake.handlers.session_start?.({ reason: "startup" }, ctx)
        : fake.handlers.before_agent_start?.({ messageType: "user", prompt: "old" }, ctx);
      if (boundary === "shutdown") await fake.handlers.session_shutdown?.({}, ctx);
      else {
        results[hook] = Promise.resolve({ context: "" });
        await fake.handlers.session_start?.({}, fake.ctx("new-session"));
      }
      release({ context: "old session memory" });
      assert.equal(await result, undefined);
      assert.deepEqual(fake.messages, []);
    }
  });
}

test("off/on cannot resurrect capture, and the next prompt preserves first-turn consumption", async () => {
  const fake = setup();
  const ctx = fake.ctx("session");
  await fake.handlers.before_agent_start?.({ messageType: "user", prompt: "straddling" }, ctx);
  fake.control.toggle();
  await fake.handlers.agent_end?.({ messages: [{ role: "user", content: "disabled" }] }, ctx);
  fake.control.toggle();
  await fake.handlers.agent_end?.({ messages: [{ role: "assistant", content: "late answer", stopReason: "stop" }] }, ctx);
  await fake.handlers.agent_settled?.({ aborted: false }, ctx);
  assert.equal(fake.calls.filter(call => call.name === "post_llm_call").length, 0);
  await fake.handlers.before_agent_start?.({ messageType: "user", prompt: "fresh" }, ctx);
  await fake.handlers.agent_end?.({ messages: [{ role: "assistant", content: "fresh answer", stopReason: "stop" }] }, ctx);
  await fake.handlers.agent_settled?.({ aborted: false }, ctx);
  assert.deepEqual(fake.calls.filter(call => call.name === "pre_llm_call").map(call => call.payload.is_first_turn), [true, false]);
  assert.equal(fake.calls.filter(call => call.name === "post_llm_call").length, 1);
});

test("bridge failures fail open and shutdown still closes the bridge", async () => {
  const fake = setup({
    on_session_start: new Error("bridge unavailable"),
    pre_llm_call: new Error("bridge unavailable"),
    post_llm_call: new Error("bridge unavailable"),
    on_session_end: new Error("bridge unavailable"),
  });
  const ctx = fake.ctx("session-a");

  assert.equal(await fake.handlers.session_start?.({ type: "session_start", reason: "startup" }, ctx), undefined);
  assert.equal(await fake.handlers.before_agent_start?.({ type: "before_agent_start", messageType: "user", prompt: "hello" }, ctx), undefined);
  assert.equal(await fake.handlers.agent_end?.({ type: "agent_end", messages: [] }, ctx), undefined);
  assert.equal(await fake.handlers.session_shutdown?.({ type: "session_shutdown" }, ctx), undefined);
  assert.equal(fake.closed(), 1);
});
