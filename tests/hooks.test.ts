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
  const handlers: Record<string, (...args: unknown[]) => unknown> = {};
  const calls: HookCall[] = [];
  const messages: Array<{
    message: { customType: string; content: string; display: boolean };
    options?: { triggerTurn?: boolean };
  }> = [];
  let closeCount = 0;
  const pi: PiApi & {
    sendMessage: (message: { customType: string; content: string; display: boolean }, options?: { triggerTurn?: boolean }) => void;
  } = {
    on(event: string, handler: (...args: unknown[]) => unknown) { handlers[event] = handler; },
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
  const event = (prompt: string) => ({ type: "before_agent_start", prompt });

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
  await fake.handlers.before_agent_start?.({ type: "before_agent_start", prompt: "hello" }, ctx);
  await fake.handlers.agent_end?.({
    type: "agent_end",
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ],
  }, ctx);
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

test("bridge failures fail open and shutdown still closes the bridge", async () => {
  const fake = setup({
    on_session_start: new Error("bridge unavailable"),
    pre_llm_call: new Error("bridge unavailable"),
    post_llm_call: new Error("bridge unavailable"),
    on_session_end: new Error("bridge unavailable"),
  });
  const ctx = fake.ctx("session-a");

  assert.equal(await fake.handlers.session_start?.({ type: "session_start", reason: "startup" }, ctx), undefined);
  assert.equal(await fake.handlers.before_agent_start?.({ type: "before_agent_start", prompt: "hello" }, ctx), undefined);
  assert.equal(await fake.handlers.agent_end?.({ type: "agent_end", messages: [] }, ctx), undefined);
  assert.equal(await fake.handlers.session_shutdown?.({ type: "session_shutdown" }, ctx), undefined);
  assert.equal(fake.closed(), 1);
});
