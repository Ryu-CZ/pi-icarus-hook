# Automatic context relevance filter

Part of the [technical vision & developer guide](../VISION.md). This document
owns the classifier-specific algorithm and contracts.

All implementation and settings live in `pi-icarus-hook`. No external
Hermes/Icarus files, Pi core settings, or global instructions are modified.
The extension still calls the configured Python `pre_llm_call` exactly once.
It filters the returned text, not backend entries or retrieval sources.

## Flow

```text
user prompt -> original Icarus retrieval -> { context: string }
            -> exact text spans -> native Pi classifier -> retained text -> Pi
```

Startup context bypasses filtering entirely. Explicit Fabric tool results are
also unchanged. The feature runs automatically before user runs, not through
assistant tool calls or user confirmation dialogs.

## Configuration

Under `piIcarusHook` (same project-trust/precedence rules as existing settings):

- `classifier: "default"` (default): discover text-capable classifiers from
  `ctx.modelRegistry.getAvailableOfType("classifier")`. Prefer loopback-local
  endpoints, then lowest catalog input + output price, then native classifiers
  over `llama-cpp-classify` chat adapters, then registry order.
- `classifier: "none"`: original injection, without classifier discovery/calls.
- `classifier: "provider/model-id"`: exact discovered selection, no substitution.
  Example: `llama.cpp/Kev-4B-Artemis`. No endpoint is hardcoded in this package.
- `classifierTimeoutMs: 5000`: total discovery + classification deadline.

Local detection means HTTP(S) hostname `localhost`, `127.0.0.1`, or `::1`, not
provider name. A remote llama.cpp server is remote. Registry availability means
credentials/catalog availability, not guaranteed endpoint health. Discovery does
not force a registry refresh or change the user's model configuration.

**Default selection can use a remote provider**, sharing the prompt/candidate
text and incurring cost. Pin an exact local classifier to prevent remote
fallback. Prices are catalog estimates; zero can mean unknown price. Reload or
restart Pi after changing settings. An older Pi without classifier APIs keeps
the original memory context.

## Text policy

Spans are contiguous original UTF-16 string ranges, split at paragraph, heading,
and list/result-line boundaries. Multiline continuations stay with their span.
This is intentionally not a parser claiming to recover backend memory objects.

Top-level bracketed Fabric relevance, Qdrant knowledge, and prior-session
sections allow filtering of their bodies. Their headings are always retained.
Facts and unrecognized bracketed sections are protected in their entirety.
Markdown headings are retained. Plain text without a bracketed section can
also be classified. Classifier instructions require keeping instructions,
constraints, assigned tasks, durable facts, dependencies, and uncertain text.
Only recognized section protection and startup bypass are deterministic;
semantic protection inside arbitrary plain text remains probabilistic.

One classifier request asks one keep/drop question per candidate, sharing the
prompt and candidate spans as untrusted data. Drop requires a valid choice of
`drop`, probability at least 0.95, and confidence at least 0.9. Missing, malformed,
contradictory, or uncertain answers keep the affected span. A provider error or
request timeout keeps the whole original response. Kept slices retain exact
bytes when encoded back to UTF-8; no paraphrasing or model-generated replacement
text is injected. Empty headings may remain after all their body spans drop.

Limits per response:

- 64,000 context characters and 4,000 prompt characters; exceeding either skips
  filtering entirely, without truncating injection.
- At most 12 candidates, each at most 2,000 characters; larger spans remain.
- At most 12,000 candidate text + heading characters, plus prompt/question
  instructions. Unclassified tail/excess spans remain unchanged.
- One model request; the provider may evaluate its questions sequentially.
- Deadline includes discovery and classification; abort signals are forwarded,
  and a local promise deadline still releases Pi if a provider ignores abort.
  Remote work/charges can outlive cancellation when the provider ignores it.

Disabling hooks, ending/replacing the session, or cancelling the turn cancels
pending classification and prevents stale context/audit injection. Classifier
error strings are not persisted because they can contain text or credentials.

## Audit and usage

`pi.appendEntry("icarus-context-filter", ...)` stores non-context session data:
selection, resolved model, candidate IDs, keep/drop decisions and drop
probabilities, retained/injected IDs, input/output character counts, latency,
reported usage, and fallback codes. IDs are synthetic `span:start:end` offsets
within that response, **not Fabric/Qdrant/session IDs**. Early budget fallbacks
identify the whole original span. IDs are scoped to their audit entry.

`injectedIds` records the spans handed back to Pi for injection, not proof of
model consumption or persistence by later handlers. Audit contains no prompt,
headings, memory contents, or rejected text. Existing Python telemetry is
unchanged and may record retrieval independently of this extension.

Reported usage is saved separately in the audit; native registry calls do not
automatically add it to Pi's main-model/session/footer totals. Missing usage is
unknown, not zero, particularly after timeout. Audit persistence failure keeps
the original context and emits a UI warning where notifications are supported.
The extension does not discard text without a decision trail.

## Accepted limitations

Relevance is not truth, freshness, instruction safety, or a guarantee against
false rejection. Splitting can separate related prose; conservative labels,
shared candidate context, retained headings, and keeping oversized spans reduce
rather than eliminate that risk.

Some Icarus installations mark returned memories injected before returning.
This extension does not alter that state: rejected text may not be offered
again later. It neither reconstructs IDs nor replays rejected memories.
Upstream and locally customized retrieval pipelines can differ; filtering does
not replace either pipeline with Fabric-only `state.recall`.

## Verification

`npm test` includes classifier selection/chunk/fallback/budget/usage tests,
hook startup/display/audit/cancellation tests, and real Pi runner compatibility.
Existing Python integration tests require the configured Icarus Python environment
(including PyYAML); see the [developer verification instructions](../VISION.md#verification).

A native Kev smoke check used a request generated by the actual filter, retained
SQLite troubleshooting text, removed unrelated cake text, and preserved facts.
This checks the API/prompt path, not universal classifier accuracy.
