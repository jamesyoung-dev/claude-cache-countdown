# claude-cache-countdown

A Claude Code mod for [claude_statusline_plus](https://github.com/jimmc414/claude_statusline_plus): its prompt-cache status stays on screen while a tool approval dialog is open.

```
● Update(src/app.ts)
  ⎿  Waiting…

  cache warm 58m

 Edit file
 src/app.ts
 ...
 Do you want to make this edit to app.ts?
 ❯ 1. Yes
```

The line is claude_statusline_plus's own output, colors included. It refreshes on the status line's 30-second interval while the dialog waits, and it is removed once you answer, so nothing is left in your history.

## Problem

Claude Code hides the whole footer, status line included, whenever a dialog takes over the prompt area. That is exactly the moment the cache countdown matters: an approval dialog can sit unanswered while you read a diff or step away, and the cache keeps expiring the whole time. Whether you have 50 minutes or 2 is what decides between approving now and coming back to a cold start. The status line can't help, because it isn't drawn, and no setting keeps it visible: the `statusLine` setting only has `command`, `padding`, `refreshInterval` and `hideVimModeIndicator`.

## Approach

A Claude Code mod (a plugin with a hooks module) draws the status line's text as part of the waiting call's own transcript row, the row directly above the dialog.

The routes that look more direct don't work on Claude Code 2.1.296:

- **A line under the dialog** (`$.ui.notice`): accepted, but only the AskUserQuestion dialog draws it, never a tool approval.
- **The band above the prompt** (`AbovePrompt`): hidden whenever a dialog is open, along with the status line.
- **A `PermissionRequest` hook's `systemMessage`**: the hook fires, but the message isn't shown while the dialog is up.
- **A `tool.check` reason**: when the hook agrees with Claude Code's own "ask", its reason goes to a field the dialog never draws. Changing the decision to get the text shown would mean the mod deciding your approvals.

A transcript row is drawn through `ui.render`, so a mod can add to it while the call waits and redraw it without the line once the call resolves.

## Installation

Install [claude_statusline_plus](https://github.com/jimmc414/claude_statusline_plus#installation) first. This mod runs its `statusline_plus.sh` and shows nothing without it.

Then, inside Claude Code:

```
/plugin marketplace add jamesyoung-dev/claude-cache-countdown
/plugin install cache-countdown@claude-cache-countdown
```

Or from a shell:

```bash
claude plugin marketplace add jamesyoung-dev/claude-cache-countdown
claude plugin install cache-countdown@claude-cache-countdown
```

To try it without installing, copy the `cache-countdown/` folder to `~/.claude/skills/cache-countdown/`; Claude Code loads it in the next session.

### Requirements

- Claude Code 2.1.296 or later (the version it was built and tested on)
- claude_statusline_plus installed globally (`~/.claude`, or `$CLAUDE_CONFIG_DIR`) or in the project (`<project>/.claude`, which takes precedence, as it does for the status line itself)
- `jq` and `bash`, which claude_statusline_plus needs anyway

### Uninstall

```
/plugin uninstall cache-countdown@claude-cache-countdown
/plugin marketplace remove claude-cache-countdown
```

## Usage

Nothing to run. The next time a tool call stops for your approval, the cache line appears above the dialog:

```
cache warm 31m          plenty of time
cache warm 4m           (yellow) expiring soon: answer now or accept a cold start
cache cold · 140k       already expired; approving re-caches ~140k tokens
```

With several calls queued (two edits and a shell command, say), the line sits under the last of them, the row directly above whichever dialog is open, and moves to the next dialog as you answer each one.

## How It Works

The mod is `cache-countdown/hooks/register.tsx`. It hooks five events:

| Event | What it does there |
|---|---|
| `turn.step` | Notes when each main-loop request is sent, and the tool calls its response streams in, in order. |
| `tool.check` | When the verdict is "ask" and a permission rule matched, runs `statusline_plus.sh` and starts a 30-second refresh. |
| `tool.call` | When the call resolves (approved, refused or interrupted), stops the refresh and drops the line. |
| `ui.render` on `ToolUse` | Draws the line under the row of the response's last call. |
| `ui.render` on `ToolGroup` | The same, for calls the transcript folds into one line (shell commands, reads, searches). |

### Why it tracks the send time

The cache's TTL restarts when a request is sent, but Claude Code writes the response to the transcript only once it has finished arriving. By the time an approval dialog opens, the transcript still holds the previous request, so cache_warm.sh's transcript fallback would read up to one response's duration short. The mod passes `prompt_cache.expires_at` (send time plus TTL) in the status line payload, which cache_warm.sh uses as-is. The TTL tier comes from a first, unmodified run: a `(5m ttl)` mark means 5 minutes, anything else 1 hour.

### Why the line goes under the last call

Claude Code checks a response's tool calls one at a time. While the first call's dialog is open, the rows of the calls after it are already on screen but haven't been checked yet. The response stream names them all, so the line goes under the last one, which is the row nearest the dialog.

### Colors

claude_statusline_plus prints ANSI SGR codes. The mod turns them into `Text` styles: `2` is dim, `30`-`37` and `90`-`97` are the base palette, and `38;5;N` is converted to its xterm-256 hex value (`40` → `#00d700`, `220` → `#ffd700`, `39` → `#00afff`). Anything else is drawn unstyled.

## Limitations

- **Early-access API.** The mod API is marked as one that "may change between releases without notice." A Claude Code update can break this mod. If one does, the hooks fail open: Claude Code skips them and approvals work as normal, without the line.
- **Dialogs a permission rule opens, only.** In auto mode, a call that no rule matches is "ask" too, but it goes to the classifier, which usually approves it without a dialog. So the mod acts only when a rule matched. A dialog the classifier itself asks for gets no line.
- **Main conversation only.** A subagent's call is drawn under its own row, not the response's last; the cache shown is still the main conversation's.
- **Tested in the terminal's standard layout.** Not yet tried in fullscreen, the desktop app or VS Code.
- **No native Windows support**, as with claude_statusline_plus.

## Development

```bash
claude plugin validate .                    # the marketplace
claude plugin validate cache-countdown      # the plugin and its hooks module
claude plugin test cache-countdown          # tests/*.test.ts against the engine
```

To work on it live, run Claude Code with `--plugin-dir cache-countdown`; edits reload as each turn ends.

## Merging into claude_statusline_plus

This repo is laid out so it can be folded into claude_statusline_plus without changes:

1. Copy `cache-countdown/` to the root of that repo.
2. Copy `.claude-plugin/marketplace.json` too, changing its `name` and `owner` to that repo's.
3. Add the "Problem" through "Limitations" sections above as a section of its README, and update the install commands to that repo's name.
4. Optionally, have `install.sh` copy `cache-countdown/` into `~/.claude/skills/` for people who install by script rather than `/plugin`.

The mod doesn't change or duplicate any of claude_statusline_plus's scripts; it only runs `statusline_plus.sh` as the status line does.

## Credits

Built on [claude_statusline_plus](https://github.com/jimmc414/claude_statusline_plus) by Jim McMillan, which does all the cache arithmetic; this mod only keeps its output on screen.

## License

MIT
