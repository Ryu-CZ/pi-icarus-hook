import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.js";
import { bindHooks } from "../src/hooks.js";
import { loadConfig } from "../src/config.js";
import type { PiContext } from "../src/types.js";

// Compile the public factory against the real host contract, not the test doubles.
const factory: ExtensionFactory = extension;

// Internal runner seams are pinned to the Pi development dependency.
const core = new URL("./core/", import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createExtensionRuntime, loadExtensionFromFactory, loadExtensions } = await import(new URL("extensions/loader.js", core).href);
const { ExtensionRunner, emitSessionShutdownEvent } = await import(new URL("extensions/runner.js", core).href);
const { SessionManager } = await import(new URL("session-manager.js", core).href);
const { createEventBus } = await import(new URL("event-bus.js", core).href);

test("Pi loads the source extension and accepts its public factory", async () => {
  assert.equal(factory, extension);
  const path = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
  const loaded = await loadExtensions([path], process.cwd());
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  assert.ok(loaded.extensions[0].handlers.has("session_shutdown"));
});

test("real Pi dispatch recalls user context and captures only successful final settlement", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let closed = 0;
  const bridge = {
    async hook(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return { context: name === "pre_llm_call" ? "remembered context" : "" };
    },
    close() { closed++; },
  };
  const runtime = createExtensionRuntime();
  const loaded = await loadExtensionFromFactory(
    (pi: Parameters<ExtensionFactory>[0]) => { bindHooks(pi, bridge as never, loadConfig()); },
    process.cwd(), createEventBus(), runtime, "icarus",
  );
  const manager = SessionManager.inMemory(process.cwd());
  const runner = new ExtensionRunner([loaded], runtime, process.cwd(), manager, {});
  const errors: unknown[] = [];
  runner.onError((error: unknown) => errors.push(error));
  const start = () => runner.emitBeforeAgentStart(
    { messageType: "user", prompt: "request", images: undefined },
    { cwd: process.cwd(), sections: { unrelated: "preserved" } },
  );
  const assistant = (text: string, stopReason = "stop") => ({ role: "assistant", content: [{ type: "text", text }], stopReason });
  const captures = () => calls.filter(call => call.name === "post_llm_call");
  try {
    await runner.emit({ type: "session_start", reason: "startup" });
    const result = await start();
    assert.equal(result.messages[0].content, "remembered context");
    assert.equal(result.systemPromptOptions.sections.unrelated, "preserved");
    await runner.emit({ type: "agent_end", messages: [{ role: "user", content: "request" }, assistant("intermediate")] });
    assert.equal(captures().length, 0);
    await runner.emit({ type: "agent_end", messages: [{ role: "user", content: "queued" }, assistant("final")] });
    await runner.emit({ type: "agent_settled", aborted: false });
    assert.equal(captures().length, 1);
    assert.equal(captures()[0].args.assistant_response, "final");
    assert.equal(captures()[0].args.user_message, "request\n\nqueued");
    for (const [aborted, stopReason] of [[true, "stop"], [false, "error"], [false, "length"]]) {
      await start();
      await runner.emit({ type: "agent_end", messages: [assistant("incomplete", stopReason as string)] });
      await runner.emit({ type: "agent_settled", aborted });
    }
    const recalls = calls.filter(call => call.name === "pre_llm_call").length;
    await runner.emitBeforeAgentStart({ messageType: "custom", message: {
      role: "custom", customType: "automation", content: "automated request", display: false, timestamp: 1,
    } }, { cwd: process.cwd(), sections: {} });
    await runner.emit({ type: "agent_end", messages: [assistant("automated response")] });
    await runner.emit({ type: "agent_settled", aborted: false });
    assert.equal(captures().length, 1);
    assert.equal(calls.filter(call => call.name === "pre_llm_call").length, recalls);
  } finally {
    await emitSessionShutdownEvent(runner, { type: "session_shutdown", reason: "exit" });
    runner.invalidate();
  }
  assert.equal(closed, 1);
  assert.deepEqual(errors, []);
});

test("real Pi dispatch persists classifier audit outside model context", async () => {
  const runtime = createExtensionRuntime();
  const manager = SessionManager.inMemory(process.cwd());
  runtime.appendEntry = (customType: string, data: unknown) => manager.appendCustomEntry(customType, data);
  const bridge = { async hook() { return { context: "useful context\n\nrejected private context" }; }, close() {} };
  const loaded = await loadExtensionFromFactory(
    (pi: Parameters<ExtensionFactory>[0]) => { bindHooks(pi, bridge as never, { ...loadConfig(), classifier: "default" }); },
    process.cwd(), createEventBus(), runtime, "icarus-filter",
  );
  type Registry = NonNullable<PiContext["modelRegistry"]>;
  const registry = {
    async getAvailableOfType() { return [{ provider: "test", id: "classifier", api: "typesafe-system-one", baseUrl: "http://localhost", input: ["text"] }]; },
    async classify(_model: unknown, request: Parameters<Registry["classify"]>[1]) {
      return { stopReason: "stop", answers: Object.fromEntries(Object.keys(request.questions).map((id, index) => [id,
        { type: "choice", choice: index ? "drop" : "keep", probabilities: { keep: index ? 0 : 1, drop: index ? 1 : 0 }, confidence: 1 }])) };
    },
  };
  const runner = new ExtensionRunner([loaded], runtime, process.cwd(), manager, registry);
  try {
    const result = await runner.emitBeforeAgentStart(
      { messageType: "user", prompt: "request", images: undefined },
      { cwd: process.cwd(), sections: {} },
    );
    assert.equal(result.messages[0].content, "useful context\n\n");
    const entries = manager.getEntries().filter((entry: { type: string }) => entry.type === "custom");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].customType, "icarus-context-filter");
    assert.equal(entries[0].data.decisions.length, 2);
    assert.equal(entries[0].data.injectedIds.length, 1);
    assert.ok(!JSON.stringify(entries).includes("rejected private context"));
    assert.deepEqual(manager.buildSessionContext().messages, [], "audit custom entries never enter model context");
  } finally {
    await emitSessionShutdownEvent(runner, { type: "session_shutdown", reason: "exit" });
    runner.invalidate();
  }
});
