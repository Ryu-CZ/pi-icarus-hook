# pi-icarus-hook

Binds Pi to an existing Hermes agent's Icarus memory system.

`pi-icarus-hook` does not reimplement Fabric recall, Qdrant search, SQLite search, decision capture, session scoring, or extraction. It keeps one persistent Python worker alive and calls Icarus directly.

## What It Is

`pi-icarus-hook` is a Pi-to-Icarus adapter:

- Pi owns the agent lifecycle.
- This package forwards lifecycle events to Icarus hooks.
- Icarus owns memory behavior and side effects.
- Returned Icarus context is injected back into Pi as hidden context.

The persistent Python worker is intentional. Icarus keeps per-session dedupe sets and `state.exchanges` in Python module globals, so hook calls must share one long-lived Python process.

## What It Is Not

- Not a Memory OS client.
- Not a Qdrant, SQLite, or Fabric reimplementation.
- Not a replacement for Icarus.
- Not an orchestrator for Hermes internals.

The package only knows where Icarus lives, how to start Python, which hook or tool to call, and which environment variables to pass through.

## Install

From a local checkout:

```bash
npm install
npm run build
```

Load it with Pi from this directory, or through Pi's normal package loading mechanism:

```bash
pi -e ./src/index.ts
```

The package also declares its Pi extension entry in `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

## Requirements

- Node.js 22 or newer.
- A local Icarus checkout. By default this is expected at `~/.hermes/plugins/icarus`.
- Python available as `python3`, or set `ICARUS_PYTHON`.
- Any Memory OS, Qdrant, SQLite, or LLM dependencies required by the Icarus hooks you call.

## How It Works

Simple cascade:

```text
Pi event
  -> pi-icarus-hook
    -> icarus.hooks.pre_llm_call(...)
      -> Icarus internally uses Fabric / Qdrant / SQLite / Memory OS pieces
```

Context-returning hooks are injected back into Pi as hidden messages:

```text
Icarus returns {"context": "..."}
  -> pi-icarus-hook wraps it as a Pi message
    -> Pi receives the memory context with display: false
```

If Memory OS changes behind Icarus, `pi-icarus-hook` should not need to change unless Icarus hook or tool signatures change.

## Lifecycle Bindings

| Pi event | Icarus hook | Behavior |
|---|---|---|
| `session_start` | `icarus.hooks.on_session_start()` | Injects startup context when returned |
| `before_agent_start` | `icarus.hooks.pre_llm_call()` | Injects per-turn memory context when returned |
| `agent_end` | `icarus.hooks.post_llm_call()` | Captures decisions and updates Icarus session state |
| `session_shutdown` | `icarus.hooks.on_session_end()` | Scores and persists the session when Pi emits this event |

`session_shutdown` is registered opportunistically. If the local Pi runtime does not emit it, the other hooks still work.

## Tools

Normal Fabric tools are pass-through wrappers around `icarus.tools.*`:

- `fabric_write`
- `fabric_recall`
- `fabric_search`
- `fabric_pending`
- `fabric_curate`
- `fabric_brief`
- `fabric_init_obsidian`

Admin and training tools are disabled by default. Enable them with `PI_ICARUS_HOOK_ADMIN_TOOLS=1`.

## Configuration

Most setups should need little or no configuration if Hermes/Icarus uses the standard local layout.

Configuration is read in this order:

1. Environment variables.
2. Project settings at `.pi/settings.json`.
3. Global Pi agent settings at `${PI_CODING_AGENT_DIR:-~/.pi/agent}/settings.json`.
4. Built-in defaults.

Use `piIcarusHook` or `pi-icarus-hook` in Pi settings:

```json
{
  "piIcarusHook": {
    "icarusDir": "~/.hermes/plugins/icarus",
    "hermesHome": "~/.hermes",
    "fabricDir": "~/fabric",
    "agent": "pi-agent"
  }
}
```

Typical variables:

| Variable | Default | Purpose |
|---|---|---|
| `ICARUS_DIR` | `~/.hermes/plugins/icarus` | Local Icarus Python package directory |
| `HERMES_HOME` | `~/.hermes` when it exists | Hermes home for Icarus state files |
| `HERMES_AGENT_NAME` | inferred from `.hermes-<agent>`, else `pi-agent` | Agent name passed to Icarus |
| `FABRIC_DIR` | `~/fabric` | Shared Fabric markdown directory |

Advanced variables:

| Variable | Default | Purpose |
|---|---|---|
| `ICARUS_PYTHON` | `python3` | Python executable for the worker |
| `STATE_DB_PATH` / `HERMES_STATE_DB` | unset | Optional explicit Hermes session SQLite path |
| `FABRIC_PROJECT_ID` | current directory name | Project id passed to Icarus writes/retrieval |
| `PI_ICARUS_HOOK_PLATFORM` | `pi` | Platform label passed to Icarus hooks |
| `PI_ICARUS_HOOK_HOOKS` | `true` | Register lifecycle hooks |
| `PI_ICARUS_HOOK_TOOLS` | `true` | Register normal Fabric tools |
| `PI_ICARUS_HOOK_ADMIN_TOOLS` | `false` | Register admin/training tools |
| `PI_ICARUS_HOOK_CONTEXT_DISPLAY` | `false` | Show injected context instead of hiding it |
| `PI_ICARUS_HOOK_TIMEOUT_MS` | `30000` | Timeout for each Icarus worker call |

Boolean values accept `false`, `0`, `no`, `off`, and `disabled` as false.

## Verify

Run the package tests:

```bash
npm test
```

The smoke tests verify that Fabric tools pass through to Icarus and that hook session state persists across calls in the Python worker.
