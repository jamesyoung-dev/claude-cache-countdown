import { test, expect, mock } from 'claude-code/testing'

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

test('passes the response stream and the verdict through unchanged', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const ran: string[] = []
  on('process.run', (_$, e) => {
    ran.push(e.argv.join(' '))
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('turn.step', async function* () {
    for (const chunk of CHUNKS) yield chunk
    return RESULT
  } as never)
  on('tool.check', () => ({ decision: 'ask', rule: 'Edit' }) as never)
  on('session.id', () => ({ value: 'session-1' }) as never)
  on('session.root', () => ({ value: '/tmp/project' }) as never)

  // Every chunk and the result reach the caller unchanged.
  const seen: unknown[] = []
  const it = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 } as never)[Symbol.asyncIterator]()
  while (true) {
    const step = await it.next()
    if (step.done) {
      expect(step.value).toEqual(RESULT)
      break
    }
    seen.push(step.value)
  }
  expect(seen).toEqual(CHUNKS)

  // An ask verdict passes back unchanged, and the line is read from the status line.
  const verdict = await $.tool.check({ tool: 'Edit', input: {}, tool_use_id: 'toolu_a' } as never)
  await clock.settle()
  expect(verdict.decision).toBe('ask')
  expect(ran.some(cmd => cmd.includes('statusline_plus.sh'))).toBe(true)
})

// A call waiting at its dialog (or, with another verdict, not waiting at all),
// with a stand-in for the engine's own rows, and a way to draw a component and
// see whether the cache line is in it. `tool.call` is never resolved here: the
// command is "still running" for the whole test, unless a test resolves it itself.
async function waitingCall(
  $: Parameters<Parameters<typeof test>[1]>[0],
  on: Parameters<Parameters<typeof test>[1]>[1],
  verdict: object = { decision: 'ask', rule: 'Bash' },
) {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'cache warm 59m', stderr: '' } }))
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

test('drops the line from a ToolUse row once the call is running, not when it finishes', async ($, on) => {
  const drawn = await waitingCall($, on)
  expect(await drawn('ToolUse', call(false))).toContain('cache warm')
  expect(await drawn('ToolUse', call(true))).not.toContain('cache warm')
  // Gone for good, even if a later draw were to say otherwise.
  expect(await drawn('ToolUse', call(false))).not.toContain('cache warm')
})

test('drops the line from a ToolGroup row once the call is running', async ($, on) => {
  const drawn = await waitingCall($, on)
  expect(await drawn('ToolGroup', group(false))).toContain('cache warm')
  expect(await drawn('ToolGroup', group(true))).not.toContain('cache warm')
})

test('drops the line when the run-in-background pill is drawn', async ($, on) => {
  const drawn = await waitingCall($, on)
  expect(await drawn('ToolUse', call(false))).toContain('cache warm')
  await drawn('ToolProgress', { tool_use_id: 'toolu_a', kind: 'background_hint', hint: '(ctrl+b to run in background)' })
  expect(await drawn('ToolUse', call(false))).not.toContain('cache warm')
})

test('drops the line once the call resolves', async ($, on) => {
  on('tool.call', () => ({ result: 'done' }) as never)
  const drawn = await waitingCall($, on)
  expect(await drawn('ToolUse', call(false))).toContain('cache warm')
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
  expect(await drawn('ToolUse', call(false, 'toolu_b'))).toContain('cache warm')
})

test('re-reads a warm cache with the expiry from the last send', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const ran: string[] = []
  on('process.run', (_$, e) => {
    ran.push(e.argv.join(' '))
    return { value: { exitCode: 0, stdout: 'cache warm 4m (5m ttl)', stderr: '' } }
  })
  on('turn.step', async function* () {
    return RESULT
  } as never)
  on('tool.check', () => ({ decision: 'ask', rule: 'Bash' }) as never)
  on('session.id', () => ({ value: 'session-1' }) as never)
  on('session.root', () => ({ value: '/tmp/project' }) as never)

  for await (const _chunk of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 } as never)) {
    // The response is only read for the send time it records.
  }
  await $.tool.check({ tool: 'Bash', input: {}, tool_use_id: 'toolu_a' } as never)
  await clock.settle()

  // The send was at 1,000 s, so a 5-minute TTL expires at 1,300 s.
  expect(ran.at(-1)).toContain('"expires_at":1300')
  expect(ran.at(-1)).toContain('"ttl":"5m"')
})
