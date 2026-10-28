import assert from "node:assert/strict";
import test from "node:test";
import { filterContext, selectClassifier } from "../src/context-filter.js";
import type { PiContext } from "../src/types.js";

type Registry = NonNullable<PiContext["modelRegistry"]>;
type Model = Parameters<Registry["classify"]>[0];
type Request = Parameters<Registry["classify"]>[1];
type Result = Awaited<ReturnType<Registry["classify"]>>;

function model(id = "kev", baseUrl = "http://127.0.0.1:7484/v1", cost = 0): Model {
  return { type: "classifier", provider: "test", id, name: id, api: "typesafe-system-one", baseUrl,
    input: ["text"], contextWindow: 16384, cost: { input: cost, output: cost, cacheRead: 0, cacheWrite: 0 } };
}

function answer(request: Request, probabilities: number[] = []): Result {
  return { api: "typesafe-system-one", provider: "test", model: "kev", stopReason: "stop", timestamp: 0,
    answers: Object.fromEntries(Object.keys(request.questions).map((id, index) => {
      const p = probabilities[index] ?? 0;
      return [id, { type: "choice", choice: p > 0.5 ? "drop" : "keep", probabilities: { keep: 1 - p, drop: p }, confidence: Math.abs(2 * p - 1) }];
    })),
  };
}

function setup(run: (request: Request, signal?: AbortSignal) => Promise<Result> | Result = request => answer(request), models = [model()]) {
  const requests: Request[] = [];
  let discoveries = 0;
  const registry = {
    async getAvailableOfType() { discoveries++; return models; },
    async classify(_model: Model, request: Request, options?: { signal?: AbortSignal }) {
      requests.push(request);
      return run(request, options?.signal);
    },
  } as Registry;
  return { ctx: { modelRegistry: registry }, requests, discoveries: () => discoveries };
}

const config = { classifier: "default", classifierTimeoutMs: 1000 };

test("selection prefers loopback, then catalog price, then original order; explicit selection never substitutes", () => {
  const remote = model("remote", "https://api.example.org", 0);
  const expensive = model("local-expensive", "http://localhost:8080", 2);
  const cheap = model("local-cheap", "http://[::1]:8080", 1);
  assert.equal(selectClassifier([remote, expensive, cheap], "default"), cheap);
  assert.equal(selectClassifier([remote, model("paid", "https://api.example.org", 2)], "default"), remote);
  assert.equal(selectClassifier([cheap, model("tie", cheap.baseUrl, 1)], "default"), cheap);
  assert.equal(selectClassifier([cheap, remote], "test/remote"), remote);
  assert.equal(selectClassifier([cheap], "test/missing"), undefined);
  assert.equal(selectClassifier([cheap], "none"), undefined);
  const chat = { ...model("chat"), api: "llama-cpp-classify" as const };
  const native = model("native");
  assert.equal(selectClassifier([chat, native], "default"), native);
  assert.equal(selectClassifier([model("not-local", "https://localhost.evil.org"), cheap], "default"), cheap);
});

test("automatic batching removes only confidently irrelevant spans verbatim and retains multiline content", async () => {
  const text = "[fabric] relevant to your request:\n  [today] agent: useful\ncontinued details\n  [yesterday] agent: irrelevant\n\n[qdrant] knowledge base:\n  ### sqlite\n  useful query details\n\n[facts] durable facts about the user/environment:\n  - always keep me\n";
  const fake = setup(request => answer(request, [0, 0.99, 0.6]));
  const result = await filterContext(text, "fix sqlite", fake.ctx, config);
  assert.equal(fake.requests.length, 1);
  assert.equal(Object.keys(fake.requests[0].questions).length, 3);
  assert.equal(result.context, text.replace("  [yesterday] agent: irrelevant\n\n", ""));
  assert.equal(result.audit.decisions.filter(d => d.decision === "drop").length, 1);
  assert.ok(!JSON.stringify(result.audit).includes("irrelevant"));
  assert.ok(!JSON.stringify(result.audit).includes("useful query"));
  assert.ok(result.audit.model?.endsWith("/kev"));
});

test("all keeps preserve bytes including CRLF, whitespace, Unicode and generic paragraphs", async () => {
  const text = "# Background\r\nUseful 🪽 paragraph\r\n\r\nSecond paragraph\r\n";
  const fake = setup();
  assert.equal((await filterContext(text, "work", fake.ctx, config)).context, text);
});

test("unknown operational sections and facts never reach the classifier", async () => {
  const text = "[fabric] relevant to your request:\n  [today] agent: candidate\n\n[operations] required instructions:\nnever delete backups\n\n[facts] durable facts:\nkeep all facts";
  const fake = setup(request => answer(request, [1]));
  const result = await filterContext(text, "work", fake.ctx, config);
  assert.ok(result.context.includes("never delete backups"));
  assert.ok(result.context.includes("keep all facts"));
  assert.ok(!JSON.stringify(fake.requests).includes("never delete backups"));
  assert.ok(!JSON.stringify(fake.requests).includes("keep all facts"));
});

test("none, missing registry, missing exact model, and empty catalog preserve original", async () => {
  const fake = setup();
  assert.equal((await filterContext("memory", "work", fake.ctx, { classifier: "none" })).audit.fallback, "disabled");
  assert.equal(fake.discoveries(), 0);
  assert.equal((await filterContext("memory", "work", {}, config)).audit.fallback, "registry-unavailable");
  for (const [ctx, selection] of [[fake.ctx, "test/missing"], [setup(undefined, []).ctx, "default"]] as const) {
    const result = await filterContext("memory", "work", ctx, { classifier: selection });
    assert.equal(result.context, "memory");
    assert.equal(result.audit.fallback, "model-unavailable");
  }
  assert.equal(fake.requests.length, 0);
});

test("malformed, missing and low-confidence answers keep affected spans", async () => {
  for (const value of [undefined, { type: "bool", probability: 1 },
    { type: "choice", choice: "drop", probabilities: { keep: 0, drop: 1 }, confidence: 0.2 },
    { type: "choice", choice: "drop", probabilities: { keep: 0, drop: 2 }, confidence: 1 },
    { type: "choice", choice: "drop", probabilities: { keep: 0.4, drop: 0.99 }, confidence: 1 },
    { type: "choice", choice: "keep", probabilities: { keep: 0, drop: 1 }, confidence: 1 },
  ]) {
    const fake = setup(request => ({ ...answer(request), answers: { [Object.keys(request.questions)[0]]: value } } as Result));
    assert.equal((await filterContext("memory", "work", fake.ctx, config)).context, "memory");
  }
});

test("provider errors and exceptions preserve original without leaking raw errors into audit", async () => {
  for (const run of [
    () => { throw new Error("secret-memory-in-error"); },
    (request: Request) => ({ ...answer(request), stopReason: "error", errorMessage: "secret-memory-in-error" } as Result),
  ]) {
    const result = await filterContext("memory", "work", setup(run).ctx, config);
    assert.equal(result.context, "memory");
    assert.ok(result.audit.fallback);
    assert.ok(!JSON.stringify(result.audit).includes("secret-memory"));
  }
});

test("deadline bounds discovery even when provider ignores cancellation", async () => {
  const ctx = { modelRegistry: { getAvailableOfType: () => new Promise(() => {}), classify: () => { throw new Error("unexpected"); } } as Registry };
  const result = await filterContext("memory", "work", ctx, { ...config, classifierTimeoutMs: 10 });
  assert.equal(result.context, "memory");
  assert.equal(result.audit.fallback, "timeout");
});

test("deadline aborts classification; late results cannot change returned context or decisions", async () => {
  let release!: (result: Result) => void;
  let signal: AbortSignal | undefined;
  const fake = setup((_request, currentSignal) => {
    signal = currentSignal;
    return new Promise(resolve => { release = resolve; });
  });
  const result = await filterContext("memory", "work", fake.ctx, { ...config, classifierTimeoutMs: 10 });
  assert.equal(result.context, "memory");
  assert.equal(result.audit.fallback, "timeout");
  assert.equal(signal?.aborted, true);
  release(answer(fake.requests[0], [1]));
  await Promise.resolve();
  assert.deepEqual(result.audit.decisions, []);
});

test("already aborted turn never starts discovery", async () => {
  const fake = setup();
  const controller = new AbortController();
  controller.abort();
  const result = await filterContext("memory", "work", { ...fake.ctx, signal: controller.signal }, config);
  assert.equal(result.audit.fallback, "aborted");
  assert.equal(fake.discoveries(), 0);
});

test("budgets preserve oversized prompt/context/chunks and unclassified tail", async () => {
  const fake = setup(request => answer(request, Array(12).fill(1)));
  for (const [text, prompt] of [["x".repeat(64001), "work"], ["memory", "p".repeat(4001)]]) {
    const result = await filterContext(text, prompt, fake.ctx, config);
    assert.equal(result.context, text);
    assert.equal(result.audit.fallback, "input-budget");
    assert.deepEqual(result.audit.retainedIds, [`span:0:${text.length}`]);
  }
  assert.equal(fake.requests.length, 0);
  const oversized = "x".repeat(2001);
  const result = await filterContext(oversized + "\n\n" + Array.from({ length: 20 }, (_, i) => `- chunk ${i}\n`).join(""), "work", fake.ctx, config);
  assert.ok(result.context.startsWith(oversized));
  assert.ok(result.context.includes("- chunk 19"));
  assert.equal(result.audit.candidateIds.length, 12);
});

test("reported classifier usage is persisted in audit, without candidate contents", async () => {
  const usage = { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const result = await filterContext("private candidate", "private prompt", setup(request => ({ ...answer(request), usage })).ctx, config);
  assert.deepEqual(result.audit.usage, usage);
  assert.ok(!JSON.stringify(result.audit).includes("private"));
});
