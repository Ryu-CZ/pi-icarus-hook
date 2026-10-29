# Technical vision & developer guide

## Purpose

Make Pi a reliable participant in an existing Hermes/Icarus memory system:
retrieve context automatically, capture useful completed exchanges, and expose
the ordinary Fabric tools. Keep the adapter small enough to understand and safe
to disable without disrupting the coding session.

The [README](README.md) is the user manual. This document records current
architecture, technical decisions, and contributor guidance—not a speculative
roadmap. The [classifier specification](docs/kev-memory-filter.md) owns its
algorithm, limits, and audit format; [CHANGELOG.md](CHANGELOG.md) owns release history.

## Ownership and non-goals

**Pi calls Icarus; Icarus owns memory retrieval and storage.**

| Owner | Responsibilities |
|---|---|
| Pi | Session lifecycle, project trust, model registry/authentication, model context, UI and session persistence |
| This extension | Lifecycle adaptation, local Python transport, optional relevance filtering, tool exposure, settings and decision audits |
| Installed Icarus plugin | Retrieval sources, ranking, deduplication, capture, persistence, telemetry and backend operations |

All adapter implementation belongs in this repository. Do not patch external
Hermes/Icarus files, monkey-patch backend internals, add Pi core defaults, or require
machine-specific paths/models. The Python plugin is **not bundled here**; the
worker loads the configured installation. Upstream and customized installations
can offer different retrieval sources.

This is not a direct Memory OS infrastructure client, an Icarus replacement,
or an orchestration/admin console. Intentionally absent surfaces include raw
Qdrant search, Redis queues, worker health controls, ingestion/reflection retry
controls, ground-truth editing, and last-injected-context inspection. New
low-level administration belongs in a separate optional extension rather than
expanding the default coding-session toolset.

## Design decisions

These are the current decisions and their rationale, captured together rather
than presented as an invented historical log. Preserve their consequences when
refactoring; update the decision and its tests when intentionally changing one.

| Decision | Why | Consequence |
|---|---|---|
| Adapt Icarus instead of reimplementing retrieval | Preserve the configured backend's behavior across installations | Do not replace the hook with Fabric-only `state.recall()` or silently drop sources |
| Keep one persistent Python worker per bridge | Icarus uses module globals for session state, exchanges and deduplication | Per-call Python processes would break semantics; worker loss requires reinitialization |
| Capture at final settlement, not each agent run | Retries and continuations can produce several `agent_end` events | Buffer intermediate results; write only a successful, non-aborted final response |
| Gate project settings on Pi trust | Settings can select an executable and imported Python package | No project settings may influence startup before trust is granted |
| Filter returned text, not reconstructed memories | The hook returns a string without a universal structured candidate contract | Use exact spans, preserve uncertainty, accept existing backend deduplication limitations |
| Use Pi's native classifier registry | Credentials/model discovery already belong to the harness | No separate endpoint configuration, global classifier setting, or hardcoded Kev dependency |
| Keep audit separate from model context | Rejected memories must not leak back through diagnostics | Use `appendEntry`, never a model-visible audit message |
| Never replay failed worker operations automatically | A timed-out write may already have changed external state | Surface an indeterminate outcome; inspect before retrying |
| Hide admin tools by default | Routine memory access should not expose training/model-switch controls | Admin tools require explicit configuration |

## Architecture and code map

```text
Pi session / user run
  -> hooks.ts
    -> bridge.ts -> worker-code.ts -> configured icarus.hooks
    <- { context: string }
    -> context-filter.ts -> Pi classifier registry (optional)
    -> selected text returned to Pi
    -> non-context session audit

Pi explicit Fabric tool
  -> tools.ts -> bridge.ts -> configured icarus.tools
  <- Pi tool result (errors remain errors)
```

The diagram shows logical responsibilities, not persistence ordering: the audit
must be appended successfully before filtered text is returned for injection.
Startup context bypasses filtering; explicit tool results are not filtered.

| File | Responsibility |
|---|---|
| `src/index.ts` | Extension factory, trust-aware initialization, module wiring, public exports and process cleanup |
| `src/hooks.ts` | Startup/injection/capture lifecycle, pending exchanges, cancellation generations, footer status and audit handoff |
| `src/context-filter.ts` | Exact text spans, bounded candidate selection, native model selection, classification request/decision validation, deadlines and audit data |
| `src/bridge.ts` | Persistent subprocess, JSON-lines request IDs, pending calls, environment preparation, cancellation and worker retirement |
| `src/worker-code.ts` | Embedded Python transport; exact package import and dispatch, not a copy of Icarus retrieval logic |
| `src/config.ts` | Effective configuration, defaults, trusted-project/global precedence, external runtime paths and identity |
| `src/config-schema.ts` | Settings introspection and `/icarus` command handling |
| `src/settings.ts` | Scoped settings inspection and locked read-modify-write persistence |
| `src/tools.ts` | Fabric schemas, write validation, normal/admin registration and Pi error-result translation |
| `src/types.ts` | Shared adapter contracts and the Pi API subset used by this package |

Keep lifecycle policy separate from transport and classification. Prefer small,
named functions for distinct steps; add a file when it separates a cohesive
responsibility, not merely to reduce line count. Do not create namespace wrappers
or generalized frameworks around a single use. Pi contexts have lazy getters:
read only the fields needed rather than spreading the entire context object.

## Lifecycle contract

Factories also run before project trust and in configuration-only invocations.
Register read-only inspection there; do not launch a worker or read project
settings there. Initialize the bridge/hooks/tools from `session_start` after
checking `ctx.isProjectTrusted()`. The worker itself starts lazily on the first call.

Pi snapshots event handlers during dispatch. Newly registered startup hooks
therefore need an explicit initial call; deduplicate a repeated startup for the
same known session ID. Unknown IDs cannot safely be deduplicated.

| Pi event | Adapter behavior |
|---|---|
| `session_start` | Reset per-session pending state; call `on_session_start`; send nonempty startup context without triggering an extra model turn |
| `before_agent_start` | Only for nonempty user prompts: call `pre_llm_call`, optionally filter, then return memory context; skip custom-triggered runs |
| `agent_end` | Buffer user messages and the latest assistant response across retries/continuations; do not capture yet |
| `agent_settled` | Call `post_llm_call` once for an enabled, non-aborted run whose final assistant has `stopReason: "stop"` and nonempty text |
| `session_shutdown` | Invalidate pending work, call `on_session_end` if enabled, clear footer status and close the worker even if the hook fails |

The first eligible prompt is marked `is_first_turn`; empty or disabled prompts
do not consume it. Queued user messages are grouped for final capture; fall back
to the original prompt if none were observed in completed runs.

Disabling hooks clears pending capture and invalidates in-flight results. Turning
hooks back on must not revive them. Check the generation after awaited retrieval
and classification. Session replacement/shutdown also invalidates results;
classification additionally honors the turn abort signal. Disabling hooks is not
a rollback of backend work already started.

Use Pi's status API under the `icarus` key; do not replace the user's footer.
`contextDisplay` controls message visibility, **not** whether the model receives
it. `/icarus off` stops automatic loading/saving, not explicit registered tools,
already-injected context, or external memory storage.

## Transport, failure and security contracts

Requests are newline-delimited JSON with unique IDs, target module/function,
arguments and keyword arguments. The worker imports the exact configured Icarus
package and processes requests sequentially. JSON stdout is the protocol;
Python prints are redirected to stderr. Backend JSON-looking strings are
normalized into structured responses when parseable.

The worker removes the current-directory import entry before importing even
standard-library modules. The bridge excludes empty, relative, and current-project
`PYTHONPATH` entries while preserving other absolute dependency paths. This
mitigates project-code shadowing; it is not a sandbox. The selected Python program
and plugin run with the user's permissions and must be trusted.

| Failure | Required behavior |
|---|---|
| Ambient backend hook error | Let Pi continue; omit unavailable context/capture rather than fail the user run |
| Explicit tool error | Propagate failures; a returned Icarus `error` envelope becomes Pi `isError: true` |
| Worker timeout or submitted-call cancellation | Retire/kill that worker and reject **all** pending calls so queued mutations cannot execute later |
| Worker crash/exit | Reject pending work and discard worker state; never silently retry |
| Classifier missing/error/timeout | Preserve original returned context; this does not restart the Python worker |
| Audit persistence failure | Keep original context and attempt a warning; do not discard text without a decision trail |

Worker operations may have changed external state before termination. Check
before retrying a write. The next explicit bridge call can create a new worker,
but it does not replay session initialization or recover previous exchanges.
Restart the Pi session to fully initialize memory after worker loss.

## Classifier, privacy and audit contract

Filtering is automatic in `before_agent_start` when `classifier` is not `none`.
It uses the native registry, not assistant-invoked codemode/tool calls. Keep
startup context, recognized fact sections and unknown bracketed operational
sections outside relevance decisions. Retained text must come from exact original
slices; never summarize or rewrite it with generated text.

`default` prefers local models but can select a configured remote provider.
That can disclose the current prompt/candidate context to that provider and incur
charges. Exact selection must not substitute another model when unavailable.
Locality is determined from loopback endpoint hostnames, not provider names.

Classifier confidence does not establish truth, freshness or instruction safety.
Some backends already consider returned context injected, so filtered text may
not be offered again. Do not claim to reconstruct backend IDs or fix that state.

Audit through `pi.appendEntry("icarus-context-filter", ...)`; never include raw
prompts, retained/rejected contents, or provider error strings. Synthetic span
IDs are local to the audit entry. `injectedIds` means handed back to Pi, not proven
model consumption. Reported classifier usage lives in that audit, separately
from main-model/footer totals; unavailable usage is unknown, not zero.

See the [classifier specification](docs/kev-memory-filter.md) for selection order,
thresholds, input limits, cancellation behavior and the complete audit contract.
Keep those details there rather than maintaining competing numeric defaults here.

## Configuration reference

### Resolution and trust

Use the `piIcarusHook` section in Pi settings. `pi-icarus-hook` and `icarusHook`
are accepted section aliases, in that order after the canonical name.

1. Trusted project: `.pi/settings.json`.
2. Global: `${PI_CODING_AGENT_DIR:-~/.pi/agent}/settings.json`.
3. Built-in defaults.

Project settings are ignored unless Pi grants project trust. Extension behavior
is Pi-settings-only; external environment variables configure backend paths and
identity, not UI/hooks/tools/classification. Supported environment values override
their corresponding path/identity settings. Configuration loading tolerates
unreadable/invalid settings files; explicit settings writes reject malformed JSON
instead of replacing it.

### Extension settings

| Key | Default | Purpose / accepted alias |
|---|---|---|
| `platform` | `pi` | Platform label passed to Icarus |
| `hooks` | `true` | Register lifecycle hooks; alias `bindHooks` |
| `tools` | `true` | Register normal Fabric tools and config-inspection tool; alias `registerTools` |
| `adminTools` | `false` | Add admin tools when tools are enabled; alias `registerAdminTools` |
| `timeoutMs` | `30000` | Per-worker-call timeout; alias `callTimeoutMs` |
| `classifier` | `default` | Automatic selection, `none`, or exact `provider/model-id` |
| `classifierTimeoutMs` | `5000` | Total discovery/classification deadline |
| `contextDisplay` | `true` | Show injected messages; legacy alias `hiddenDisplay` has the same semantics, not inverted |
| `footerStatus` | `🪽 Icarus` | Status text; alias `statusLabel` |

Boolean values accept `false`, `0`, `no`, `off`, and `disabled` as false.
Reload/restart after editing configuration. Session commands do not mutate saved
defaults unless the command explicitly contains `context default`.

### Backend paths and identity

| Setting | Environment override | Fallback |
|---|---|---|
| `icarusDir` | `ICARUS_DIR` | `plugins/icarus` under Hermes home, otherwise `~/.hermes/plugins/icarus` |
| `python` | `ICARUS_PYTHON` | `python3` |
| `hermesHome` | `HERMES_HOME` | `~/.hermes` when present |
| `fabricDir` | `FABRIC_DIR` | `~/fabric` |
| `agent` | `HERMES_AGENT_NAME`, then `FABRIC_AGENT` | Suffix of `.hermes-<agent>` home, otherwise `pi-agent` |
| `projectId` | `FABRIC_PROJECT_ID` | Current directory name |
| `stateDbPath` | `STATE_DB_PATH`, then `HERMES_STATE_DB` | Unset; backend decides |

`icarusDir`, `hermesHome`, and `fabricDir` expand `~/` and resolve relative settings
paths against the containing settings directory. Path-valued `python` and
`stateDbPath` are resolved against the caller's working directory by the bridge.
Legacy field/Fabric configuration aliases are retained in `src/config.ts`.
Use the Python environment with the installed plugin's dependencies.

A complete common configuration example:

```json
{
  "piIcarusHook": {
    "icarusDir": "~/.hermes/plugins/icarus",
    "hermesHome": "~/.hermes",
    "fabricDir": "~/fabric",
    "python": "/path/to/icarus/.venv/bin/python",
    "agent": "pi-agent",
    "platform": "pi",
    "hooks": true,
    "tools": true,
    "adminTools": false,
    "timeoutMs": 30000,
    "classifier": "default",
    "classifierTimeoutMs": 5000,
    "contextDisplay": true,
    "footerStatus": "🪽 Icarus"
  }
}
```

The Python path is illustrative, not a required machine layout. Omit values
already supplied by the standard layout or runtime environment.

### Commands and persistence

| Command | Contract |
|---|---|
| `/icarus`, `/icarus toggle` | Toggle automatic hooks in this session |
| `/icarus on`, `/icarus off`, `/icarus status` | Enable, disable, inspect; `enable`/`disable` are aliases |
| `/icarus context` | Toggle display for this session |
| `/icarus context show`, `hide`, `status` | Control/inspect display; visibility and on/off aliases are accepted |
| `/icarus context default show`, `hide`, `toggle`, `status` | Save/inspect the future-session default; current visibility is unchanged |
| `/icarus context default hide project` | Write trusted project settings; `local` is an alias |
| `/icarus context default hide global` | Write global settings; `user` is an alias |
| `/icarus config`, `/icarus schema` | Read-only effective configuration or supported schema |

Without an explicit scope, default writes use the existing project setting,
otherwise the existing global setting, otherwise global. Untrusted sessions can
only use global settings. A scoped toggle flips that scope's own value, not the
currently effective value from a different scope. Global writes warn about project
overrides. Invalid commands/scopes/extra arguments must not write settings.

`src/settings.ts` holds the same `proper-lockfile` lock convention used by Pi
across the full read-modify-write. Preserve unrelated settings and existing
section aliases; refuse to overwrite broken JSON. `/icarus context default ...`
is the explicit settings-writing surface. The exported `CONFIG_SCHEMA`,
`configInspection`, `configSnippet`, and `icarus_hook_config` tool are read-only.

## Tool surface

The agent can call these explicitly even when automatic hooks are off. Normal
tools are registered when `tools` is enabled; admin tools additionally require
`adminTools: true`. Do not silently change tool names or broaden default exposure.

| Normal tool | Responsibility |
|---|---|
| `fabric_write` | Persist a Fabric entry; normalize verification metadata and require nonempty evidence when verified is true |
| `fabric_recall` | Ranked Fabric retrieval; accepts query, result count, agent and project |
| `fabric_search` | Literal search; do not advertise a limit the backend handler does not forward |
| `fabric_pending` | Pending work/reviews, optionally by customer |
| `fabric_curate` | Change an entry's training value |
| `fabric_brief` | Operational brief |
| `fabric_init_obsidian` | Initialize Fabric daily/Obsidian support |
| `icarus_hook_config` | Inspect the extension configuration/schema |

`fabric_write` descriptions require actual verification plus `evidence` and
`source_tool`; adapter validation enforces nonempty evidence for `verified=true`
and normalizes accepted boolean/string/number inputs to the backend's string
contract. Do not represent unverified work as verified.

Admin tools: `fabric_report`, `fabric_telemetry`, `fabric_export`, `fabric_train`,
`fabric_train_status`, `fabric_models`, `fabric_eval`, `fabric_switch_model`, and
`fabric_rollback_model`. These delegate corpus health, telemetry, training/export,
evaluation and model switching/rollback to the installed Icarus implementation.

## Local development

Requires Node.js 22+ and Python for bridge tests. The development dependency pins
Pi 1.4.0 and real-loader/runner tests verify that host contract; the wildcard peer
dependency is not a guarantee of every Pi version. Missing classifier APIs fall
back to unchanged context rather than making optional classification mandatory.

```bash
npm ci
npm run build
npm test

# Load just this checkout, not another installed copy:
pi --no-extensions -e ./src/index.ts

# One-shot manual integration check:
pi --no-extensions -e ./src/index.ts -p "What is the last project we worked on?"
```

Pi loads TypeScript source directly. `package.json` declares `src/index.ts` as
the Pi extension and the banner URL as its gallery image. Compiled package imports
and declarations use `dist/src/index.js` and `dist/src/index.d.ts`. Keep source,
compiled exports, and documentation available in the package allowlist.
Avoid loading this checkout alongside an npm-installed copy: duplicate tool
registration is not a valid integration test.

### Verification

`npm test` builds, then runs `dist/tests/*.test.js`. `npm run verify` aliases it;
`npm run smoke:icarus` builds and runs the backend smoke suite. For a particular
suite, build first and use `node --test dist/tests/<name>.test.js`.

Backend integration needs the installed Icarus checkout and its Python environment:

```bash
ICARUS_DIR=/path/to/icarus \
ICARUS_PYTHON=/path/to/icarus/.venv/bin/python npm test
```

Smoke tests default to `~/.hermes/plugins/icarus` and `python3`; unlike extension
startup, they do not read Pi settings. Include PyYAML in that environment: without
it, quoted Fabric references can fail resolution even when the entry exists.
Tests use temporary Fabric/Hermes homes; do not point test writes at production
memory or enable paid training/inference merely to validate a refactor.

| Test area | Evidence to preserve |
|---|---|
| `bridge`, `bridge-smoke` | Protocol, persistent state, crash/timeout/cancellation behavior, exact imports and backend tool passthrough |
| `hooks`, `settlement` | Startup/first prompt, final-only capture, queued users, shutdown cleanup, disable/replacement races |
| `context-filter`, `context-filter-hooks` | Selection, exact slices, protected spans, malformed answers, budgets, cancellation, usage and audit failure fallback |
| `config`, `config-schema`, `settings`, `scoped-toggle` | Defaults, precedence, aliases, scope, locking, malformed JSON and command validity |
| `project-trust`, `pi-compatibility`, `extension-surface` | Trusted startup and real Pi loader/runner behavior, including non-context audit persistence |
| `tools` | Verification metadata, error envelopes, schema and passthrough behavior |

Classifier tests use deterministic fake providers. A native Kev smoke test has
also verified a generated request retaining SQLite context, rejecting unrelated
cake text, and preserving facts; this is not a relevance benchmark or a guarantee
for all classifiers. Live backend smoke coverage depends on the selected local
installation, not every possible Icarus fork.

### Contributor checklist

- Read the relevant module and trace its callers before editing. Preserve public
  exports, settings aliases and behavior unless deliberately changing a contract.
- For behavioral changes, run focused tests, then the full suite with the correct
  Python environment. Test both success and failure/cancellation paths.
- For documentation-only changes, check links, examples, packaging and the diff;
  do not invent runtime tests for prose edits.
- Verify distributable files with `npm pack --dry-run`. This is not publishing.
- Keep the README focused on user outcomes, setup and everyday controls. Record
  design rationale here and detailed feature mechanics in linked specifications.
- Add user-facing changes to the changelog. At release time, update availability
  notes and version claims alongside the actual package version.
- If a future decision supersedes one here, explain what changed and why. Introduce
  separate ADR files only when preserving decision history warrants them.
