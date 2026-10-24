import { describe, expect, it } from 'vitest'
import { SessionManager, type AgentSession } from '@earendil-works/pi-coding-agent'

import { TranscriptModel } from './model'

function session(messages: unknown[], state: Record<string, unknown> = {}): AgentSession {
  return { messages, state } as unknown as AgentSession
}

describe('TranscriptModel', () => {
  it('projects messages, thinking, tools and results in order', () => {
    const model = new TranscriptModel()
    model.bind(session([
      { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image' }] },
      {
        role: 'assistant',
        model: 'test-model',
        content: [
          { type: 'thinking', thinking: 'a plan' },
          { type: 'text', text: 'the answer' },
          { type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'src/a.ts' } }
        ]
      },
      { role: 'toolResult', toolCallId: 't1', content: 'file text', isError: false, durationMs: 12 },
      { role: 'bashExecution', command: 'ls', output: 'a.txt', exitCode: 0 },
      { role: 'custom', customType: 'note', content: 'a note', display: true },
      { role: 'compactionSummary', summary: 'short version', tokensBefore: 12_345 },
      { role: 'branchSummary', summary: 'branch version', fromId: 'older' }
    ], { pendingToolCalls: new Set() }))

    const view = model.view()
    expect(view.hasUserMessages).toBe(true)
    expect(view.items.map(item => item.kind)).toEqual([
      'user', 'thinking', 'assistant', 'tool', 'bash', 'custom', 'compaction', 'summary'
    ])
    expect(view.items[0]).toMatchObject({ text: 'hello', images: 1 })
    expect(view.items[1]).toMatchObject({ text: 'a plan', streaming: false })
    expect(view.items[2]).toMatchObject({ text: 'the answer', model: 'test-model' })
    expect(view.items[3]).toMatchObject({
      name: 'read', summary: 'src/a.ts', status: 'ok', output: 'file text', durationMs: 12
    })
    expect(view.items[4]).toMatchObject({ command: 'ls', output: 'a.txt', exitCode: 0 })
    expect(view.items[5]).toMatchObject({ label: 'note', text: 'a note' })
    expect(view.items[6]).toMatchObject({ kind: 'compaction', summary: 'short version', tokensBefore: 12_345 })
    expect(view.items[7]).toMatchObject({ kind: 'summary', label: 'Branch summary', text: 'branch version' })
  })

  it('reuses the projected transcript until the session changes are invalidated', () => {
    const messages: unknown[] = [{ role: 'user', content: 'hello' }]
    const model = new TranscriptModel()
    model.bind(session(messages))

    const before = model.view()
    expect(model.view()).toBe(before)

    messages.push({ role: 'assistant', content: 'reply' })
    model.invalidate()
    const after = model.view()

    expect(after).not.toBe(before)
    expect(after.items).not.toBe(before.items)
    expect(after.items[0]).toBe(before.items[0])
    expect(after.items).toHaveLength(2)
    expect(model.view()).toBe(after)
  })

  it('shows initial Bash output as it arrives and replaces it with the recorded result', () => {
    const messages: unknown[] = [{ role: 'user', content: '!npm login' }]
    const model = new TranscriptModel()
    model.bind(session(messages))
    model.beginBash('npm login')

    expect(model.view().items.at(-1)).toMatchObject({ kind: 'bash', command: 'npm login', output: '', running: true })
    expect(model.appendBashOutput('initial-bash:run-1', '\u001b[32mLogin at: https://registry.example/login?code=123\u001b[0m')).toBe(true)
    expect(model.view().items.at(-1)).toMatchObject({
      kind: 'bash', command: 'npm login', output: 'Login at: https://registry.example/login?code=123', running: true
    })

    messages.push({ role: 'bashExecution', command: 'npm login', output: 'Login complete', exitCode: 0 })
    model.invalidate()
    expect(model.view().items.filter(item => item.kind === 'bash')).toEqual([
      expect.objectContaining({ command: 'npm login', output: 'Login complete', running: false })
    ])
    model.finishBash()
    expect(model.view().items.filter(item => item.kind === 'bash')).toHaveLength(1)
  })

  it('bounds live Bash output while retaining the beginning and latest output', () => {
    const model = new TranscriptModel()
    model.bind(session([]))
    model.beginBash('npm login')
    model.appendBashOutput('initial-bash:run-1', `Login URL: https://registry.example/login\n${'x'.repeat(20_000)}\nwaiting`)

    const item = model.view().items.at(-1)
    expect(item).toMatchObject({ kind: 'bash', running: true })
    if (item?.kind !== 'bash') throw new Error('Expected a live Bash item.')
    expect(item.output).toContain('https://registry.example/login')
    expect(item.output).toContain('output clipped')
    expect(item.output).toContain('waiting')
    expect(item.output.length).toBeLessThanOrEqual(12_000)
  })

  it('projects image tool results as their own scrollable transcript entries', () => {
    const model = new TranscriptModel()
    model.bind(session([
      { role: 'assistant', content: [{ type: 'toolCall', id: 'read-image', name: 'read', arguments: { file_path: '/tmp/photo.png' } }] },
      {
        role: 'toolResult', toolCallId: 'read-image', isError: false,
        content: [
          { type: 'text', text: 'Image loaded.' },
          { type: 'image', data: 'cG5nLWRhdGE=', mimeType: 'image/png' }
        ]
      },
      { role: 'assistant', content: [{ type: 'text', text: 'The image shows a landscape.' }] }
    ]))

    const items = model.view().items
    expect(items.map(item => item.kind)).toEqual(['tool', 'image-result', 'assistant'])
    expect(items[0]).toMatchObject({ kind: 'tool', output: '' })
    expect(items[1]).toMatchObject({
      kind: 'image-result', text: 'Image loaded.', imageCount: 1,
      images: [{ data: 'cG5nLWRhdGE=', mimeType: 'image/png' }], showImages: true
    })

    model.setImagesShown(false)
    expect(model.view().items[1]).toMatchObject({ kind: 'image-result', imageCount: 1, images: [], showImages: false })
  })

  it('marks pending and failed tools and appends a streaming message', () => {
    const streaming = { role: 'assistant', content: [{ type: 'text', text: 'partial' }] }
    const model = new TranscriptModel()
    model.bind(session([
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'running', name: 'bash', arguments: { command: 'npm test' } },
          { type: 'toolCall', id: 'failed', name: 'read', arguments: { path: 'b.ts' } }
        ]
      },
      { role: 'toolResult', toolCallId: 'failed', content: 'no such file', isError: true }
    ], { pendingToolCalls: new Set(['running']), streamingMessage: streaming }))

    const items = model.view().items
    expect(items[0]).toMatchObject({ status: 'running', summary: 'npm test' })
    expect(items[1]).toMatchObject({ status: 'error', output: 'no such file' })
    expect(items[2]).toMatchObject({ kind: 'assistant', text: 'partial', streaming: true })
  })

  it('shows a checklist call as its list and names the agent and brief of a subagent call', () => {
    const model = new TranscriptModel()
    const items = [{ text: 'Read the code', status: 'completed' }, { text: 'Fix the bug', status: 'in_progress' }, { text: 'Run tests', status: 'pending' }]
    model.bind(session([
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'c1', name: 'checklist_write', arguments: { items } },
          { type: 'toolCall', id: 'c2', name: 'checklist_write', arguments: { items: 'nope' } },
          { type: 'toolCall', id: 's1', name: 'spawn_subagent', arguments: { agent: 'explorer', title: 'Map the login route', brief: 'Find the login route' } }
        ]
      },
      { role: 'toolResult', toolCallId: 'c1', content: '[x] Read the code', isError: false },
      { role: 'toolResult', toolCallId: 'c2', content: 'Send items', isError: false }
    ]))
    const view = model.view().items
    expect(view[0]).toMatchObject({ kind: 'checklist', status: 'ok', items })
    expect(view[1]).toMatchObject({ kind: 'tool', name: 'checklist_write' })
    expect(view[2]).toMatchObject({ kind: 'tool', summary: 'explorer · Map the login route' })
    expect(model.view().items[0]).toBe(view[0])
  })

  it('strips paired bold markers from thinking without changing assistant text', () => {
    const model = new TranscriptModel()
    model.bind(session([{
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '**a plan** and **another thought**' },
        { type: 'text', text: '**the answer**' }
      ]
    }]))

    expect(model.view().items).toEqual([
      expect.objectContaining({ kind: 'thinking', text: 'a plan and another thought' }),
      expect.objectContaining({ kind: 'assistant', text: '**the answer**' })
    ])
  })

  it('hides thinking and custom messages whose display is false', () => {
    const model = new TranscriptModel()
    model.bind(session([
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'visible' }] },
      { role: 'custom', customType: 'secret', content: 'hidden', display: false }
    ]))
    model.setThinkingHidden(true)
    expect(model.view().items.map(item => item.kind)).toEqual(['assistant'])
  })

  it('strips terminal styling from tool output', () => {
    const model = new TranscriptModel()
    model.bind(session([
      { role: 'assistant', content: [{ type: 'toolCall', id: 't', name: 'bash', arguments: { command: 'ls' } }] },
      { role: 'toolResult', toolCallId: 't', content: '\u001b[31mred\u001b[0m plain' }
    ]))
    expect(model.view().items[0]).toMatchObject({ output: 'red plain' })
  })

  it('puts tool diffs after the text output and clips very large output', () => {
    const model = new TranscriptModel()
    model.bind(session([
      { role: 'assistant', content: [{ type: 'toolCall', id: 't', name: 'edit', arguments: { path: 'a' } }] },
      { role: 'toolResult', toolCallId: 't', content: 'done', details: { diff: '--- a\n+++ b' } },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'big', name: 'read', arguments: { path: 'b' } }] },
      { role: 'toolResult', toolCallId: 'big', content: 'x'.repeat(13_000) }
    ]))
    const [edit, big] = model.view().items
    expect(edit).toMatchObject({ output: 'done\n--- a\n+++ b' })
    expect((big as { output: string }).output).toContain('more characters')
    expect((big as { output: string }).output.length).toBeLessThan(12_100)
  })

  it('keeps notices when no session is bound and caps them', () => {
    const model = new TranscriptModel()
    const empty = model.view()
    expect(empty.hasMultilineNotice).toBe(false)
    model.notice('one\ntwo')
    expect(model.view().hasMultilineNotice).toBe(true)
    model.notice('three', 'warning')
    expect(model.view()).not.toBe(empty)
    expect(model.view().items).not.toBe(empty.items)
    expect(model.view().items).toHaveLength(3)
    expect(model.view().items[0]).toMatchObject({ text: 'one', level: 'info' })
    expect(model.view().items[2]).toMatchObject({ text: 'three', level: 'warning' })
    for (let index = 0; index < 100; index += 1) model.notice(`line ${index}`)
    expect(model.view().items).toHaveLength(60)
    model.clearNotices()
    expect(model.view().items).toEqual([])
    expect(model.view().hasMultilineNotice).toBe(false)
  })

  it('keeps grouped help together as one multiline transcript item', () => {
    const model = new TranscriptModel()
    model.bind(session([]))
    const groups = [
      { name: 'Core', commands: [{ name: 'help', description: 'List commands' }, { name: 'quit' }] },
      { name: 'Extensions', commands: [{ name: 'deploy', description: 'Deploy the project' }] }
    ]

    model.commandHelp(groups)

    expect(model.view()).toMatchObject({
      hasMultilineNotice: true,
      items: [{ kind: 'command-help', groups }]
    })
  })

  it('anchors one-line notices at their point in chat so later messages move them up', () => {
    const messages: unknown[] = [{ role: 'user', content: 'hello' }]
    const model = new TranscriptModel()
    model.bind(session(messages))

    model.notice('! prefix summarization failed\nThe operation was aborted.', 'error')
    messages.push({ role: 'assistant', content: 'Here is the next reply.' })
    model.invalidate()

    expect(model.view().items.map(item => item.kind)).toEqual(['user', 'notice', 'notice', 'assistant'])
    expect(model.view().items.slice(1, 3)).toMatchObject([
      { text: '! prefix summarization failed', level: 'error' },
      { text: 'The operation was aborted.', level: 'error' }
    ])
    expect(model.view().items.some(item => item.kind === 'notice' && item.text.includes('\n'))).toBe(false)
  })

  it('keeps notices at their place when compaction replaces the messages', () => {
    const before: unknown[] = Array.from({ length: 40 }, (_, index) => ({ role: 'user', content: `message ${index}` }))
    const target = { messages: before, state: {} }
    const model = new TranscriptModel()
    model.bind(target as unknown as AgentSession)
    model.notice('Compacting context…')

    const after: unknown[] = [{ role: 'compactionSummary', summary: 'earlier work', tokensBefore: 9_000 }, ...before.slice(-3)]
    target.messages = after
    after.push({ role: 'assistant', content: 'work after compaction' })
    model.invalidate()

    const items = model.view().items
    expect(items.map(item => item.kind)).toEqual(['compaction', 'user', 'user', 'user', 'notice', 'assistant'])
    expect(items[3]).toMatchObject({ text: 'message 39' })
    expect(items.at(-1)).toMatchObject({ kind: 'assistant', text: 'work after compaction' })
  })

  it('puts notices for summarized messages right after the compaction card', () => {
    const before: unknown[] = Array.from({ length: 3 }, (_, index) => ({ role: 'user', content: `message ${index}` }))
    const target = { messages: before, state: {} }
    const model = new TranscriptModel()
    model.bind(target as unknown as AgentSession)
    model.notice('early warning', 'warning')
    before.push({ role: 'user', content: 'message 3' }, { role: 'user', content: 'message 4' })

    target.messages = [{ role: 'compactionSummary', summary: 'earlier work', tokensBefore: 9_000 }, ...before.slice(-1)]
    model.invalidate()

    expect(model.view().items.map(item => item.kind)).toEqual(['compaction', 'notice', 'user'])
  })

  it('shows the whole conversation, then the summary, then later work after a compaction', () => {
    const manager = SessionManager.inMemory('/tmp')
    const ids = Array.from({ length: 6 }, (_, index) => manager.appendMessage({ role: 'user', content: `message ${index}`, timestamp: index }))
    const target = { sessionManager: manager, messages: manager.buildSessionProjection().messages, state: {} }
    const model = new TranscriptModel()
    model.bind(target as unknown as AgentSession)
    model.notice('before compaction')

    manager.appendCompaction('earlier work', ids[4]!, 9_000)
    target.messages = manager.buildSessionProjection().messages
    model.bind(target as unknown as AgentSession)
    const reply = { role: 'assistant', content: [{ type: 'text', text: 'work after compaction' }], timestamp: 7 }
    manager.appendMessage(reply as never)
    target.messages.push(reply as never)
    model.invalidate()

    const items = model.view().items
    expect(items.map(item => item.kind)).toEqual(['user', 'user', 'user', 'user', 'user', 'user', 'notice', 'compaction', 'assistant'])
    expect(items.slice(0, 6).map(item => item.kind === 'user' && item.text)).toEqual(ids.map((_, index) => `message ${index}`))
    expect(items[7]).toMatchObject({ kind: 'compaction', summary: 'earlier work', tokensBefore: 9_000 })
    expect(items[8]).toMatchObject({ kind: 'assistant', text: 'work after compaction' })
  })

  it('keeps each earlier compaction in place', () => {
    const manager = SessionManager.inMemory('/tmp')
    const say = (text: string) => manager.appendMessage({ role: 'user', content: text, timestamp: 0 })
    say('one')
    const kept = say('two')
    manager.appendCompaction('first summary', kept, 1_000)
    say('three')
    const keptAgain = say('four')
    manager.appendCompaction('second summary', keptAgain, 2_000)
    say('five')
    const model = new TranscriptModel()
    model.bind({ sessionManager: manager, messages: manager.buildSessionProjection().messages, state: {} } as unknown as AgentSession)

    expect(model.view().items.map(item => item.kind === 'user' ? item.text : item.kind === 'compaction' ? item.summary : item.kind))
      .toEqual(['one', 'two', 'first summary', 'three', 'four', 'second summary', 'five'])
  })

  it('returns to notices when the session is cleared', () => {
    const model = new TranscriptModel()
    model.bind(session([{ role: 'user', content: 'hello' }]))
    model.clear()
    model.notice('after clear')
    expect(model.view().hasUserMessages).toBe(false)
    expect(model.view().items).toHaveLength(1)
  })

  it('shows a proposed plan as a card between the text around it', () => {
    const model = new TranscriptModel()
    model.bind(session([{
      role: 'assistant',
      model: 'test-model',
      content: [{ type: 'text', text: 'Found it.\n<proposed_plan># Fix login\n\n1. Patch</proposed_plan>\nReady?' }]
    }]))

    expect(model.view().items.map(item => item.kind)).toEqual(['assistant', 'plan', 'assistant'])
    expect(model.view().items[0]).toMatchObject({ text: 'Found it.' })
    expect(model.view().items[1]).toMatchObject({ kind: 'plan', title: 'Fix login', body: '1. Patch', streaming: false })
    expect(model.view().items[2]).toMatchObject({ text: 'Ready?' })
  })

  it('marks a plan still streaming until its closing tag arrives', () => {
    const model = new TranscriptModel()
    const streamingMessage = { role: 'assistant', content: [{ type: 'text', text: '<proposed_plan># Draft\n\n1. Re' }] }
    model.bind(session([], { streamingMessage }))
    expect(model.view().items).toEqual([expect.objectContaining({ kind: 'plan', title: 'Draft', streaming: true })])
  })
})
