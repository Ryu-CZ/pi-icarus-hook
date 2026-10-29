# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.0] - 2026-10-29

### Added

- A classifier model decides which memory text to leave out before Pi answers. Stored memories stay unchanged.
- Session records show filtering decisions and separate classifier usage totals, without logging memory text.

### Changed

- Shortened the README; moved technical guidance to [VISION.md](VISION.md).
- Filtering prefers local models by default (`classifier: "default"`). **Remote fallback may share prompts and memory text and incur charges.**
- Choose an exact local `provider/model-id` to block remote fallback, or `classifier: "none"` to disable filtering. Reload Pi afterward.
- Filtering keeps uncertain or unclassified text and preserves all context on failure or timeout (five seconds by default).
- Filtering skips startup context, facts, unknown bracketed sections, and explicit tool results.
- Filtering can discard useful text; Icarus may not offer it again later.

## [0.6.0] - 2026-10-22

### Fixed

- `/icarus off` cancels pending memory recall and capture, even if re-enabled. Work already sent to Icarus may finish.
- Cancelling a Fabric action stops queued actions; running writes may finish. Restart the session to restore memory.
- Prevented duplicate memory initialization in the same conversation.
- Saving context defaults preserves concurrent changes from other Pi windows.
- Invalid settings files are no longer overwritten. Repair the JSON before saving defaults.
- Visibility defaults now apply to the requested scope and show where they were saved.
- Icarus crashes no longer break Pi or replay failed actions. Restart the session to restore memory.
- Restored compatibility with Pi 1.4.0.

### Security

- Untrusted project settings can no longer choose Icarus's Python program, storage, or tools.
- Blocked project Python files from impersonating Icarus during startup.

## [0.5.4] - 2026-10-16

### Fixed

- Restored conversation memory support for Pi 1.3.0.
- Memory is saved only after successful answers—not retries, cancellations, failures, or truncated answers.
- Memory capture preserves the original request and queued follow-ups when Pi retries.
- Automated extension messages no longer trigger memory recall or capture.

## [0.5.3] - 2026-10-02

### Changed

- Clarified setup to avoid duplicate extensions and use the correct Icarus Python environment.

### Fixed

- Removed the ineffective result-limit option from `fabric_search` guidance.
- Fabric errors now appear as failed tool calls instead of successes.
- Visibility inspection and default toggles now respect the legacy `hiddenDisplay` setting.
- Invalid `/icarus` commands show guidance without changing memory controls or settings.

## [0.5.2] - 2026-10-02

### Added

- Added README links to npm, the license, and the Pi package gallery.

### Changed

- `fabric_write` guidance now requires evidence and the tool used for verification.

### Fixed

- Startup memory respects visibility settings without triggering an extra answer.
- Empty prompts no longer consume first-request memory handling.
- Memory operations consistently use the current Pi conversation ID.
- Stopped sending an unsupported completion flag when ending a session.
- `fabric_write` now saves verification flags consistently and rejects ambiguous values.
- `fabric_write` rejects verified claims without supporting evidence.

## [0.5.1] - 2026-06-18

### Added

- Added a gallery banner and README illustrations.

## [0.5.0] - 2026-06-18

### Changed

- Renamed `/icarus-hook` to `/icarus`.
- Memory messages are visible by default. Change visibility with `/icarus context` (this session) or `/icarus context default ...` (future sessions).

## [0.4.1] - 2026-06-17

### Fixed

- Fixed package discovery in Pi's catalog.

## [0.4.0] - 2026-06-17

### Added

- Added a configurable footer status: `🪽 Icarus` while automatic memory is active.
- Added `/icarus-hook` with `on`, `off`, and `status` controls for session memory.

## [0.3.0] - 2026-06-17

### Added

- Added read-only settings inspection through `/icarus-hook` and `icarus_hook_config`.

## [0.2.0] - 2026-06-17

### Changed

- Extension behavior now uses Pi settings instead of `PI_ICARUS_HOOK_*` environment variables.
- Environment variables remain supported for Hermes/Icarus paths and identity.

## [0.1.1] - 2026-06-17

### Fixed

- Non-interactive `pi -p` runs now exit cleanly after calling Fabric tools.

## [0.1.0] - 2026-06-16

### Added

- Connected Pi to local Hermes/Icarus for automatic memory recall and conversation capture.
- Added Fabric memory tools, with admin/training tools disabled by default.
- Added settings for Icarus, Python, memory storage, agent identity, and project.
- Kept Icarus session memory available throughout each Pi conversation.

[Unreleased]: https://github.com/Ryu-CZ/pi-icarus-hook/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/Ryu-CZ/pi-icarus-hook/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/Ryu-CZ/pi-icarus-hook/compare/v0.5.4...v0.6.0
[0.5.4]: https://github.com/Ryu-CZ/pi-icarus-hook/compare/v0.5.3...v0.5.4
[0.5.3]: https://github.com/Ryu-CZ/pi-icarus-hook/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/Ryu-CZ/pi-icarus-hook/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/Ryu-CZ/pi-icarus-hook/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/Ryu-CZ/pi-icarus-hook/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/Ryu-CZ/pi-icarus-hook/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Ryu-CZ/pi-icarus-hook/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Ryu-CZ/pi-icarus-hook/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Ryu-CZ/pi-icarus-hook/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Ryu-CZ/pi-icarus-hook/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Ryu-CZ/pi-icarus-hook/releases/tag/v0.1.0
