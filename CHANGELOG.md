# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Add a persistent-worker regression test confirming recalled reviews and revisions each record usage once, while rejected writes record no usage.

### Changed

- Clarify how to load a development checkout without also loading the npm-installed extension and causing tool conflicts.
- Document how to select Icarus's Python environment for integration tests and why its PyYAML dependency matters for Fabric references.

### Fixed

- Mark Fabric validation and backend error responses as failed Pi tool results instead of successful results containing an error message.
- Honor the legacy `hiddenDisplay` setting when inspecting or toggling the default context visibility, matching startup configuration precedence.

## [0.5.2] - 2026-10-02

### Added

- Add README badges for npm, license, and Pi package gallery metadata.

### Changed

- Guide `fabric_write` callers on the verification contract: `verified` is now a `"true"`/`"false"` enum with `evidence` and `source_tool` parameter descriptions, and the tool description instructs agents to mark only actually verified results.

### Fixed

- Send startup context through Pi as a custom message without triggering a model turn, and honor the configured context visibility.
- Mark the first eligible nonempty prompt as the first turn, resetting this state at session start.
- Use Pi's session manager ID for every lifecycle hook.
- Omit the unsupported shutdown `completed` flag.
- Normalize `fabric_write` `verified` to Icarus's `"true"`/`"false"` contract (booleans and common strings are accepted, ambiguous values are rejected) so frontmatter records `verified: "true"` consistently.
- Reject `fabric_write` calls with `verified="true"` but no `evidence` instead of persisting ungrounded verified claims.

## [0.5.1] - 2026-06-18

### Added

- Add package gallery image metadata for the banner image.
- Decorate the README with remotely referenced banner and usage images.

## [0.5.0] - 2026-06-18

### Changed

- Rename the Pi slash command from `/icarus-hook` to `/icarus`.
- Show injected Icarus context by default and add `/icarus context` controls for session visibility plus explicit `/icarus context default ...` settings writes for future sessions.

## [0.4.1] - 2026-06-17

### Fixed

- Add missing `pi-package` npm keyword and `peerDependencies` so the package appears in Pi's catalog listing.

## [0.4.0] - 2026-06-17

### Added

- Show a configurable Pi footer status, defaulting to `🪽 Icarus`, while ambient Icarus memory hooks are active.
- Add `/icarus-hook` runtime memory hook toggle for the current Pi session, with explicit `on`, `off`, and `status` subcommands to control whether conversation memory is loaded and saved.

## [0.3.0] - 2026-06-17

### Added

- Add a read-only `CONFIG_SCHEMA`, `/icarus-hook` command, and `icarus_hook_config` tool so Pi and users can inspect supported settings and current effective config.

## [0.2.0] - 2026-06-17

### Changed

- Move Pi-specific adapter behavior (`platform`, hook/tool registration, admin tools, context display, and worker timeout) to normal Pi settings only instead of `PI_ICARUS_HOOK_*` environment variables.
- Keep environment variables for external Hermes/Icarus runtime paths and identity only.

## [0.1.1] - 2026-06-17

### Fixed

- Close the Icarus bridge worker on Pi `session_shutdown` so non-interactive `pi -p` runs exit cleanly after calling Fabric tools.

## [0.1.0] - 2026-06-16

### Added

- Initial `pi-icarus-hook` package.
- Persistent Python worker for calling local Icarus hooks without losing Python module session state.
- Pi lifecycle bindings for `session_start`, `before_agent_start`, `agent_end`, and opportunistic `session_shutdown`.
- Pass-through Fabric tool wrappers around `icarus.tools.*`.
- Optional admin/training tool registration via `PI_ICARUS_HOOK_ADMIN_TOOLS`.
- Configuration loading for `ICARUS_DIR`, `FABRIC_DIR`, `HERMES_HOME`, agent name, project id, and bridge behavior flags.
- Smoke tests proving tool pass-through and persistent hook session state.
- README explaining that the package only binds Pi to Icarus and does not reimplement Memory OS behavior.

[Unreleased]: https://github.com/Ryu-CZ/pi-icarus-hook/compare/v0.5.2...HEAD
[0.5.2]: https://github.com/Ryu-CZ/pi-icarus-hook/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/Ryu-CZ/pi-icarus-hook/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/Ryu-CZ/pi-icarus-hook/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/Ryu-CZ/pi-icarus-hook/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Ryu-CZ/pi-icarus-hook/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Ryu-CZ/pi-icarus-hook/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Ryu-CZ/pi-icarus-hook/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Ryu-CZ/pi-icarus-hook/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Ryu-CZ/pi-icarus-hook/releases/tag/v0.1.0
