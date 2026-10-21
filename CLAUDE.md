# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Claude Code mod: a plugin with a hooks module that adds to [claude_statusline_plus](https://github.com/jimmc414/claude_statusline_plus). It keeps the prompt-cache countdown on screen while a tool approval dialog is open. There is no `package.json`, no build step and no linter. The engine loads `cache-countdown/hooks/register.tsx` directly. README.md covers the user-facing behavior and why the mod draws its line where it does.

## Commands

Run from the repo root.

- Test: `claude plugin test ./cache-countdown`. Runs every `*.test.ts` under the folder, each file in a child process, and exits 1 on failure. The CLI has no option to pick a single file or test.
- Validate: `claude plugin validate .` checks the marketplace. `claude plugin validate cache-countdown` checks the manifest and the hooks module against the installed engine. CI runs both.
- Type-check: `tsc -p cache-countdown`, with TypeScript 5.4 or newer. CI pins 5.9.3. There is no package.json, so the version lives only in `.github/workflows/test.yml`.
- Live development: `claude --plugin-dir cache-countdown`. Edits reload as each turn ends.
- The mod runs `statusline_plus.sh` and prints nothing without it. Install claude_statusline_plus to `~/.claude` (or `$CLAUDE_CONFIG_DIR`), or to `<project>/.claude`, before testing the live behavior.

## Layout

- `.claude-plugin/marketplace.json`: the marketplace, at the repo root. Its `source` points at `./cache-countdown`.
- `cache-countdown/.claude-plugin/plugin.json`: the plugin manifest. Its `version` is the release version.
- `cache-countdown/hooks/hooks.json`: names `register.tsx` as the hooks module.
- `cache-countdown/tests/countdown.test.ts`: the only test file.
- `.github/workflows/test.yml`: CI.
- `cache-countdown/.claude-plugin/types/` holds the engine's TypeScript declarations for the hook API. Claude Code writes them when it loads the mod from a folder, and the first line of `index.d.ts` names the version that wrote them. The folder is committed as a snapshot for `tsc`, so don't hand-edit it. `cache-countdown/tsconfig.json` extends it.

## Architecture

The status line text is never computed in this repo. `statusText()` in `register.tsx` runs `statusline_plus.sh` with the session transcript path on stdin, merged with an extra JSON payload. The mod's logic decides *when* to draw that text and *where*:

1. `turn.step` records each main-loop request's send time (`lastSendMs`) and the tool-call ids of the response, in order (`responseCalls`). The send time matters because Claude Code writes a response to the transcript only once it finishes arriving, so a transcript read at dialog time is stale.
2. `tool.check` acts only when the verdict is `ask` and a permission rule matched. It registers a pending entry with a 30-second timer, and each tick re-runs the status script through `cacheLine()`.
3. `cacheLine()` re-reads with `prompt_cache.expires_at` set to the last send plus the TTL, whenever a send is known. That overrides a cold transcript reading. The TTL tier comes from `RUN_TTL`, which reads the transcript: 5 minutes if the last request wrote 5-minute cache tokens, otherwise 1 hour.
4. `ui.render` on `ToolUse`, `ToolGroup` and `ToolProgress` picks the row that carries the line. A main-agent call anchors under the response's last tool call (`anchorFor`), because the engine checks calls one at a time and later rows may not be checked yet. A sub-agent call anchors under its own row. The line is dropped once the row reports `isRunning`, or the run-in-background pill draws (`markRunning`).
5. `tool.call` removes the entry when the call resolves, whether approved, refused or interrupted.

Every hook ends in `.catch(... next(e))`. The mod is a display aid, so a failure must never change a verdict or break a render. Keep that when adding a hook.

## Conventions

- **Supported Claude Code versions** are 2.1.286 and 2.1.305. Change them together in three places: the `claude-code` matrix in `.github/workflows/test.yml` (and its comment), and the Requirements list in README.md. The README's "Problem" section names 2.1.296 as a dated observation, not a support statement. Leave it alone when the supported versions change.
- **Early-access API.** `.claude-plugin/types/claude-code/index.d.ts` is the hook API's declaration, marked as changeable without notice. Don't hand-edit it. Reload the mod to regenerate it, and check against the engine with `claude plugin validate cache-countdown`. If the engine skips the hooks, approvals still work and the line is simply absent.
- **Tests are black-box.** Assert on what a hook returns or draws: the verdict, the process argv, or the rendered `ToolUse`, `ToolGroup` and `ToolProgress` output. Don't assert on module internals such as the `pending` Map or its timers. The three `ui.render` tests in `countdown.test.ts` show the pattern.
- **Test kit details.** Register handlers with `on(...)` before the first `$` call in a test. Call `mock.clock(on, { now })` before any `$` use, and `clock.settle()` or `clock.advance()` to run timers. A `tool.call` handler must answer `{ result: ... }`, cast `as never`.

## Git

- Never commit to `main`. Work on a branch with a descriptive kebab-case name.
- Keep local paths, email addresses and employer names out of commit messages, PR text and code comments. The repo is public.
