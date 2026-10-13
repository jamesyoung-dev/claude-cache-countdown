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
