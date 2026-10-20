import type { EngineInterface, Register } from 'claude-code'

// An approval dialog hides the status line, so draw the status line's cache
// text under the waiting call's own transcript row, just above the dialog, and
// drop it once the call resolves so nothing is left in the history. The text is
// claude_statusline_plus's output (statusline_plus.sh), colors and all.

const REFRESH_MS = 30_000 // the statusLine.refreshInterval statusline_plus's installer sets

// Runs statusline_plus.sh where its installer puts it: a project install
// (<project>/.claude, which takes precedence) or the global one
// (${CLAUDE_CONFIG_DIR:-~/.claude}); prints nothing when neither exists. Its
// stdin is the session's transcript path, found by session id ($1), merged with
// the payload ($3: session id, rate limits and the prompt_cache override, as the
// status line's own payload carries them). $2 is the project root.
const RUN_STATUS_LINE = `
cfg="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
s="$2/.claude/statusline_plus.sh"
[ -f "$s" ] || s="$cfg/statusline_plus.sh"
[ -f "$s" ] || exit 0
p=$(ls "$cfg"/projects/*/"$1".jsonl 2>/dev/null | head -1)
jq -nc --arg p "$p" --argjson x "$3" '{transcript_path: $p} + $x' | bash "$s"
`

// The status line's rate_limits, from the session's usage figures: each window
// is {used_percentage, resets_at}, with resets_at in Unix seconds. A window the
// engine has no reading for is left out, which the addon's segments skip.
async function rateLimits($: EngineInterface) {
  const windows = (await $.session.usage().catch(() => undefined))?.rateLimits ?? []
  return Object.fromEntries(
    windows.map(w => [
      w.kind,
      { used_percentage: w.percentUsed, ...(w.resetsAt === undefined ? {} : { resets_at: Math.floor(Date.parse(w.resetsAt) / 1000) }) },
    ]),
  )
}

async function statusText($: EngineInterface, extra: object) {
  const [sessionId, root, rate_limits] = await Promise.all([$.session.id(), $.session.root(), rateLimits($)])
  const payload = { session_id: sessionId, rate_limits, ...extra }
  const argv = ['/bin/sh', '-c', RUN_STATUS_LINE, 'sh', sessionId, root, JSON.stringify(payload)]
  const { stdout } = await $.process.run(argv, { timeoutMs: 5_000 })
  return stdout.trim() || undefined
}

const ANSI = /\x1b\[([0-9;]*)m/g
const stripAnsi = (text: string) => text.replace(ANSI, '')

// An xterm 256-color index as hex: 0-15 the base palette, 16-231 the 6x6x6
// cube, 232-255 the gray ramp.
const BASE = ['#000000', '#800000', '#008000', '#808000', '#000080', '#800080', '#008080', '#c0c0c0',
  '#808080', '#ff0000', '#00ff00', '#ffff00', '#0000ff', '#ff00ff', '#00ffff', '#ffffff']
function xterm256(n: number) {
  if (n < 16) return BASE[n]
  const hex = (v: number) => v.toString(16).padStart(2, '0')
  if (n >= 232) return `#${hex(8 + (n - 232) * 10).repeat(3)}`
  const level = (i: number) => (i === 0 ? 0 : 55 + i * 40)
  const c = n - 16
  return `#${hex(level(Math.floor(c / 36)))}${hex(level(Math.floor(c / 6) % 6))}${hex(level(c % 6))}`
}

type Segment = { text: string; color?: string; dim: boolean }

// The status line's SGR codes as styled pieces: 0 resets, 2 dims, 30-37 and
// 90-97 pick a base color, 38;5;N an xterm 256 one.
function segments(text: string) {
  const out: Segment[] = []
  let style: Omit<Segment, 'text'> = { dim: false }
  let at = 0
  for (const m of text.matchAll(ANSI)) {
    if (m.index > at) out.push({ ...style, text: text.slice(at, m.index) })
    at = m.index + m[0].length
    const codes = (m[1] || '0').split(';').map(Number)
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i] ?? 0
      if (c === 0) style = { dim: false }
      else if (c === 2) style = { ...style, dim: true }
      else if (c === 22) style = { ...style, dim: false }
      else if (c === 39) style = { ...style, color: undefined }
      else if (c >= 30 && c <= 37) style = { ...style, color: BASE[c - 30] }
      else if (c >= 90 && c <= 97) style = { ...style, color: BASE[c - 90 + 8] }
      else if (c === 38 && codes[i + 1] === 5) {
        style = { ...style, color: xterm256(codes[i + 2] ?? 0) }
        i += 2
      }
    }
  }
  if (at < text.length) out.push({ ...style, text: text.slice(at) })
  return out
}

// The transcript's reading gives the TTL tier (and a cold state, such as after
// /model); while warm, re-read with the expiry from the last send, which the
// transcript does not hold yet while the dialog is open.
async function cacheLine($: EngineInterface, lastSendMs: number | undefined) {
  const text = await statusText($, {})
  if (text === undefined || !stripAnsi(text).includes(' warm ') || lastSendMs === undefined) return text
  const ttl = stripAnsi(text).includes('(5m ttl)') ? 300 : 3600
  const prompt_cache = { expires_at: Math.floor(lastSendMs / 1000) + ttl, ttl: ttl === 300 ? '5m' : '1h', caching_observed: true }
  return statusText($, { prompt_cache })
}

// The status line's styled pieces as one Text line.
function lineOf(Text: (props: { color?: string; dimColor?: boolean; children?: unknown }) => unknown, text: string) {
  return (
    <Text>
      {segments(text).map(s => (
        <Text color={s.color} dimColor={s.dim}>
          {s.text}
        </Text>
      ))}
    </Text>
  )
}

export const register: Register = on => {
  // tool_use_id of each waiting call -> its line and its timer. `running` is set
  // once the call is past its dialog and executing.
  const pending = new Map<string, { text?: string; isMain: boolean; running: boolean; stop: () => void }>()

  // The dialog is gone once the call is executing, but tool.call's next() runs
  // the command too, so a long shell command would keep the line up until it
  // finished. The call's row says it is executing (isRunning is false while the
  // dialog waits and flips the moment it is answered), so that is the signal.
  // True when this call's line was just dropped, so the caller redraws.
  const markRunning = (id: string | undefined) => {
    const entry = id === undefined ? undefined : pending.get(id)
    if (entry === undefined || entry.running) return false
    entry.running = true
    entry.stop()
    return true
  }

  // The cache's TTL restarts when a request is sent, but the transcript only
  // records the response once it lands: by the time a dialog opens, the
  // transcript still shows the previous request. So note each main-loop send.
  // The same stream names the response's tool calls in order. Calls are checked
  // one at a time, so rows below a waiting call may not have been checked yet;
  // the line goes under the response's last call, the row above the dialog.
  let lastSendMs: number | undefined
  let responseCalls: string[] = []
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    lastSendMs = await $.clock.now()
    const calls: string[] = []
    responseCalls = calls
    const stream = next(e)[Symbol.asyncIterator]()
    try {
      while (true) {
        const step = await stream.next()
        if (step.done) return step.value
        if (step.value.kind === 'tool') calls.push(step.value.id)
        yield step.value
      }
    } finally {
      await stream.return?.()
    }
  }).catch(async function* ($, e, next) {
    return yield* next(e)
  })
  const anchorFor = (id: string) => (responseCalls.includes(id) ? (responseCalls.at(-1) ?? id) : id)

  // The newest waiting call's line and the row (tool_use_id) it is drawn under,
  // worked out at each draw: the response may still be streaming in calls.
  const current = () => {
    const [id, entry] = [...pending].filter(([, e]) => !e.running).at(-1) ?? []
    if (id === undefined || entry?.text === undefined) return undefined
    return { anchor: entry.isMain ? anchorFor(id) : id, text: entry.text }
  }

  // tool.check settles the verdict before the dialog opens. In auto mode an
  // unmatched call is also "ask" (it goes to the classifier, usually no dialog),
  // so act only when an ask rule matched: that one always opens the dialog.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    const id = e.tool_use_id
    if (verdict.decision !== 'ask' || verdict.rule === undefined || id === undefined || pending.has(id)) return verdict

    const refresh = async () => {
      const entry = pending.get(id)
      if (entry === undefined) return
      entry.text = await cacheLine($, lastSendMs)
      $.ui.invalidate('ui.render')
    }
    const isMain = e.agentId === undefined
    const timer = $.clock.every(REFRESH_MS, () => void refresh().catch(() => undefined))
    pending.set(id, { isMain, running: false, stop: () => timer.cancel() })
    await refresh().catch(() => undefined)
    return verdict
  }).catch(($, e, next) => next(e)) // a display aid: never let it decide a call

  // The ToolProgress row (the run-in-background pill) is drawn only under an
  // executing call too, a few seconds after isRunning flips: a fallback.
  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) => {
    if (markRunning(e.props.tool_use_id)) $.ui.invalidate('ui.render')
    return next(e)
  }).catch(($, e, next) => next(e))

  // Once the call resolves (approved, refused or interrupted), drop its line.
  on('tool.call', async ($, e, next) => {
    try {
      return await next(e)
    } finally {
      const entry = pending.get(e.tool_use_id)
      if (entry !== undefined) {
        entry.stop()
        pending.delete(e.tool_use_id)
        $.ui.invalidate('ui.render')
      }
    }
  }).catch(($, e, next) => next(e))

  // A call's row is a ToolUse, or, for calls the transcript folds (shell
  // commands, reads, searches), a line of a ToolGroup.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.props.isRunning && markRunning(e.props.tool_use_id)) $.ui.invalidate('ui.render')
    const line = current()
    const isAnchor = line !== undefined && e.props.tool_use_id === line.anchor
    if (!isAnchor) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {await next(e)}
        <Box marginTop={1}>{lineOf(Text, line.text)}</Box>
      </Box>
    )
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    for (const call of e.props.calls) if (call.isRunning && markRunning(call.tool_use_id)) $.ui.invalidate('ui.render')
    const line = current()
    // An expanded group draws each call as its own ToolUse row, which draws the line.
    const isAnchor = line !== undefined && !e.props.isExpanded && e.props.calls.some(c => c.tool_use_id === line.anchor)
    if (!isAnchor) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {await next(e)}
        <Box marginTop={1}>{lineOf(Text, line.text)}</Box>
      </Box>
    )
  })
}
