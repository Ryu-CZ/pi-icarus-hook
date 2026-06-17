# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/Ryu-CZ/pi-icarus-hook/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Ryu-CZ/pi-icarus-hook/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Ryu-CZ/pi-icarus-hook/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Ryu-CZ/pi-icarus-hook/releases/tag/v0.1.0
