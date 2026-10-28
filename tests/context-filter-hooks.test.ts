import assert from "node:assert/strict";
import test from "node:test";
import { bindHooks } from "../src/hooks.js";
import type { PiApi, PiBridgeConfig, PiContext } from "../src/types.js";
import type { TestEventHandler } from "./pi-test-helpers.js";

type Registry = NonNullable<PiContext["modelRegistry"]>;
type Model = Parameters<Registry["classify"]>[0];
type Request = Parameters<Registry["classify"]>[1];
type Result = Awaited<ReturnType<Registry["classify"]>>;
const model: Model = { type: "classifier", provider: "test", id: "decision", name: "Decision", api: "typesafe-system-one",
  baseUrl: "http://localhost", input: ["text"], contextWindow: 16000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const config: PiBridgeConfig = { icarusDir: "/tmp/icarus", python: "python3", fabricDir: "/tmp/fabric",
  agent: "pi-agent", projectId: "test", platform: "pi", bindHooks: true, registerTools: false,
  registerAdminTools: false, hiddenDisplay: true, footerStatus: "Icarus", callTimeoutMs: 30000, classifier: "default" };

function rejectAll(request: Request): Result {
  return { api: "typesafe-system-one", provider: "test", model: "decision", timestamp: 0, stopReason: "stop",
    answers: Object.fromEntries(Object.keys(request.questions).map(id => [id,
      { type: "choice", choice: "drop", probabilities: { keep: 0, drop: 1 }, confidence: 1 }])) };
}

function setup(run = async (request: Request, _signal?: AbortSignal): Promise<Result> => rejectAll(request)) {
  const handlers: Record<string, TestEventHandler> = {};
  const audit: unknown[] = [];
  const sent: unknown[] = [];
  const warnings: string[] = [];
  let classifications = 0;
  const pi: PiApi = { on(name, handler) { handlers[name] = handler; return () => {}; }, registerTool() {},
    appendEntry(customType, data) { audit.push({ customType, data }); }, sendMessage(message) { sent.push(message); } };
  const bridge = { async hook(name: string) { return { context: name === "on_session_start" ? "mandatory startup" : "irrelevant private memory" }; }, close() {} };
  const options = { ...config };
  const control = bindHooks(pi, bridge as never, options);
  const ctx: PiContext = { sessionManager: { getSessionId: () => "s1" }, ui: { notify: message => warnings.push(message) },
    modelRegistry: { async getAvailableOfType() { return [model]; }, async classify(_model: Model, request: Request, options?: { signal?: AbortSignal }) {
      classifications++;
      return run(request, options?.signal);
    } } as Registry };
  return { pi, options, handlers, audit, sent, warnings, control, ctx, classifications: () => classifications,
    start: () => handlers.before_agent_start({ messageType: "user", prompt: "work" }, ctx) };
}

test("hook filters automatically, preserves startup, and writes audit only via appendEntry", async () => {
  const fake = setup();
  // Real Pi contexts have lazy getters unrelated to filtering; do not spread them.
  Object.defineProperty(fake.ctx, "thinkingLevel", { enumerable: true, get() { throw new Error("Unbound runtime getter"); } });
  await fake.handlers.session_start({}, fake.ctx);
  assert.equal(fake.classifications(), 0);
  assert.deepEqual(fake.sent, [{ customType: "icarus-session-context", content: "mandatory startup", display: true }]);
  assert.equal(await fake.start(), undefined, "all irrelevant plain context is omitted");
  assert.equal(fake.classifications(), 1);
  assert.equal(fake.audit.length, 1);
  assert.equal(fake.sent.length, 1);
  const audit = fake.audit[0] as { customType: string; data: { injectedIds: string[]; decisions: unknown[] } };
  assert.equal(audit.customType, "icarus-context-filter");
  assert.deepEqual(audit.data.injectedIds, []);
  assert.equal(audit.data.decisions.length, 1);
  assert.ok(!JSON.stringify(fake.audit).includes("irrelevant private memory"));
});

test("none disables discovery/classification and leaves existing context/display unchanged", async () => {
  const fake = setup();
  fake.options.classifier = "none";
  fake.control.setContextVisible(false);
  assert.deepEqual(await fake.start(), { message: { customType: "icarus-memory-context", content: "irrelevant private memory", display: false } });
  assert.equal(fake.classifications(), 0);
  assert.deepEqual(fake.audit, []);
});

for (const auditFailure of ["missing", "throws"] as const) {
  test(`audit ${auditFailure} restores original text with an observable warning`, async () => {
    const fake = setup();
    if (auditFailure === "missing") fake.pi.appendEntry = undefined;
    else fake.pi.appendEntry = () => { throw new Error("disk failure"); };
    assert.deepEqual(await fake.start(), { message: { customType: "icarus-memory-context", content: "irrelevant private memory", display: true } });
    assert.equal(fake.warnings.length, 1);
    assert.deepEqual(fake.audit, []);
  });
}

for (const boundary of ["disable", "replace", "shutdown", "turn-abort"] as const) {
  test(`${boundary} cancels classification and prevents stale context and audit injection`, async () => {
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    let receivedSignal: AbortSignal | undefined;
    const fake = setup(async (_request, signal) => {
      receivedSignal = signal;
      started();
      return new Promise(() => {}); // Deliberately ignores cancellation.
    });
    const turn = new AbortController();
    fake.ctx.signal = turn.signal;
    const result = fake.start();
    await entered;
    if (boundary === "disable") { fake.control.setEnabled(false); fake.control.setEnabled(true); }
    if (boundary === "replace") await fake.handlers.session_start({}, { sessionManager: { getSessionId: () => "s2" } });
    if (boundary === "shutdown") await fake.handlers.session_shutdown({}, fake.ctx);
    if (boundary === "turn-abort") turn.abort();
    assert.equal(await result, undefined);
    assert.equal(receivedSignal?.aborted, true);
    assert.deepEqual(fake.audit, []);
  });
}

test("classifier timeout preserves original context and records the fallback", async () => {
  const fake = setup(async () => new Promise(() => {}));
  fake.options.classifierTimeoutMs = 10;
  const result = await fake.start();
  assert.deepEqual(result, { message: { customType: "icarus-memory-context", content: "irrelevant private memory", display: true } });
  assert.match(JSON.stringify(fake.audit), /timeout/);
});
