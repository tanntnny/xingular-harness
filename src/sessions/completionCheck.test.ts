import { afterEach, describe, expect, it, vi } from 'vitest'

import { CHECK_SYSTEM_PROMPT, checkPrompt, launchSwitchOff, parseVerdict, replyTranscript, runCompletionCheck } from './completionCheck'

afterEach(() => vi.unstubAllEnvs())

const messages = [
  { role: 'user', content: 'An earlier request about logos' },
  { role: 'assistant', content: [{ type: 'text', text: 'Logo replaced.' }] },
  { role: 'user', content: [{ type: 'text', text: 'work for the handoff docs/handoffs/B-platform-and-api.md' }] },
  { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret reasoning' }, { type: 'text', text: 'Reading the handoff.' }, { type: 'toolCall', name: 'bash', arguments: { command: 'git status' } }] },
  { role: 'toolResult', toolName: 'bash', isError: false, content: [{ type: 'text', text: `## main\n${'x'.repeat(2_000)}` }] },
  { role: 'assistant', content: [{ type: 'text', text: 'Should I create the agent/b-platform worktree?' }] }
]

describe('completion check input', () => {
  it('reads the reply from the person\'s request onward, without thinking, with clipped tool results', () => {
    const text = replyTranscript(messages, 'work for the handoff docs/handoffs/B-platform-and-api.md')
    expect(text).not.toContain('Logo replaced')
    expect(text).not.toContain('secret reasoning')
    expect(text).toContain('[User or harness]: work for the handoff')
    expect(text).toContain('[Agent tool call] bash({"command":"git status"})')
    expect(text).toContain('[Tool result bash]: ## main')
    expect(text.length).toBeLessThan(1_400)
    expect(text.trim().endsWith('Should I create the agent/b-platform worktree?')).toBe(true)
  })

  it('keeps the newest messages when the reply is long, and falls back to the tail without the request', () => {
    const long = Array.from({ length: 200 }, (_, index) => ({ role: 'assistant', content: [{ type: 'text', text: `step ${index} ${'y'.repeat(100)}` }] }))
    const text = replyTranscript([{ role: 'user', content: 'Do it' }, ...long], 'Do it', 2_000)
    expect(text.length).toBeLessThanOrEqual(2_100)
    expect(text.startsWith('[…earlier messages of this reply omitted…]')).toBe(true)
    expect(text).toContain('step 199')
    expect(replyTranscript(long.slice(0, 2), 'never sent')).toContain('step 0')
  })

  it('gives the check the request, the list and the transcript', () => {
    const user = checkPrompt('Implement B0', [{ text: 'Add workspaces', status: 'completed' }], 'transcript here')
    expect(user).toContain('## The person\'s request\nImplement B0')
    expect(user).toContain('- [completed] Add workspaces')
    expect(user).toContain('transcript here')
    expect(checkPrompt('', [], '')).toContain('(the agent wrote no todo list)')
    expect(CHECK_SYSTEM_PROMPT).toContain('create branches, worktrees and files')
    expect(CHECK_SYSTEM_PROMPT).toContain('"needs_person" only when the remaining work truly requires the person')
  })
})

describe('completion check verdict', () => {
  it('takes the first JSON object with a known verdict, from bare or wrapped text', () => {
    expect(parseVerdict('{"verdict":"continue","reason":"B1 remains","next":"Start B1"}')).toEqual({ verdict: 'continue', reason: 'B1 remains', next: 'Start B1' })
    expect(parseVerdict('Sure.\n```json\n{"verdict": "done", "reason": "ok"}\n```')).toEqual({ verdict: 'done', reason: 'ok', next: '' })
    expect(parseVerdict('{"note":"x"} then {"verdict":"needs_person","reason":"deploy","next":""}')).toMatchObject({ verdict: 'needs_person' })
    expect(parseVerdict('{"verdict":"maybe"}')).toBeNull()
    expect(parseVerdict('no json at all')).toBeNull()
    expect(parseVerdict(`{"verdict":"done","reason":"${'r'.repeat(900)}"}`)!.reason.length).toBe(500)
  })

  it('never throws: an error or a timeout returns no verdict', async () => {
    const failed = await runCompletionCheck(async () => { throw new Error('quota') }, { request: 'x', todo: [], messages: [] })
    expect(failed).toEqual({ verdict: null, answer: null, error: 'quota' })
    const slow = await runCompletionCheck((_system, _user, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))), { request: 'x', todo: [], messages: [] }, { timeoutMs: 20 })
    expect(slow.error).toBe('the completion check timed out')
    const answered = await runCompletionCheck(async () => ({ text: '{"verdict":"done","reason":"ok"}' }), { request: 'x', todo: [], messages: [] })
    expect(answered.verdict).toMatchObject({ verdict: 'done' })
  })

  it('can be switched off at launch for experiments', () => {
    vi.stubEnv('XINGULAR_COMPLETION_CHECK', 'on')
    expect(launchSwitchOff('XINGULAR_COMPLETION_CHECK')).toBe(false)
    vi.stubEnv('XINGULAR_COMPLETION_CHECK', '')
    expect(launchSwitchOff('XINGULAR_COMPLETION_CHECK')).toBe(false)
    vi.stubEnv('XINGULAR_COMPLETION_CHECK', 'off')
    expect(launchSwitchOff('XINGULAR_COMPLETION_CHECK')).toBe(true)
    vi.stubEnv('XINGULAR_STOP_GATE', '0')
    expect(launchSwitchOff('XINGULAR_STOP_GATE')).toBe(true)
  })
})
