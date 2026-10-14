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

// A call waiting at its dialog, with a stand-in for the engine's own rows, and a
// way to draw a component and see whether the cache line is in it. `tool.call`
// is never resolved here: the command is "still running" for the whole test.
async function waitingCall($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<Parameters<typeof test>[1]>[1]) {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'cache warm 59m', stderr: '' } }))
  on('tool.check', () => ({ decision: 'ask', rule: 'Bash' }) as never)
  on('session.id', () => ({ value: 'session-1' }) as never)
  on('session.root', () => ({ value: '/tmp/project' }) as never)
  on('ui.render', () => ({ type: 'Text', children: ['the engine row'] }) as never)

  await $.tool.check({ tool: 'Bash', input: {}, tool_use_id: 'toolu_a' } as never)
  await clock.settle()

  return async (component: 'ToolUse' | 'ToolGroup' | 'ToolProgress', props: object) =>
    JSON.stringify(await $.ui.render({ surface: 'terminal', component, requestId: 'toolu_a', props } as never))
}

const call = (isRunning: boolean) => ({ tool_use_id: 'toolu_a', tool: 'Bash', input: {}, isRunning, isErrored: false, isInterrupted: false })
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
