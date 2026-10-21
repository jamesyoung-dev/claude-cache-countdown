# Changelog

All notable changes to cache-countdown are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version is the one in `cache-countdown/.claude-plugin/plugin.json`.

## Unreleased

### Fixed

- The cache line uses the last request's send time when the transcript reads cold, so a dialog shows the real expiry instead of a stale one.

## 0.1.1 - 2026-10-14

### Fixed

- The cache line is dropped once an approved call is running. It had stayed on screen for the whole of a long shell command.
- The line is dropped when the call's row reports it is running, rather than waiting for the run-in-background pill, which draws several seconds after the answer. The pill remains as a fallback.

## 0.1.0 - 2026-10-13

### Added

- Initial release: claude_statusline_plus's prompt-cache status stays on screen under the waiting call while a tool approval dialog is open, and is removed once the call resolves.
