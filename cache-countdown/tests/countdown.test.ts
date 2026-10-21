import { test, expect, mock, type TestBody } from 'claude-code/testing'

const RESULT = {
  turnId: 't1',
  index: 0,
  answer: 'hello',
  toolUses: [
    { name: 'Edit', input: {} },
    { name: 'Bash', input: {} },
  ],
  stopReason: 'tool_use',
  usage: null,
}
const CHUNKS = [
  { kind: 'text', index: 0, text: 'hello' },
  { kind: 'tool', index: 0, id: 'toolu_a', name: 'Edit' },
  { kind: 'tool', index: 1, id: 'toolu_b', name: 'Bash' },
]
// What the status line prints while a call waits.
const STATUS = 'cache warm 59m'

test('passes the response stream through unchanged', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('turn.step', async function* () {
    for (const chunk of CHUNKS) yield chunk
    return RESULT
  } as never)

  // Every chunk and the result reach the caller unchanged.
  // Drain the stream, keeping each chunk and the final result.
  const seen: unknown[] = []
  const it = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 } as never)[Symbol.asyncIterator]()
  let step = await it.next()
  while (!step.done) {
    seen.push(step.value)
    step = await it.next()
  }

  expect(seen).toEqual(CHUNKS)
  expect(step.value).toEqual(RESULT)
})

test('passes an ask verdict through unchanged', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('tool.check', () => ({ decision: 'ask', rule: 'Edit' }) as never)
  on('session.id', () => ({ value: 'session-1' }) as never)
  on('session.root', () => ({ value: '/tmp/project' }) as never)

  const verdict = await $.tool.check({ tool: 'Edit', input: {}, tool_use_id: 'toolu_a' } as never)
  await clock.settle()
  expect(verdict).toEqual({ decision: 'ask', rule: 'Edit' })
})

test('draws the status line text under a waiting call', async ($, on) => {
  const drawn = await waitingCall($, on)
  expect(await drawn('ToolUse', call(false))).toContain(STATUS)
})

// A call waiting at its dialog (or, with another verdict, not waiting at all),
// with a stand-in for the engine's own rows, and a way to draw a component and
// see whether the cache line is in it. `tool.call` is never resolved here: the
// command is "still running" for the whole test, unless a test resolves it itself.
async function waitingCall(
  $: Parameters<TestBody>[0],
  on: Parameters<TestBody>[1],
  verdict: object = { decision: 'ask', rule: 'Bash' },
  stdout = STATUS,
) {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('process.run', () => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('tool.check', () => verdict as never)
  on('session.id', () => ({ value: 'session-1' }) as never)
  on('session.root', () => ({ value: '/tmp/project' }) as never)
  on('ui.render', () => ({ type: 'Text', children: ['the engine row'] }) as never)

  await $.tool.check({ tool: 'Bash', input: {}, tool_use_id: 'toolu_a' } as never)
  await clock.settle()

  return async (component: 'ToolUse' | 'ToolGroup' | 'ToolProgress', props: object) =>
    JSON.stringify(await $.ui.render({ surface: 'terminal', component, requestId: 'toolu_a', props } as never))
}

const call = (isRunning: boolean, tool_use_id = 'toolu_a') => ({ tool_use_id, tool: 'Bash', input: {}, isRunning, isErrored: false, isInterrupted: false })
const group = (isRunning: boolean) => ({ calls: [call(isRunning)], isActive: true, isExpanded: false })

test('drops the line from a ToolUse row once the call is running and keeps it dropped', async ($, on) => {
  const drawn = await waitingCall($, on)
  expect(await drawn('ToolUse', call(false))).toContain(STATUS)
  expect(await drawn('ToolUse', call(true))).not.toContain('cache warm')
  // Gone for good, even if a later draw were to say otherwise.
  expect(await drawn('ToolUse', call(false))).not.toContain('cache warm')
})

test('drops the line from a ToolGroup row once the call is running', async ($, on) => {
  const drawn = await waitingCall($, on)
  expect(await drawn('ToolGroup', group(false))).toContain(STATUS)
  expect(await drawn('ToolGroup', group(true))).not.toContain('cache warm')
})

test('drops the line when the run-in-background pill is drawn', async ($, on) => {
  const drawn = await waitingCall($, on)
  expect(await drawn('ToolUse', call(false))).toContain(STATUS)
  await drawn('ToolProgress', { tool_use_id: 'toolu_a', kind: 'background_hint', hint: '(ctrl+b to run in background)' })
  expect(await drawn('ToolUse', call(false))).not.toContain('cache warm')
})

test('drops the line once the call resolves', async ($, on) => {
  on('tool.call', () => ({ result: 'done' }) as never)
  const drawn = await waitingCall($, on)
  expect(await drawn('ToolUse', call(false))).toContain(STATUS)
  await $.tool.call({ tool: 'Bash', input: {}, tool_use_id: 'toolu_a' } as never)
  expect(await drawn('ToolUse', call(false))).not.toContain('cache warm')
})

test('draws no line for a call the rules allow', async ($, on) => {
  const drawn = await waitingCall($, on, { decision: 'allow' })
  const row = await drawn('ToolUse', call(false))
  expect(row).toContain('the engine row')
  expect(row).not.toContain('cache warm')
})

test('draws no line for an ask that matched no rule', async ($, on) => {
  // In auto mode an unmatched call is "ask" too, but it goes to the classifier and usually opens no dialog.
  const drawn = await waitingCall($, on, { decision: 'ask' })
  const row = await drawn('ToolUse', call(false))
  expect(row).toContain('the engine row')
  expect(row).not.toContain('cache warm')
})

test('draws the line under the last call of the response that asked', async ($, on) => {
  on('turn.step', async function* () {
    yield { kind: 'tool', index: 0, id: 'toolu_a', name: 'Bash' }
    yield { kind: 'tool', index: 1, id: 'toolu_b', name: 'Bash' }
    return RESULT
  } as never)
  // The anchor is worked out at each draw, so the response may arrive after the dialog opens.
  const drawn = await waitingCall($, on)
  for await (const _chunk of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 } as never)) {
    // Only the calls the response names matter here.
  }
  expect(await drawn('ToolUse', call(false, 'toolu_a'))).not.toContain('cache warm')
  expect(await drawn('ToolUse', call(false, 'toolu_b'))).toContain(STATUS)
})

// Runs one response (unless `responded` is false), then a tool check, and returns the argv of every status read.
// `tierStdout` is what the transcript's TTL tier read prints ('300', '3600', or '' when it finds none).
async function statusReads(
  $: Parameters<TestBody>[0],
  on: Parameters<TestBody>[1],
  stdout: string,
  responded = true,
  tierStdout = '',
) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const ran: string[][] = []
  on('process.run', (_$, e) => {
    if (!e.argv[2]?.includes('statusline_plus')) return { value: { exitCode: 0, stdout: tierStdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    ran.push([...e.argv])
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('turn.step', async function* () {
    return RESULT
  } as never)
  on('tool.check', () => ({ decision: 'ask', rule: 'Bash' }) as never)
  on('session.id', () => ({ value: 'session-1' }) as never)
  on('session.root', () => ({ value: '/tmp/project' }) as never)

  if (responded) {
    for await (const _chunk of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 } as never)) {
      // The response is only read for the send time it records.
    }
  }
  await $.tool.check({ tool: 'Bash', input: {}, tool_use_id: 'toolu_a' } as never)
  await clock.settle()
  return ran
}

// The JSON override each status read was given, in order (the last argument of its process).
const overrides = (ran: string[][]) => ran.map(argv => JSON.parse(argv.at(-1) ?? '{}'))

test('re-reads a warm cache with the expiry from the last send', async ($, on) => {
  const ran = await statusReads($, on, 'cache warm 4m (5m ttl)', true, '300')

  // The send was at 1,000 s, so a 5-minute TTL expires at 1,300 s.
  expect(overrides(ran).at(-1)).toEqual({ prompt_cache: { expires_at: 1300, ttl: '5m', caching_observed: true } })
})

test('re-reads a warm cache on the 1-hour tier with a 1-hour expiry', async ($, on) => {
  const ran = await statusReads($, on, 'cache warm 50m (1h ttl)', true, '3600')

  // A 1-hour TTL from the send at 1,000 s expires at 4,600 s.
  expect(overrides(ran).at(-1)).toEqual({ prompt_cache: { expires_at: 4600, ttl: '1h', caching_observed: true } })
})

test('re-reads a cold cache with the expiry from the last send', async ($, on) => {
  const ran = await statusReads($, on, 'cache cold · 140k', true, '3600')

  // The transcript's last request is stale, but the send at 1,000 s re-cached the prompt.
  expect(overrides(ran).at(-1)).toEqual({ prompt_cache: { expires_at: 4600, ttl: '1h', caching_observed: true } })
})

test('re-reads a cold cache on the 5-minute tier with a 5-minute expiry', async ($, on) => {
  const ran = await statusReads($, on, 'cache cold · 140k', true, '300')

  expect(overrides(ran).at(-1)).toEqual({ prompt_cache: { expires_at: 1300, ttl: '5m', caching_observed: true } })
})

test('assumes the 1-hour tier when the transcript names none', async ($, on) => {
  const ran = await statusReads($, on, 'cache cold · 140k', true, '')

  expect(overrides(ran).at(-1)).toEqual({ prompt_cache: { expires_at: 4600, ttl: '1h', caching_observed: true } })
})

test('does not re-read when the API reports no caching', async ($, on) => {
  const ran = await statusReads($, on, 'cache off', true, '3600')

  expect(overrides(ran)).toEqual([{}])
})

test('draws a warm line when the transcript reads cold but a request was just sent', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('process.run', (_$, e) => {
    if (!e.argv[2]?.includes('statusline_plus')) return { value: { exitCode: 0, stdout: '3600', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    const stdout = JSON.parse(e.argv.at(-1) ?? '{}').prompt_cache ? 'cache warm 59m' : 'cache cold · 140k'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('turn.step', async function* () {
    return RESULT
  } as never)
  on('tool.check', () => ({ decision: 'ask', rule: 'Bash' }) as never)
  on('session.id', () => ({ value: 'session-1' }) as never)
  on('session.root', () => ({ value: '/tmp/project' }) as never)
  on('ui.render', () => ({ type: 'Text', children: ['the engine row'] }) as never)

  for await (const _chunk of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 } as never)) {
    // The response is only read for the send time it records.
  }
  await $.tool.check({ tool: 'Bash', input: {}, tool_use_id: 'toolu_a' } as never)
  await clock.settle()

  const row = JSON.stringify(await $.ui.render({ surface: 'terminal', component: 'ToolUse', requestId: 'toolu_a', props: call(false) } as never))
  expect(row).toContain('cache warm 59m')
  expect(row).not.toContain('cache cold')
})

test('does not re-read when no request has been sent', async ($, on) => {
  const ran = await statusReads($, on, 'cache warm 4m (5m ttl)', false)

  expect(overrides(ran)).toEqual([{}])
})

test('keeps the verdict when the status read fails', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('process.run', () => {
    throw new Error('status read failed')
  })
  on('tool.check', () => ({ decision: 'ask', rule: 'Bash' }) as never)
  on('session.id', () => ({ value: 'session-1' }) as never)
  on('session.root', () => ({ value: '/tmp/project' }) as never)

  // The status line is a display aid: its failure must not change the verdict.
  const verdict = await $.tool.check({ tool: 'Bash', input: {}, tool_use_id: 'toolu_a' } as never)
  await clock.settle()
  expect(verdict).toEqual({ decision: 'ask', rule: 'Bash' })
})

test('draws no line when the status script prints nothing', async ($, on) => {
  const drawn = await waitingCall($, on, { decision: 'ask', rule: 'Bash' }, '')
  const row = await drawn('ToolUse', call(false))
  expect(row).toContain('the engine row')
  expect(row).not.toContain('cache warm')
})

test('draws the status line in the colors it prints', async ($, on) => {
  // 33 is the base palette's yellow; 38;5;196 is the color cube's pure red.
  const drawn = await waitingCall($, on, { decision: 'ask', rule: 'Bash' }, '\x1b[33mcache warm\x1b[0m \x1b[38;5;196m59m\x1b[0m')
  const row = await drawn('ToolUse', call(false))
  expect(row).toContain('#808000')
  expect(row).toContain('#ff0000')
  expect(row).toContain('cache warm')
  expect(row).toContain('59m')
})

// Asks for approval for each call in order, with a status read the test can change. Returns the clock,
// and a way to draw a call's row.
async function askingCalls(
  $: Parameters<TestBody>[0],
  on: Parameters<TestBody>[1],
  status: () => string,
  calls: { tool_use_id: string; agentId?: string }[],
) {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('process.run', () => ({ value: { exitCode: 0, stdout: status(), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('tool.check', () => ({ decision: 'ask', rule: 'Bash' }) as never)
  on('session.id', () => ({ value: 'session-1' }) as never)
  on('session.root', () => ({ value: '/tmp/project' }) as never)
  on('ui.render', () => ({ type: 'Text', children: ['the engine row'] }) as never)

  for (const waiting of calls) await $.tool.check({ tool: 'Bash', input: {}, ...waiting } as never)
  await clock.settle()

  const draw = async (tool_use_id: string) =>
    JSON.stringify(await $.ui.render({ surface: 'terminal', component: 'ToolUse', requestId: tool_use_id, props: call(false, tool_use_id) } as never))
  return { clock, draw }
}

test('redraws the status line every 30 seconds while the dialog is open', async ($, on) => {
  let minutes = 59
  const { clock, draw } = await askingCalls($, on, () => `cache warm ${minutes}m`, [{ tool_use_id: 'toolu_a' }])
  expect(await draw('toolu_a')).toContain('cache warm 59m')

  minutes = 58
  await clock.advance(29_999)
  expect(await draw('toolu_a')).toContain('cache warm 59m')
  await clock.advance(1)
  expect(await draw('toolu_a')).toContain('cache warm 58m')
})

test('stops refreshing once the call resolves', async ($, on) => {
  let reads = 0
  on('tool.call', () => ({ result: 'done' }) as never)
  const { clock } = await askingCalls($, on, () => {
    reads += 1
    return 'cache warm 59m'
  }, [{ tool_use_id: 'toolu_a' }])
  const before = reads

  await $.tool.call({ tool: 'Bash', input: {}, tool_use_id: 'toolu_a' } as never)
  await clock.advance(60_000)
  expect(reads).toBe(before)
})

test('draws the line under the newest of two waiting calls', async ($, on) => {
  const { draw } = await askingCalls($, on, () => 'cache warm 59m', [{ tool_use_id: 'toolu_a' }, { tool_use_id: 'toolu_b' }])

  expect(await draw('toolu_a')).not.toContain('cache warm')
  expect(await draw('toolu_b')).toContain('cache warm 59m')
})

test('draws the line on a sub-agent call\'s own row', async ($, on) => {
  const { draw } = await askingCalls($, on, () => 'cache warm 59m', [{ tool_use_id: 'toolu_s', agentId: 'agent-1' }])

  expect(await draw('toolu_s')).toContain('cache warm 59m')
})
