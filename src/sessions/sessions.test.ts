import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from 'node:fs'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { memorySecretStore } from '../accounts/secrets'
import { ASK_USER } from '../tools/askUser'
import { createHarness, type Harness } from '../harness'
import type { RunEvent } from './contracts'
import { grant, type ApprovalFacts } from './approvals'
import { loadRun as loadCapabilitySnapshot } from '../capabilities/runSnapshot'
import { continuationOf, continuationSection } from './continuation'
import { selectHistory } from './history'
import type { ToolPolicy } from './policy'
import type { PiEvent, PiSessionLike, SessionFactory } from './runner'
import { loadRun, readEvents } from './runStore'
import { COMPACTION_CHECKPOINT_EXTENSION } from './compactionCheckpoint'
import { PLAN_RESEARCH_SUBAGENT_INSTRUCTIONS, PLAN_REPAIR_CUSTOM_TYPE } from './planMode'
import type { SessionRunInput } from './sessions'

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))
const open: Harness[] = []
afterEach(async () => {
  for (const harness of open.splice(0)) await harness.close()
})

function setup(factory: SessionFactory, policy: ToolPolicy = {}) {
  const harness = createHarness({ dataRoot: mkdtempSync(join(tmpdir(), 'harness-data-')), stateDir: mkdtempSync(join(tmpdir(), 'harness-state-')), secrets: memorySecretStore(), sessionFactory: factory, policy })
  open.push(harness)
  harness.accounts.create('Main', 'apiKey')
  const events: RunEvent[] = []
  harness.runs.listen((event) => void events.push(event))
  const sessionDir = join(harness.env.root, 'sessions', 'agent-1')
  const run = (id: string, extra: Partial<SessionRunInput> = {}) =>
    harness.sessions.run({ run: { id, sessionId: 'agent-1' }, cwd: harness.env.root, sessionDir, text: 'hello', caller: { agentId: 'agent-1', agentName: 'Helper', actor: 'Chat' }, tools: { allow: ['read', 'bash'], gated: ['bash'] }, ...extra })
  return { harness, events, run, sessionDir }
}

function fakeSession(script: (emit: (event: PiEvent) => void, gateCheck: () => Promise<string | null>) => Promise<void>, gate: { check: (name: string, input: unknown) => Promise<string | null> }): PiSessionLike & { aborted: boolean } {
  let listener: (event: PiEvent) => void = () => undefined
  const session = {
    sessionId: 'native-1',
    aborted: false,
    subscribe: (fn: (event: PiEvent) => void) => {
      listener = fn
      return () => undefined
    },
    prompt: () => script((event) => listener(event), () => gate.check('bash', { command: 'ls' })),
    sendCustomMessage: async () => undefined,
    abort: async () => {
      session.aborted = true
    },
    dispose: () => undefined
  }
  return session
}

/** A plan session whose first reply may lack the plan block; a triggered custom message may re-send one. */
function planRepairSession(first: string, repaired: string | null, repairs: { customType: string; display: boolean; triggerTurn: boolean }[], askDuringRepair = false): PiSessionLike {
  let listener: (event: PiEvent) => void = () => undefined
  const emit = (text: string): void => {
    listener({ type: 'message_start', message: { role: 'assistant' } })
    listener({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } })
  }
  return {
    sessionId: 'native-repair',
    subscribe: (fn: (event: PiEvent) => void) => {
      listener = fn
      return () => undefined
    },
    prompt: async () => emit(first),
    sendCustomMessage: async (message, options) => {
      if (!options.triggerTurn) return
      repairs.push({ customType: message.customType, display: message.display, triggerTurn: options.triggerTurn })
      if (askDuringRepair) {
        listener({ type: 'tool_execution_start', toolCallId: 'question-1', toolName: ASK_USER, args: {} })
        listener({ type: 'tool_execution_end', toolCallId: 'question-1', toolName: ASK_USER, isError: false, result: { content: [{ type: 'text', text: 'Option A' }] } })
      }
      if (repaired !== null) emit(repaired)
    },
    abort: async () => undefined,
    dispose: () => undefined
  }
}

describe('session commands', () => {
  it('compacts a saved conversation without sending a request', async () => {
    const calls: string[] = []
    const { run, sessionDir, harness } = setup(async ({ gate }) => {
      const session = fakeSession(async () => { calls.push('prompt') }, gate)
      session.compact = async (instructions) => { calls.push(`compact:${instructions ?? ''}`) }
      return session
    })
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'history.jsonl'), `${JSON.stringify({ type: 'session', version: 3, id: 'native-1', timestamp: new Date().toISOString(), cwd: harness.env.root })}\n`)
    await run('compact-1', { text: '/compact', command: { name: 'compact', instructions: 'keep decisions' } })
    await tick()
    expect(calls).toEqual(['compact:keep decisions'])
    expect(loadRun(harness.env.root, 'compact-1').status).toBe('completed')
  })

  it('refuses a command before there is a saved conversation', async () => {
    const { run } = setup(async ({ gate }) => fakeSession(async () => undefined, gate))
    await expect(run('compact-2', { command: { name: 'compact' } })).rejects.toThrow(/no saved conversation/)
  })
})

describe('session turns on Pi', () => {
  it('runs an initial Bash command before asking the agent to inspect its result', async () => {
    const calls: string[] = []
    const { run, events } = setup(async ({ gate }) => {
      const session = fakeSession(async () => { calls.push('prompt') }, gate)
      session.executeBash = async command => {
        calls.push(`bash:${command}`)
        return { output: 'command output', exitCode: 0, cancelled: false, truncated: false }
      }
      session.sendCustomMessage = async message => { calls.push(`context:${message.content}`) }
      return session
    })

    await run('initial-bash', {
      text: '!printf command-output',
      initialBashCommand: 'printf command-output',
      tools: { allow: ['read', 'bash'], gated: [] }
    })
    await tick()

    expect(calls.indexOf('bash:printf command-output')).toBeLessThan(calls.indexOf('prompt'))
    expect(calls.some(call => call.startsWith('context:') && /already run|already executed/i.test(call))).toBe(true)
    expect(calls.filter(call => call.startsWith('bash:'))).toHaveLength(1)
    expect(events.find(event => event.type === 'tool.completed')?.payload).toMatchObject({
      name: 'bash', ok: true, output: 'command output'
    })
  })

  it('gives a retry the prior native Bash result without executing the command again', async () => {
    const calls: string[] = []
    const { run, events } = setup(async ({ gate }) => {
      const session = fakeSession(async () => { calls.push('prompt') }, gate)
      session.executeBash = async command => {
        calls.push(`bash:${command}`)
        return { output: '', exitCode: 0, cancelled: false, truncated: false }
      }
      session.sendCustomMessage = async message => { calls.push(`context:${message.content}`) }
      return session
    })

    await run('initial-bash-retry', {
      run: { id: 'initial-bash-retry', sessionId: 'agent-1', trigger: 'user' },
      text: '!printf command-output',
      initialBashContext: { runId: 'initial-bash-first', status: 'completed', ok: true, output: 'command output' }
    })
    await tick()

    expect(calls.filter(call => call.startsWith('bash:'))).toHaveLength(0)
    const contextIndex = calls.findIndex(call => call.startsWith('context:') && call.includes("initial ! command was already attempted"))
    expect(calls[contextIndex]).toContain('command output')
    expect(calls[contextIndex]).toMatch(/Do not execute it again automatically/)
    expect(events.some(event => event.type === 'tool.started' || event.type === 'tool.completed')).toBe(false)
    expect(contextIndex).toBeGreaterThanOrEqual(0)
    expect(contextIndex).toBeLessThan(calls.indexOf('prompt'))
  })

  it('rejects a prior Bash result combined with a new Bash execution request', async () => {
    let opened = false
    const { run } = setup(async ({ gate }) => {
      opened = true
      return fakeSession(async () => undefined, gate)
    })
    await expect(run('initial-bash-conflict', {
      text: '!printf twice', initialBashCommand: 'printf twice',
      initialBashContext: { runId: 'initial-bash-first', status: 'completed', output: 'already ran' }
    })).rejects.toMatchObject({ message: expect.stringContaining('prior Bash result') })
    expect(opened).toBe(false)
  })

  it('rejects initial Bash execution for a retry trigger', async () => {
    let opened = false
    const { run } = setup(async ({ gate }) => {
      opened = true
      return fakeSession(async () => undefined, gate)
    })
    await expect(run('initial-bash-retry', {
      run: { id: 'initial-bash-retry', sessionId: 'agent-1', trigger: 'retry' },
      text: '!printf once', initialBashCommand: 'printf once'
    })).rejects.toMatchObject({ message: expect.stringContaining('new interactive user turn') })
    expect(opened).toBe(false)
  })

  it('rejects image-required turns before any prompt reaches a text-only model', async () => {
    let requested = false
    let disposed = false
    const { run, harness } = setup(async ({ gate }) => ({
      ...fakeSession(async () => { requested = true }, gate),
      model: { input: ['text'] },
      dispose: () => { disposed = true }
    }))
    expect(await run('image-unsupported', { requiresImageInput: true })).toEqual({ runId: 'image-unsupported', nativeSessionId: null })
    expect(requested).toBe(false)
    expect(disposed).toBe(true)
    expect(loadRun(harness.env.root, 'image-unsupported')).toMatchObject({ status: 'failed', terminalReason: expect.stringContaining('supports images') })
  })

  it('passes image pixels using Pi image content fields with the existing stable prefix', async () => {
    let observed: unknown
    const { run } = setup(async ({ gate }) => ({
      ...fakeSession(async () => undefined, gate),
      model: { input: ['text', 'image'] },
      prompt: async (_text, options) => { observed = options }
    }))
    await run('image-supported', { requiresImageInput: true, images: [{ mediaType: 'image/png', data: 'cGl4ZWxz' }] })
    await tick()
    expect(observed).toEqual({ images: [{ type: 'image', mimeType: 'image/png', data: 'cGl4ZWxz' }] })
  })

  it('saves the context update in native history before the request, without another model turn', async () => {
    const delivered: unknown[] = []
    const { run, events, harness } = setup(async ({ gate, params }) => ({
      ...fakeSession(async () => undefined, gate),
      sendCustomMessage: async (message, options) => void delivered.push({ type: message.customType, display: message.display, options, snapshot: Object.keys(message.details as object) }),
      prompt: async (text) => void delivered.push({ text, system: params.system.startsWith('# Xingular Agent context\n') })
    }))
    const started = await run('context-run', { preamble: '[Group context]', text: 'The user request' })
    await tick()
    expect(started).toEqual({ runId: 'context-run', nativeSessionId: 'native-1' })
    expect(delivered).toEqual([
      { type: 'xingular-context', display: false, options: { triggerTurn: false }, snapshot: ['xingularContext'] },
      { text: '[Group context]\n\nThe user request', system: true }
    ])
    expect(events.filter((event) => event.type === 'usage.updated')).toHaveLength(0)
    expect(events.at(-1)?.type).toBe('completed')
    expect(loadRun(harness.env.root, 'context-run')).toMatchObject({ status: 'completed', nativeSessionId: 'native-1', mode: 'chat', harness: 'pi', goal: 'The user request', agentId: 'agent-1' })
    expect(readEvents(harness.env.root, 'context-run').map((event) => event.sequence)).toEqual(events.map((_, index) => index))
  })

  it('streams Pi events as contract events and completes', async () => {
    const { events, run } = setup(async ({ gate }) =>
      fakeSession(async (emit) => {
        emit({ type: 'message_start', message: { role: 'assistant' } })
        emit({ type: 'message_update', message: { role: 'assistant' }, assistantMessageEvent: { type: 'text_delta', delta: 'Hi' } })
        emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }], usage: { input: 3, output: 1 } } })
      }, gate)
    )
    await run('run-1')
    await tick()
    expect(events.map((event) => event.type)).toEqual(['started', 'status.changed', 'context.snapshot', 'message.delta', 'message.completed', 'usage.updated', 'completed'])
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('reports cache, reasoning, cost and context size across the requests of a reply', async () => {
    const { events, run } = setup(async ({ gate }) => ({
      ...fakeSession(async (emit) => {
        emit({ type: 'message_end', message: { role: 'assistant', content: [], model: 'sonnet', provider: 'anthropic', usage: { input: 10, output: 4, cacheRead: 100, cacheWrite: 20, reasoning: 1, cost: { total: 0.01 } } } })
        emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }], model: 'sonnet', provider: 'anthropic', usage: { input: 5, output: 6, cacheRead: 130, cacheWrite: 0, reasoning: 2, cost: { total: 0.02 } } } })
        emit({ type: 'message_end', message: { role: 'assistant', content: [], usage: { input: 1, output: 1 } } })
      }, gate),
      model: { input: ['text'], contextWindow: 200_000 }
    }))
    await run('run-1')
    await tick()
    const usage = events.filter((event) => event.type === 'usage.updated').map((event) => event.payload as Record<string, unknown>)
    expect(usage[1]).toMatchObject({ inputTokens: 15, outputTokens: 10, cacheReadTokens: 230, cacheWriteTokens: 20, reasoningTokens: 3, requests: 2, contextTokens: 135, contextWindow: 200_000, model: 'sonnet', provider: 'anthropic' })
    expect(usage[1].costUsd).toBeCloseTo(0.03)
    // A request without the optional figures leaves the running totals intact.
    expect(usage[2]).toMatchObject({ inputTokens: 16, cacheReadTokens: 230, reasoningTokens: 3, requests: 3, contextTokens: 1 })
    expect(usage[2]).not.toHaveProperty('model')
  })

  it('reports each model request on its own, with its model, cost and timing', async () => {
    const { events, run } = setup(async ({ gate }) =>
      fakeSession(async (emit) => {
        emit({ type: 'turn_start' })
        emit({ type: 'message_update', message: { role: 'assistant' }, assistantMessageEvent: { type: 'thinking_delta' } })
        emit({ type: 'message_end', message: { role: 'assistant', content: [], model: 'sonnet', provider: 'anthropic', responseId: 'resp-1', stopReason: 'toolUse', usage: { input: 10, output: 4, cacheRead: 100, cacheWrite: 20, reasoning: 1, cost: { total: 0.01 } } } })
        emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { path: 'a.md' } })
        emit({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'read', isError: false, result: { content: [{ type: 'text', text: 'x'.repeat(1200) }, { type: 'image' }] } })
        emit({ type: 'turn_start' })
        emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }], model: 'haiku', provider: 'anthropic', usage: { input: 5, output: 6 } } })
      }, gate)
    )
    await run('run-1')
    await tick()
    const requests = events.filter((event) => event.type === 'usage.updated').map((event) => (event.payload as { request: Record<string, unknown> }).request)
    expect(requests[0]).toMatchObject({ index: 1, responseId: 'resp-1', model: 'sonnet', provider: 'anthropic', inputTokens: 10, cacheReadTokens: 100, cacheWriteTokens: 20, outputTokens: 4, reasoningTokens: 1, costUsd: 0.01, costSource: 'harness', stopReason: 'toolUse' })
    expect(requests[0]).not.toHaveProperty('reasoningSummary')
    expect(requests[0].durationMs).toBeGreaterThanOrEqual(0)
    expect(requests[0].ttftMs).toBeGreaterThanOrEqual(0)
    // The second request reported no cost and produced no streamed output.
    expect(requests[1]).toMatchObject({ index: 2, model: 'haiku', inputTokens: 5, outputTokens: 6, cacheReadTokens: 0 })
    for (const key of ['costUsd', 'costSource', 'ttftMs', 'reasoningTokens', 'responseId']) expect(requests[1]).not.toHaveProperty(key)
    const tool = events.find((event) => event.type === 'tool.completed')!.payload as Record<string, unknown>
    // Stored evidence is redacted, which rewrites JSON carried as text in its compact form.
    expect(events.find((event) => event.type === 'tool.started')?.payload).toMatchObject({ toolCallId: 't1', input: '{"path":"a.md"}' })
    expect(tool).toMatchObject({ toolCallId: 't1', ok: true, resultChars: 1200 })
    expect(tool.output).toContain('x'.repeat(1200))
  })

  it('persists only an explicitly captured provider summary without inventing usage figures', async () => {
    const { events, run } = setup(async ({ gate }) =>
      fakeSession(async (emit) => {
        emit({ type: 'turn_start' })
        emit({ type: 'message_end', message: { role: 'assistant', api: 'openai-codex-responses', content: [
          { type: 'thinking', thinkingSignature: JSON.stringify({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'I will check the saved state before changing the file.' }], content: [{ text: 'private reasoning' }], encrypted_content: 'private replay payload' }) },
          { type: 'text', text: 'Done.' }
        ], model: 'gpt-6', provider: 'openai', responseId: 'response-1' } })
      }, gate)
    )
    await run('summary-run')
    await tick()
    const usage = events.find((event) => event.type === 'usage.updated')!.payload as Record<string, unknown>
    expect(usage).toMatchObject({ requests: 1, model: 'gpt-6', provider: 'openai' })
    expect(usage).not.toHaveProperty('inputTokens')
    expect(usage.request).toMatchObject({ index: 1, responseId: 'response-1', reasoningSummary: 'I will check the saved state before changing the file.' })
    expect(usage.request).not.toHaveProperty('outputTokens')
    expect(JSON.stringify(events)).not.toContain('private reasoning')
    expect(JSON.stringify(events)).not.toContain('private replay payload')
  })

  it('records the compiled prompt and schemas for the tools actually declared to the model', async () => {
    const { events, run } = setup(async ({ gate }) => ({
      ...fakeSession(async () => undefined, gate),
      sendCustomMessage: async () => undefined,
      getActiveToolNames: () => ['read'],
      getAllTools: () => [
        { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
        { name: 'write', description: 'Write a file', parameters: { type: 'object' } }
      ]
    }))
    await run('run-1')
    await tick()
    const snapshot = events.find((event) => event.type === 'context.snapshot')!.payload as { systemPrompt: string; contextUpdate: string; tools: unknown[] }
    expect(snapshot.systemPrompt).toContain('## Context updates')
    expect(snapshot.contextUpdate).toContain('[App context update')
    expect(snapshot.tools).toEqual([{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }])
  })

  it('caps saved tool inputs and outputs at 24,000 characters with truncation flags', async () => {
    const large = 'x'.repeat(25_000)
    const { events, run } = setup(async ({ gate }) =>
      fakeSession(async (emit) => {
        emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'computer_type_text', args: { app: 'Editor', text: large } })
        emit({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'computer_type_text', isError: false, result: large })
      }, gate)
    )
    await run('run-1')
    await tick()
    const started = events.find((event) => event.type === 'tool.started')!.payload as { input: string; inputTruncated: boolean }
    const completed = events.find((event) => event.type === 'tool.completed')!.payload as { output: string; outputTruncated: boolean }
    expect([started.inputTruncated, completed.outputTruncated]).toEqual([true, true])
    expect(started.input.length).toBeLessThanOrEqual(24_000)
    expect(completed.output.length).toBeLessThanOrEqual(24_000)
  })

  it('records generic tool attachment references without storing their content bytes', async () => {
    const { events, run } = setup(async ({ gate }) => fakeSession(async (emit) => {
      emit({ type: 'tool_execution_end', toolCallId: 'image-1', toolName: 'capture', isError: false, result: {
        content: [{ type: 'text', text: 'Captured screen.' }, { type: 'image', data: 'model-image-bytes' }],
        details: { attachments: [{ id: 'attachment-1', name: 'Screen capture', mimeType: 'image/jpeg' }] }
      } })
      emit({ type: 'tool_execution_end', toolCallId: 'image-2', toolName: 'capture', isError: false, result: {
        content: [{ type: 'text', text: 'Invalid attachment metadata was ignored.' }],
        details: { attachments: [{ id: 'attachment-2', name: 'Capture', mimeType: 'image/jpeg', data: 'must-not-persist' }] }
      } })
    }, gate))

    await run('attachments-run')
    await tick()
    const completed = events.filter((event) => event.type === 'tool.completed').map((event) => event.payload as Record<string, unknown>)
    expect(completed[0]?.attachments).toEqual([{ id: 'attachment-1', name: 'Screen capture', mimeType: 'image/jpeg' }])
    expect(completed[1]).not.toHaveProperty('attachments')
    expect(JSON.stringify(events)).not.toContain('model-image-bytes')
    expect(JSON.stringify(events)).not.toContain('must-not-persist')
  })

  it('records bounded retry and compaction events without exposing thinking text', async () => {
    const { events, run } = setup(async ({ gate }) =>
      fakeSession(async (emit) => {
        emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 250, errorMessage: 'Temporary failure' } as unknown as PiEvent)
        emit({ type: 'auto_retry_end', attempt: 1, success: true } as unknown as PiEvent)
        emit({ type: 'compaction_start', reason: 'threshold' } as unknown as PiEvent)
        emit({ type: 'compaction_end', reason: 'threshold', aborted: false, willRetry: true, result: { summary: 'kept the latest messages' } } as unknown as PiEvent)
      }, gate)
    )
    await run('run-1')
    await tick()
    expect(events.filter((event) => event.type.startsWith('retry.') || event.type.startsWith('compaction.')).map((event) => event.type)).toEqual(['retry.started', 'retry.ended', 'compaction.started', 'compaction.ended'])
    expect(events.find((event) => event.type === 'compaction.ended')?.payload).toMatchObject({ aborted: false, willRetry: true, summary: '{"summary":"kept the latest messages"}' })
  })

  it('leaves out the cost and reasoning figures nobody reported', async () => {
    const { events, run } = setup(async ({ gate }) => fakeSession(async (emit) => emit({ type: 'message_end', message: { role: 'assistant', content: [], usage: { input: 1, output: 1 } } }), gate))
    await run('run-1')
    await tick()
    const usage = events.find((event) => event.type === 'usage.updated')!.payload as Record<string, unknown>
    for (const key of ['costUsd', 'reasoningTokens', 'contextWindow']) expect(usage).not.toHaveProperty(key)
    expect(usage.request).not.toHaveProperty('durationMs')
  })

  it('pauses gated tools for approval and blocks on deny', async () => {
    let blockReason: string | null | undefined
    const { events, run, harness } = setup(async ({ gate }) => fakeSession(async (_emit, check) => void (blockReason = await check()), gate))
    await run('run-2', { text: 'list files' })
    await tick()
    const approval = events.find((event) => event.type === 'approval.requested')!.payload as { approvalId: string }
    expect(approval).toMatchObject({ target: 'bash', action: 'ls', rememberable: true })
    expect(loadRun(harness.env.root, 'run-2').status).toBe('waiting_for_approval')
    harness.runs.resolveApproval('run-2', approval.approvalId, 'denied')
    await tick()
    expect(blockReason).toMatch(/denied/)
    expect(events.some((event) => event.type === 'approval.resolved')).toBe(true)
  })

  it("asks before a tool an extension brought, and relays the extension's question and notice as run events", async () => {
    let blockReason: string | null | undefined
    let answered: unknown
    const { events, run, harness } = setup(async ({ gate, extensions }) => ({
      ...fakeSession(async () => undefined, gate),
      prompt: async () => {
        // What a loaded extension does: registers a tool nobody switched on by name, shows a line, and asks.
        gate.ask?.(['kit_scan'])
        extensions!.notice({ kind: 'status', key: 'kit', text: 'Scanning' })
        answered = await extensions!.ask({ question: 'Scan the whole folder?', options: [{ label: 'Yes' }, { label: 'No', recommended: true }], multiSelect: false, allowText: false })
        blockReason = await gate.check('kit_scan', { path: '.' })
      }
    }))
    await run('run-ext', { text: 'scan' })
    await tick()
    expect(events.find((event) => event.type === 'extension.notice')?.payload).toEqual({ kind: 'status', key: 'kit', text: 'Scanning' })
    const question = events.find((event) => event.type === 'question.requested')!.payload as { questionId: string }
    expect(question).toMatchObject({ question: 'Scan the whole folder?' })
    harness.runs.answerQuestion('run-ext', question.questionId, { selected: ['Yes'] })
    await tick()
    expect(answered).toEqual({ selected: ['Yes'] })
    const approval = events.find((event) => event.type === 'approval.requested')!.payload as { approvalId: string }
    expect(approval).toMatchObject({ target: 'kit_scan' })
    harness.runs.resolveApproval('run-ext', approval.approvalId, 'approved')
    await tick()
    expect(blockReason).toBeNull()
  })

  it('gives an unattended run no extension interface', async () => {
    let offered: unknown = 'unset'
    const { run } = setup(async ({ gate, extensions }) => {
      offered = extensions
      return fakeSession(async () => undefined, gate)
    })
    await run('run-auto-ext', { text: 'tidy', automatic: true })
    await tick()
    expect(offered).toBeUndefined()
  })

  it('skips the prompt for a tool the user already allowed in this session', async () => {
    let blockReason: string | null | undefined
    const { events, run, harness } = setup(async ({ gate }) => fakeSession(async (_emit, check) => void (blockReason = await check()), gate))
    harness.approvals.remember('agent-1', 'bash')
    await run('run-auto', { text: 'list files' })
    await tick()
    expect(blockReason).toBeNull()
    expect(events.find((event) => event.type === 'approval.requested')?.payload).toMatchObject({ target: 'bash', rememberable: true, automatic: 'remembered' })
    expect(events.find((event) => event.type === 'approval.resolved')?.payload).toMatchObject({ decision: 'approved', automatic: 'remembered' })
    expect(events.some((event) => event.type === 'status.changed' && (event.payload as { status: string }).status === 'waiting_for_approval')).toBe(false)
    expect(events.at(-1)?.type).toBe('completed')
  })

  it('asks a person for a humanOnly call even when the tool was remembered', async () => {
    let blockReason: string | null | undefined
    const policy: ToolPolicy = { scope: async () => ({ allowed: false, requiresApproval: true, humanOnly: true, reason: 'Run this command?' }) }
    const { events, run, harness } = setup(async ({ gate }) => fakeSession(async (_emit, check) => void (blockReason = await check()), gate), policy)
    harness.approvals.remember('agent-1', 'bash')
    harness.approvals.setAuto('chat', true)
    await run('run-human', { text: 'npm install' })
    await tick()
    const requested = events.find((event) => event.type === 'approval.requested')!.payload as { approvalId: string }
    expect(requested).toMatchObject({ target: 'bash', rememberable: false })
    expect(requested).not.toHaveProperty('automatic')
    expect(events.some((event) => event.type === 'status.changed' && (event.payload as { status: string }).status === 'waiting_for_approval')).toBe(true)
    harness.runs.resolveApproval('run-human', requested.approvalId, 'approved')
    await tick()
    expect(blockReason).toBeNull()
  })

  it('lets the Agent chat switch approve humanOnly calls without remembering the tool', async () => {
    let blockReason: string | null | undefined
    const policy: ToolPolicy = { scope: async () => ({ allowed: false, requiresApproval: true, humanOnly: true, allowGlobalApproval: true, reason: 'Run this command?' }) }
    const { events, run, harness } = setup(async ({ gate }) => fakeSession(async (_emit, check) => void (blockReason = await check()), gate), policy)
    harness.approvals.setAuto('chat', true)
    await run('run-human-auto', { text: 'run command' })
    await tick()
    expect(blockReason).toBeNull()
    expect(events.find((event) => event.type === 'approval.requested')?.payload).toMatchObject({ target: 'bash', rememberable: false, automatic: 'always' })
    expect(events.find((event) => event.type === 'approval.resolved')?.payload).toMatchObject({ decision: 'approved', automatic: 'always' })
    expect(events.some((event) => event.type === 'status.changed' && (event.payload as { status: string }).status === 'waiting_for_approval')).toBe(false)
  })

  it('requires per-operation approval for outside writes despite remembered tool grants', async () => {
    let blockReason: string | null | undefined
    let outsidePath = ''
    const { events, run, harness } = setup(async ({ gate }) => fakeSession(async () => {
      blockReason = await gate.check('write', { path: outsidePath })
    }, gate))
    outsidePath = join(harness.env.root, '..', 'outside-workspace.txt')
    harness.approvals.remember('agent-1', 'write')

    await run('run-outside-write')
    await tick()

    const request = events.find((event) => event.type === 'approval.requested')!.payload as { approvalId: string }
    expect(request).toMatchObject({ target: 'write', rememberable: false })
    expect(request).not.toHaveProperty('automatic')
    expect(events.some((event) => event.type === 'status.changed' && (event.payload as { status: string }).status === 'waiting_for_approval')).toBe(true)
    harness.runs.resolveApproval('run-outside-write', request.approvalId, 'denied')
    await tick()
    expect(blockReason).toMatch(/user denied this action/i)
  })

  it('bypasses the Bash workspace boundary only with Full Permission on interactive user runs', async () => {
    const bypasses: boolean[] = []
    const { run, harness } = setup(async ({ gate }) => {
      bypasses.push(await gate.workspaceBoundaryBypass?.('bash', { command: 'touch ../outside-workspace.txt' }) ?? false)
      return fakeSession(async () => undefined, gate)
    })
    harness.approvals.remember('agent-1', 'bash')

    await run('run-without-full-permission')
    await tick()
    expect(bypasses.at(-1)).toBe(false)

    harness.approvals.setAuto('chat', true)
    await run('run-with-full-permission')
    await tick()
    expect(bypasses.at(-1)).toBe(true)

    await run('run-automatic-with-full-permission', { automatic: true })
    await tick()
    expect(bypasses.at(-1)).toBe(false)

    await run('run-probe-with-full-permission', { run: { id: 'run-probe-with-full-permission', sessionId: 'agent-1', trigger: 'probe' } })
    await tick()
    expect(bypasses.at(-1)).toBe(false)
  })

  it('requires a nonrememberable pre-execution approval for explicit outside-scope Bash', async () => {
    let approved: boolean | undefined
    const command = `${'printf x; '.repeat(30)}touch ../outside-workspace.txt`
    const { events, run, harness } = setup(async ({ gate }) => fakeSession(async () => {
      approved = await gate.requestWorkspaceWriteScope?.('bash', { command, workspaceWriteScope: 'outside' }, 'This command requests outside-workspace writes before it runs.')
    }, gate))
    harness.approvals.remember('agent-1', 'bash')

    await run('run-explicit-outside-scope')
    await tick()

    const request = events.find((event) => event.type === 'approval.requested')!.payload as { approvalId: string; action: string }
    expect(request).toMatchObject({ target: 'workspace-write', rememberable: false })
    expect(request.action).toContain(command)
    expect(request).not.toHaveProperty('automatic')
    harness.runs.resolveApproval('run-explicit-outside-scope', request.approvalId, 'approved')
    await tick()
    expect(approved).toBe(true)
  })

  it('rechecks host hard denials after an outside Bash approval', async () => {
    let scopeAllowed = true
    let approved: boolean | undefined
    const policy: ToolPolicy = { scope: async () => ({ allowed: scopeAllowed }) }
    const { events, run, harness } = setup(async ({ gate }) => fakeSession(async () => {
      approved = await gate.requestWorkspaceWriteScope?.('bash', { command: 'touch ../outside.txt', workspaceWriteScope: 'outside' }, 'Outside scope requested before execution.')
    }, gate), policy)

    await run('run-outside-policy-recheck')
    await tick()
    const request = events.find((event) => event.type === 'approval.requested')!.payload as { approvalId: string }
    scopeAllowed = false
    harness.runs.resolveApproval('run-outside-policy-recheck', request.approvalId, 'approved')
    await tick()

    expect(approved).toBe(false)
  })

  it('still asks when the application cannot say what is allowed', async () => {
    const { events, run } = setup(async ({ gate }) => fakeSession(async (_emit, check) => void (await check()), gate), { approval: async () => { throw new Error('down') } })
    await run('run-ask', { text: 'list files' })
    await tick()
    expect(events.some((event) => event.type === 'status.changed' && (event.payload as { status: string }).status === 'waiting_for_approval')).toBe(true)
    expect(events.some((event) => event.type === 'approval.resolved')).toBe(false)
  })

  it('lets the application refuse a call that is outside an unattended run\'s scope, and switch a tool off', async () => {
    const reasons: (string | null)[] = []
    let authorized = 0
    const policy: ToolPolicy = {
      scope: async ({ tool }) => ({ automatic: true, allowed: tool !== 'bash', reason: 'Scheduled workers may use scoped file tools only.' }),
      authorize: async () => {
        authorized += 1
        if (authorized > 1) throw new Error('Tool unavailable in the app settings.')
      }
    }
    const { run, harness } = setup(async ({ gate }) => fakeSession(async () => {
      reasons.push(await gate.check('bash', {}), await gate.check('read', {}), await gate.check('read', {}))
    }, gate), policy)
    harness.approvals.setAuto('chat', true)
    await run('run-scope')
    await tick()
    expect(reasons).toEqual(['Scheduled workers may use scoped file tools only.', null, 'Tool unavailable in the app settings.'])
  })

  it('forwards opaque caller policy context to the application tool policy', async () => {
    const contexts: unknown[] = []
    const policy: ToolPolicy = {
      scope: async ({ caller }) => {
        contexts.push(caller.policyContext)
        return { allowed: true }
      }
    }
    const { run } = setup(async ({ gate }) => fakeSession(async (_emit, check) => void (await check()), gate), policy)
    const policyContext = { delegatesTo: ['worker-1'], snapshot: 'run-start' }
    await run('run-policy-context', {
      caller: { agentId: 'agent-1', agentName: 'Helper', actor: 'Chat', policyContext }
    })
    await tick()
    expect(contexts).toEqual([policyContext])
  })

  it('refuses unsafe calls, allows explicitly safe research calls, and preserves normal runs', async () => {
    const seen: { system: string; update: string | null; plan: boolean; reasons: (string | null)[] }[] = []
    const { run, harness } = setup(async ({ gate, params }) => fakeSession(async () => {
      const reasons = [
        await gate.check('bash', { command: 'git log', workspaceWriteScope: 'outside' }), await gate.check('write', {}), await gate.check('memory_append', {}),
        await gate.check('lookup', {}), await gate.check('change', {}),
        await gate.check('browser', { op: 'navigate' }), await gate.check('browser', { op: 'click' }),
        await gate.check('mcp_call_tool', {}), await gate.check('bash', { command: 'git log --oneline' })
      ]
      seen.push({ system: params.system, update: params.update?.content ?? null, plan: params.plan === true, reasons })
    }, gate))
    harness.approvals.setAuto('chat', true)
    harness.sessions.provide(() => [
      { name: 'lookup', label: 'Lookup', description: 'Reads', readOnly: true, parameters: (Type) => Type.Object({}), execute: async () => 'ok' },
      { name: 'change', label: 'Change', description: 'Writes', parameters: (Type) => Type.Object({}), execute: async () => 'ok' },
      { name: 'browser', label: 'Research browser', description: 'Research', planModeSafe: (input) => input.op === 'navigate' || input.op === 'scroll', parameters: (Type) => Type.Object({ op: Type.String() }), execute: async () => 'ok' }
    ])
    const allowedTools = ['read', 'bash', 'write', 'lookup', 'change', 'browser', 'mcp_call_tool']
    await run('plan-run', { plan: true, tools: { allow: allowedTools } })
    await tick()
    await run('normal-run', { tools: { allow: allowedTools } })
    await tick()
    const [planned, normal] = seen
    expect(planned.reasons[0]).toContain('Plan mode Bash is read-only')
    expect(planned.reasons.slice(1).map((reason) => reason?.startsWith('Plan mode is research-only') ?? null)).toEqual([true, true, null, true, null, true, true, null])
    expect(planned.plan).toBe(true)
    expect(normal.plan).toBe(false)
    expect(normal.reasons.slice(1)).toEqual([null, null, null, null, null, null, null, null])
    expect(planned.system).toBe(normal.system)
    expect(planned.update).toContain('<proposed_plan>')
    expect(planned.update).toContain('browser')
    expect(normal.update ?? '').not.toContain('Plan mode is on')
  })

  it('re-asks once when an attended plan reply lacks its plan block', async () => {
    const repairs: { customType: string; display: boolean; triggerTurn: boolean }[] = []
    const first = 'I propose a plan.\n# Fix the composer\n\n1. Patch it.'
    const repaired = '<proposed_plan># Fix the composer\n\n1. Patch it.</proposed_plan>'
    const { events, run, harness } = setup(async () => planRepairSession(first, repaired, repairs))

    await run('plan-repair', { plan: true, tools: { allow: ['read'] } })
    await tick()

    expect(repairs).toEqual([{ customType: PLAN_REPAIR_CUSTOM_TYPE, display: false, triggerTurn: true }])
    expect(events.filter(event => event.type === 'message.completed' && (event.payload as { role?: string }).role === 'assistant').map(event => (event.payload as { text?: string }).text)).toEqual([first, repaired])
    expect(loadRun(harness.env.root, 'plan-repair').status).toBe('completed')
  })

  it('does not re-ask when a plan reply already has its plan block', async () => {
    const repairs: { customType: string; display: boolean; triggerTurn: boolean }[] = []
    const plan = '<proposed_plan># Fix the composer\n\n1. Patch it.</proposed_plan>'
    const { events, run } = setup(async () => planRepairSession(plan, null, repairs))

    await run('plan-already-tagged', { plan: true, tools: { allow: ['read'] } })
    await tick()

    expect(repairs).toEqual([])
    expect(events.filter(event => event.type === 'message.completed' && (event.payload as { role?: string }).role === 'assistant')).toHaveLength(1)
  })

  it('accepts unavailable-input blockers directly or after repair without warning', async () => {
    for (const [id, first, repaired, count] of [
      ['direct-blocked', '<plan_blocked>User input is unavailable.</plan_blocked>', null, 0],
      ['repaired-blocked', 'Input is unavailable.', '<plan_blocked>User input is unavailable.</plan_blocked>', 1],
      ['legacy-repaired', '<plan_clarification>Which option?</plan_clarification>', '<proposed_plan># Plan\nSteps</proposed_plan>', 1]
    ] as const) {
      const repairs: { customType: string; display: boolean; triggerTurn: boolean }[] = []
      const { events, run, harness } = setup(async () => planRepairSession(first, repaired, repairs))
      await run(id, { plan: true, tools: { allow: ['read'] } })
      await tick()
      expect(repairs).toHaveLength(count)
      expect(events.filter(event => event.type === 'extension.notice')).toHaveLength(0)
      expect(loadRun(harness.env.root, id).status).toBe('completed')
    }
  })

  it('accepts a plan after a repair turn asks the user', async () => {
    const repairs: { customType: string; display: boolean; triggerTurn: boolean }[] = []
    const plan = '<proposed_plan># Plan\nUse option A.</proposed_plan>'
    const { events, run } = setup(async () => planRepairSession('Which option?', plan, repairs, true))
    await run('repair-with-question', { plan: true })
    await tick()
    expect(repairs).toHaveLength(1)
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool.started', payload: expect.objectContaining({ name: ASK_USER }) }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool.completed', payload: expect.objectContaining({ name: ASK_USER, ok: true }) }))
    expect(events.filter(event => event.type === 'extension.notice')).toHaveLength(0)
  })

  it('keeps a plan run completed and warns when the repair also lacks its plan block', async () => {
    const repairs: { customType: string; display: boolean; triggerTurn: boolean }[] = []
    const first = 'I propose a plan.\n# Fix the composer\n\n1. Patch it.'
    const { events, run, harness } = setup(async () => planRepairSession(first, first, repairs))

    await run('plan-repair-failed', { plan: true, tools: { allow: ['read'] } })
    await tick()

    expect(repairs).toHaveLength(1)
    expect(events).toContainEqual(expect.objectContaining({ type: 'extension.notice', payload: { kind: 'notify', level: 'warning', text: 'The plan reply did not include a valid plan or blocked block.' } }))
    expect(loadRun(harness.env.root, 'plan-repair-failed').status).toBe('completed')
  })

  it('does not repair a normal run, a plan-research child or an unattended plan', async () => {
    const repairs: { customType: string; display: boolean; triggerTurn: boolean }[] = []
    const first = 'A reply without a plan block.'
    const { run } = setup(async () => planRepairSession(first, first, repairs))

    await run('normal-reply', { tools: { allow: ['read'] } })
    await tick()
    await run('plan-child-reply', {
      plan: true,
      run: { id: 'plan-child-reply', sessionId: 'agent-1', relation: 'subagent', parentRunId: 'parent-run' },
      tools: { allow: ['read'], gated: [] },
      subagents: null
    })
    await tick()
    await run('automatic-plan-reply', { plan: true, automatic: true, tools: { allow: ['read'] } })
    await tick()

    expect(repairs).toEqual([])
  })

  it('aborts the Pi session on interrupt', async () => {
    let session: (PiSessionLike & { aborted: boolean }) | null = null
    const { events, run, harness } = setup(async ({ gate }) => (session = fakeSession(() => new Promise((resolve) => setTimeout(resolve, 50)), gate)))
    await run('run-3')
    await tick()
    await harness.runs.interrupt('run-3')
    await tick(80)
    expect(session!.aborted).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'status.changed', payload: { status: 'interrupted' } })
    expect(loadRun(harness.env.root, 'run-3').status).toBe('interrupted')
  })

  it('gives normal sessions the history, Wiki and skill tools and the application\'s tools, but no question tool', async () => {
    let received: Parameters<SessionFactory>[0] | null = null
    const { run, harness } = setup(async (input) => {
      received = input
      return fakeSession(async () => undefined, input.gate)
    })
    harness.sessions.provide(() => [{ name: 'react', label: 'React', description: 'React', parameters: (Type) => Type.Object({}), execute: async () => 'ok' }])
    await run('run-5', { tools: { allow: ['react', ASK_USER] } })
    await tick()
    expect(received!.allow[0]).toBe('react')
    expect(received!.allow).not.toContain(ASK_USER)
    expect(received!.allow).toEqual(expect.arrayContaining(['history_search', 'wiki_search', 'wiki_read', 'skill_load', 'trajectory_read']))
    expect(received!.allow).not.toContain('wiki_write')
    expect(received!.tools.map((tool) => tool.name)).toEqual(['get_capabilities', 'history_search', 'history_read', 'trajectory_search', 'trajectory_read', 'wiki_search', 'wiki_read', 'wiki_list', 'wiki_write', 'skill_load', 'plugin_propose', 'todo_write', 'checkpoint_write', 'session_name', 'spawn_subagent', 'wait_subagents', 'web_search', 'web_fetch', 'browser_navigate', 'browser_snapshot', 'browser_read', 'browser_screenshot', 'browser_click', 'browser_type', 'browser_select', 'browser_press', 'browser_scroll', 'browser_wait', 'browser_tabs', 'page_notes_list', 'page_notes_read', 'react'])
    expect(await received!.tools.find((tool) => tool.name === 'skill_load')!.execute({})).toContain('plugin-authoring')
    expect(received!.params.system).toContain('# Xingular Agent context')
  })

  it('offers ask_user only to attended plan runs, subject to the caller capability set', async () => {
    const seen = new Map<string, { allow: string[]; tools: string[] }>()
    const { run } = setup(async (input) => {
      seen.set(input.params.runId, { allow: [...input.allow], tools: input.tools.map((tool) => tool.name) })
      return fakeSession(async () => undefined, input.gate)
    })
    await run('plan-questions', { plan: true })
    await tick()
    await run('automatic-plan', { plan: true, automatic: true })
    await tick()
    await run('probe-plan', { plan: true, run: { id: 'probe-plan', sessionId: 'agent-1', trigger: 'probe' } })
    await tick()
    await run('improver-plan', { plan: true, run: { id: 'improver-plan', sessionId: 'agent-1', trigger: 'improver' } })
    await tick()
    await run('reflection-plan', { plan: true, run: { id: 'reflection-plan', sessionId: 'agent-1', trigger: 'reflection' } })
    await tick()
    await run('narrow-plan', { plan: true, capabilities: { version: 1, tools: ['read'], connectors: [], contributions: [] } })
    await tick()

    expect(seen.get('plan-questions')!.allow).toContain(ASK_USER)
    expect(seen.get('plan-questions')!.tools).toContain(ASK_USER)
    for (const id of ['automatic-plan', 'probe-plan', 'improver-plan', 'reflection-plan', 'narrow-plan']) {
      expect(seen.get(id)!.allow).not.toContain(ASK_USER)
      expect(seen.get(id)!.tools).not.toContain(ASK_USER)
    }
  })

  it('loads the compaction checkpoint extension in SDK sessions', async () => {
    let extensions: NonNullable<Parameters<SessionFactory>[0]['params']['inline']> = []
    const { run } = setup(async ({ gate, params }) => {
      extensions = params.inline ?? []
      return fakeSession(async () => undefined, gate)
    })
    await run('checkpoint-run', { plan: true })
    await tick()
    expect(extensions.map((extension) => extension.name)).toContain(COMPACTION_CHECKPOINT_EXTENSION)
  })

  it('rehydrates only research-role plan instructions for compacted plan-mode subagents', async () => {
    let checkpointFactory: ((pi: ExtensionAPI) => void | Promise<void>) | undefined
    const { run } = setup(async ({ gate, params }) => {
      const checkpoint = params.inline?.find((extension) => typeof extension !== 'function' && extension.name === COMPACTION_CHECKPOINT_EXTENSION)
      if (checkpoint && typeof checkpoint !== 'function') checkpointFactory = checkpoint.factory as (pi: ExtensionAPI) => void | Promise<void>
      return fakeSession(async () => undefined, gate)
    })
    await run('checkpoint-subagent', {
      run: { id: 'checkpoint-subagent', sessionId: 'agent-1', parentRunId: 'parent-run', relation: 'subagent' },
      plan: true,
      tools: { allow: ['read'], gated: [] },
      subagents: null
    })
    expect(checkpointFactory).toBeDefined()

    const handlers = new Map<string, (event: any) => unknown>()
    const api = { on: (event: string, handler: (event: any) => unknown) => { handlers.set(event, handler); return () => undefined } } as unknown as ExtensionAPI
    await checkpointFactory!(api)
    await handlers.get('before_agent_start')!({ messageType: 'user', prompt: 'Research this bounded question' })
    const result = await handlers.get('context')!({ messages: [{ role: 'compactionSummary', summary: 'Earlier research.', tokensBefore: 50_000, timestamp: 1 }] }) as { messages: { content?: string }[] }
    expect(result.messages.at(-1)?.content).toContain(PLAN_RESEARCH_SUBAGENT_INSTRUCTIONS)
    expect(result.messages.at(-1)?.content).not.toContain('Plan mode is on for this request')
  })

  it('records the todo the model writes, whole, and allows it in plan mode', async () => {
    let received: Parameters<SessionFactory>[0] | null = null
    const { events, run } = setup(async (input) => {
      received = input
      return fakeSession(() => new Promise((resolve) => setTimeout(resolve, 50)), input.gate)
    })
    await run('run-todo', { plan: true })
    await tick()
    expect(await received!.gate.check('todo_write', { items: [] })).toBeNull()
    const tool = received!.tools.find((candidate) => candidate.name === 'todo_write')!
    expect(await tool.execute({ items: [{ text: 'Read the code', status: 'completed' }, { text: 'Write the fix', status: 'in_progress' }] })).toBe('[x] Read the code\n[~] Write the fix')
    expect(await tool.execute({ items: [{ text: '', status: 'pending' }] })).toContain('Every step needs text')
    expect(events.filter((event) => event.type === 'todo.updated').map((event) => event.payload)).toEqual([
      { items: [{ text: 'Read the code', status: 'completed' }, { text: 'Write the fix', status: 'in_progress' }] }
    ])
  })

  it('binds naming to each native session and allows metadata changes in plan mode', async () => {
    const names = new Map<string, string>()
    const { run } = setup(async input => {
      const id = input.params.runId
      return {
        ...fakeSession(async () => {
          const tool = input.tools.find(tool => tool.name === 'session_name')!
          expect(input.allow).toContain('session_name')
          expect(await input.gate.check(tool.name, { name: 'Add web browser integrations' })).toBeNull()
          await tool.execute({ name: 'Add web browser integrations' })
          expect(names.get(id)).toBe('Add web browser integrations')
        }, input.gate),
        get sessionName() { return names.get(id) },
        setSessionName: name => { names.set(id, name) }
      }
    })
    await run('named-plan', { plan: true })
    await tick()
    await run('named-next')
    await tick()
    expect([...names.keys()]).toEqual(['named-plan', 'named-next'])
  })

  it('names an unnamed top-level session from its first substantive request and shows its state', async () => {
    let received: Parameters<SessionFactory>[0] | null = null
    const names = new Map<string, string>()
    const { run } = setup(async input => {
      received = input
      const id = input.params.runId
      return {
        ...fakeSession(async () => undefined, input.gate),
        get sessionName() { return names.get(id) },
        setSessionName: (name: string) => { names.set(id, name) }
      }
    })
    await run('auto-name', { text: 'Please fix the login redirect before release' })
    expect(names.get('auto-name')).toBe('Fix the login redirect before release')
    expect(received!.params.update?.content).toContain('## Session state')
    expect(received!.params.update?.content).toContain('Name: unnamed.')
    expect(received!.params.update?.content).toContain('Todo for this run: The todo list is empty.')
  })

  it('leaves a greeting and a child run unnamed', async () => {
    const names = new Map<string, string>()
    const { run } = setup(async input => {
      const id = input.params.runId
      return {
        ...fakeSession(async () => undefined, input.gate),
        get sessionName() { return names.get(id) },
        setSessionName: (name: string) => { names.set(id, name) }
      }
    })
    await run('greeting', { text: 'hello' })
    await run('child', { text: 'fix the login redirect', run: { id: 'child', sessionId: 'agent-1', relation: 'subagent' } })
    expect(names.get('greeting')).toBeUndefined()
    expect(names.get('child')).toBeUndefined()
  })

  it('does not auto-name when the host refuses session naming', async () => {
    const names = new Map<string, string>()
    const { run } = setup(async input => {
      const id = input.params.runId
      return {
        ...fakeSession(async () => undefined, input.gate),
        get sessionName() { return names.get(id) },
        setSessionName: (name: string) => { names.set(id, name) }
      }
    }, { scope: async () => ({ allowed: false, reason: 'Naming disabled by host' }) })
    await run('auto-denied', { text: 'fix the login redirect' })
    expect(names.get('auto-denied')).toBeUndefined()
  })

  it('honors autoName: false', async () => {
    const names = new Map<string, string>()
    const { run } = setup(async input => {
      const id = input.params.runId
      return {
        ...fakeSession(async () => undefined, input.gate),
        get sessionName() { return names.get(id) },
        setSessionName: (name: string) => { names.set(id, name) }
      }
    })
    await run('auto-off', { text: 'fix the login redirect', autoName: false })
    expect(names.get('auto-off')).toBeUndefined()
  })

  it('applies host restrictions to session naming', async () => {
    let received: Parameters<SessionFactory>[0] | undefined
    const { run } = setup(async input => {
      received = input
      return fakeSession(async () => undefined, input.gate)
    }, { scope: async () => ({ allowed: false, reason: 'Naming disabled by host' }) })
    await run('name-denied', { plan: true })
    expect(await received!.gate.check('session_name', { name: 'Inspect browser tools' })).toBe('Naming disabled by host')
  })

  it('gives no todo tool when the harness tools are off', async () => {
    let received: Parameters<SessionFactory>[0] | null = null
    const { run } = setup(async (input) => {
      received = input
      return fakeSession(async () => undefined, input.gate)
    })
    await run('run-no-todo', { harnessTools: false })
    await tick()
    expect(received!.tools.map((tool) => tool.name)).not.toContain('todo_write')
    expect(received!.tools.map((tool) => tool.name)).not.toContain('session_name')
    expect(received!.allow).not.toContain('session_name')
  })

  it('refuses, never asks, when a refinement run reaches a call that needs a person', async () => {
    let check: ((name: string, input: unknown) => Promise<string | null>) | null = null
    const { run, events } = setup(async (input) => {
      check = input.gate.check
      return fakeSession(async () => undefined, input.gate)
    })
    await run('probe-1', { run: { id: 'probe-1', sessionId: 'agent-1', trigger: 'probe' }, tools: { allow: ['read', 'bash'], gated: ['bash'] }, automatic: true })
    await tick()
    expect(await check!('bash', { command: 'rm -rf /' })).toMatch(/^Refused in a refinement run/)
    expect(events.some((event) => event.type === 'approval.requested')).toBe(false)
  })

  it('runs on a pinned variant: its sections, its skills, and its version on the run', async () => {
    let received: Parameters<SessionFactory>[0] | null = null
    const { run, harness } = setup(async (input) => {
      received = input
      return fakeSession(async () => undefined, input.gate)
    })
    const { commit, head } = await import('../variant/store')
    commit(harness.env.root, 'agent-1', {
      'systemprompt.md': 'You review pull requests.\n',
      'guardrails.md': '- When a diff is large, load the `triage` skill.\n',
      'memory.md': '',
      'tool_guidance.md': '',
      'skills/triage/SKILL.md': '---\nname: triage\ndescription: a diff is large\n---\nSplit it by folder.\n',
      'plugins/guard.ts': 'export default function (pi) {}\n'
    }, { kind: 'seed' })
    await run('run-variant', { variant: { scope: 'agent-1' } })
    await tick()
    const record = loadRun(harness.env.root, 'run-variant')
    expect(record).toMatchObject({ variantScope: 'agent-1', variantVersion: head(harness.env.root, 'agent-1')!.fingerprint })
    expect(received!.params.system).toContain('You review pull requests.')
    expect(received!.params.resources!.skillPaths[0]).toMatch(/versions\/[0-9a-f]{16}\/variant\/skills$/)
    // Plugin code waits for trust.
    expect(received!.params.variantExtensions).toEqual([])
    expect(await received!.tools.find((tool) => tool.name === 'skill_load')!.execute({ name: 'triage' })).toContain('Split it by folder.')
  })

  it('refuses missing continuation history before creating a run or opening a session', async () => {
    let called = false
    const { run, events, harness } = setup(async ({ gate }) => {
      called = true
      return fakeSession(async () => undefined, gate)
    })
    await expect(run('resume-run', { resume: { sessionFile: '/tmp/missing-history/saved.jsonl', nativeSessionId: 'native-1' } })).rejects.toMatchObject({ code: 'native_resume_unavailable' })
    expect(called).toBe(false)
    expect(events).toEqual([])
    expect(() => loadRun(harness.env.root, 'resume-run')).toThrow()
  })

  it('fails the run when the session cannot start', async () => {
    const { events, run, harness } = setup(async () => {
      throw new Error('No provider')
    })
    expect(await run('run-4')).toEqual({ runId: 'run-4', nativeSessionId: null })
    expect(events.at(-1)).toMatchObject({ type: 'failed', payload: { message: 'No provider' } })
    expect(loadRun(harness.env.root, 'run-4')).toMatchObject({ status: 'failed', terminalReason: 'No provider' })
  })

  it('needs an account before it records anything', async () => {
    const harness = createHarness({ dataRoot: mkdtempSync(join(tmpdir(), 'harness-data-')), stateDir: mkdtempSync(join(tmpdir(), 'harness-state-')), secrets: memorySecretStore(), sessionFactory: async () => { throw new Error('unreachable') } })
    open.push(harness)
    await expect(harness.sessions.run({ run: { id: 'r', sessionId: 's' }, cwd: '/tmp', sessionDir: join(harness.env.root, 's'), text: 'x', caller: { agentId: 'a' }, tools: { allow: [] } })).rejects.toMatchObject({ code: 'account_required' })
    expect(() => loadRun(harness.env.root, 'r')).toThrow()
  })
})

describe('continuing a run that stopped', () => {
  it('says what the earlier run left, and continues it as a new run with the same pins', async () => {
    let received: Parameters<SessionFactory>[0] | null = null
    const { harness, run, sessionDir } = setup(async (input) => {
      received = input
      return fakeSession(() => new Promise((resolve) => setTimeout(resolve, 400)), input.gate)
    })
    await run('first', { plan: true })
    await tick()
    const firstCapabilities = loadCapabilitySnapshot(harness.env.root, 'first')!
    expect(firstCapabilities.tools).toContain(ASK_USER)
    await received!.tools.find((tool) => tool.name === 'todo_write')!.execute({ items: [{ text: 'Read', status: 'completed' }, { text: 'Fix', status: 'in_progress' }] })
    await harness.runs.interrupt('first')
    await tick(60)
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'saved.jsonl'), `${JSON.stringify({ type: 'session', id: 'native-1' })}\n`)

    const root = harness.env.root
    expect(continuationOf(root, 'missing').reason).toBe('not_found')
    expect(continuationOf(root, 'first', join(root, 'elsewhere'))).toMatchObject({ resumable: false, reason: 'history_missing' })
    const continuation = continuationOf(root, 'first', sessionDir)
    expect(continuation).toMatchObject({ resumable: true, reason: null, status: 'interrupted', resume: { sessionFile: realpathSync(join(sessionDir, 'saved.jsonl')), nativeSessionId: 'native-1' }, todo: [{ text: 'Read', status: 'completed' }, { text: 'Fix', status: 'in_progress' }] })

    await expect(run('wrong-account', { continueFrom: 'first', accountId: 'another' })).rejects.toMatchObject({ code: 'continuation_mismatch' })
    await expect(run('wrong-variant', { continueFrom: 'first', variant: { scope: 'other' } })).rejects.toMatchObject({ code: 'continuation_mismatch' })
    await expect(run('automatic-second', { continueFrom: 'first', automatic: true })).rejects.toMatchObject({ code: 'continuation_mismatch' })
    await expect(run('probe-second', { continueFrom: 'first', run: { id: 'probe-second', sessionId: 'agent-1', trigger: 'probe' } })).rejects.toMatchObject({ code: 'continuation_mismatch' })

    await run('second', { continueFrom: 'first', text: '' })
    await tick()
    expect(received!.params.text).toBe('Continue from where you stopped.')
    expect(received!.params.update?.content).toContain('stopped before it finished')
    expect(received!.params.update?.content).toContain('[~] Fix')
    expect(received!.params.historyFile).toBe(realpathSync(join(sessionDir, 'saved.jsonl')))
    expect(loadRun(root, 'second')).toMatchObject({ resumedFromRunId: 'first', accountId: loadRun(root, 'first').accountId })
    expect(received!.allow).toContain(ASK_USER)
    expect(loadCapabilitySnapshot(root, 'second')).toEqual(firstCapabilities)
    await harness.runs.interrupt('second')
  })

  it('refuses to continue a run that completed or is still going', async () => {
    const { harness, run, sessionDir } = setup(async (input) => fakeSession(async () => undefined, input.gate))
    await run('done')
    await tick()
    expect(continuationOf(harness.env.root, 'done', sessionDir).reason).toBe('completed')
    await expect(run('again', { continueFrom: 'done' })).rejects.toMatchObject({ code: 'continuation_unavailable' })
  })

  it('withdraws the continuation section once it was delivered', () => {
    expect(continuationSection(null, false)).toBeNull()
    expect(continuationSection(null, true)).toMatchObject({ id: 'continuation', body: null, dynamic: true })
  })
})

describe('history selection', () => {
  it('opens the newest history, or exactly the recorded one for a continuation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'context-history-'))
    expect(selectHistory({ sessionDir: dir })).toBeNull()
    expect(selectHistory({ sessionDir: join(dir, 'missing') })).toBeNull()
    const first = join(dir, 'first.jsonl')
    const newer = join(dir, 'newer.jsonl')
    writeFileSync(first, `${JSON.stringify({ type: 'session', id: 'first' })}\n`)
    writeFileSync(newer, `${JSON.stringify({ type: 'session', id: 'newer' })}\n`)
    writeFileSync(join(dir, 'notes.txt'), '')
    utimesSync(newer, new Date(Date.now() + 1000), new Date(Date.now() + 1000))
    utimesSync(join(dir, 'notes.txt'), new Date(Date.now() + 5000), new Date(Date.now() + 5000))
    expect(selectHistory({ sessionDir: dir })).toBe(realpathSync(newer))
    expect(selectHistory({ sessionDir: dir, resume: { sessionFile: first, nativeSessionId: 'first' } })).toBe(realpathSync(first))
    expect(() => selectHistory({ sessionDir: dir, resume: { sessionFile: first, nativeSessionId: 'newer' } })).toThrow(/saved conversation/)
    expect(() => selectHistory({ sessionDir: dir, resume: { sessionFile: join(dir, 'missing'), nativeSessionId: 'first' } })).toThrow(/saved conversation/)
    expect(() => selectHistory({ sessionDir: dir, resume: { sessionFile: first } })).toThrow(/saved conversation/)
    const outside = join(mkdtempSync(join(tmpdir(), 'other-history-')), 'outside.jsonl')
    writeFileSync(outside, `${JSON.stringify({ type: 'session', id: 'outside' })}\n`)
    expect(() => selectHistory({ sessionDir: dir, resume: { sessionFile: outside, nativeSessionId: 'outside' } })).toThrow(/saved conversation/)
  })

  it('never opens a newest file that is not a native history', () => {
    const dir = mkdtempSync(join(tmpdir(), 'context-history-'))
    writeFileSync(join(dir, 'broken.jsonl'), 'not json\n')
    expect(() => selectHistory({ sessionDir: dir })).toThrow(/saved conversation/)
  })
})

describe('subagents', () => {
  it('starts a child run of the same caller with no more tools than its parent, and returns its result', async () => {
    const seen = new Map<string, { allow: string[]; tools: string[]; depth: string | null }>()
    let parentResult: unknown = null
    const { harness, run } = setup(async ({ gate, params, allow, tools }) => {
      seen.set(params.runId, { allow: [...allow], tools: tools.map((tool) => tool.name), depth: null })
      return fakeSession(async (emit) => {
        if (params.runId === 'parent') {
          const spawn = tools.find((tool) => tool.name === 'spawn_subagent')!
          expect(await spawn.execute({ title: 'Find the bug', brief: 'Find the bug', tools: ['bash', 'web'] })).toMatch(/cannot have tools you do not have: web/)
          parentResult = await spawn.execute({ title: 'Find the bug', brief: 'Find the bug', tools: ['read'], wait: true })
          return
        }
        emit({ type: 'message_start', message: { role: 'assistant' } })
        emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Found it in parser.ts' }] } })
      }, gate)
    })
    await run('parent', { subagents: { maxDepth: 1 } })
    for (let attempt = 0; attempt < 50 && !parentResult; attempt++) await tick()
    expect(parentResult).toMatchObject({ text: expect.stringContaining('Found it in parser.ts'), details: expect.any(Object) })
    expect(seen.get('parent')!.allow).toContain('spawn_subagent')
    const [childId] = [...seen.keys()].filter((id) => id !== 'parent')
    const child = seen.get(childId)!
    expect(child.allow).toContain('read')
    expect(child.allow).not.toContain('bash')
    expect(child.allow).not.toContain('session_name')
    // At the depth limit the child cannot start subagents of its own.
    expect(child.allow).not.toContain('spawn_subagent')
    expect(loadRun(harness.env.root, childId)).toMatchObject({ parentRunId: 'parent', relation: 'subagent', agentId: 'agent-1', status: 'completed' })
  })

  it('exposes native child runs, freezes the launch, respects nesting, and settles waiters on parent stop', async () => {
    const seen = new Map<string, string[]>()
    const { harness, run } = setup(async ({ gate, params, allow }) => {
      seen.set(params.runId, [...allow])
      return fakeSession(async () => new Promise<void>(() => undefined), gate)
    })
    const subagents = { maxDepth: 2, maxChildren: 5, maxUnprofiled: 5 }
    const starting = run('parent', { subagents })
    subagents.maxDepth = 3
    await starting
    await expect(harness.sessions.spawnSubagent({ parentRunId: 'parent', brief: 'Bad tools', tools: ['outside'] })).rejects.toMatchObject({ code: 'invalid_request' })
    const child = await harness.sessions.spawnSubagent({ parentRunId: 'parent', brief: 'Search' })
    const grandchild = await harness.sessions.spawnSubagent({ parentRunId: child.runId, brief: 'Review' })
    expect(seen.get(child.runId)).toContain('spawn_subagent')
    expect(seen.get(grandchild.runId)).not.toContain('spawn_subagent')
    await expect(harness.sessions.spawnSubagent({ parentRunId: grandchild.runId, brief: 'Too deep' })).rejects.toMatchObject({ code: 'invalid_request' })
    const narrowed = await harness.sessions.spawnSubagent({ parentRunId: 'parent', brief: 'Read only', tools: ['read'] })
    expect(seen.get(narrowed.runId)).toEqual(['read'])
    const settled = Promise.all([child, grandchild, narrowed].map(({ runId }) => harness.runs.wait(runId)))
    await harness.runs.interrupt('parent')
    await settled
    for (const { runId } of [child, grandchild, narrowed]) expect(loadRun(harness.env.root, runId).status).toBe('interrupted')
    await expect(harness.sessions.spawnSubagent({ parentRunId: 'parent', brief: 'Too late' })).rejects.toMatchObject({ code: 'run_not_active' })
    await harness.runs.wait(child.runId)
  })

  it('settles a failed child and attributes the tool to the Harness plugin', async () => {
    const { harness, run } = setup(async ({ gate, params }) => {
      if (params.runId !== 'parent') throw new Error('No provider')
      return fakeSession(async () => new Promise<void>(() => undefined), gate)
    })
    await run('parent', { subagents: {} })
    const child = await harness.sessions.spawnSubagent({ parentRunId: 'parent', brief: 'Try' })
    await harness.runs.wait(child.runId)
    expect(loadRun(harness.env.root, child.runId)).toMatchObject({ status: 'failed', parentRunId: 'parent', terminalReason: 'No provider' })
    const { HARNESS_PLUGINS } = await import('../plugins/builtin')
    expect(HARNESS_PLUGINS.find((plugin) => plugin.id === 'subagents')?.tools).toContainEqual(expect.objectContaining({ name: 'spawn_subagent' }))
  })

  it('can explicitly disable subagents and run without the application\'s tool providers', async () => {
    const offered: string[][] = []
    const { harness, run } = setup(async ({ gate, tools }) => {
      offered.push(tools.map((tool) => tool.name))
      return fakeSession(async () => undefined, gate)
    })
    harness.sessions.provide(() => [{ name: 'app_tool', label: 'App', description: 'An app tool', parameters: (Type) => Type.Object({}), execute: async () => 'ok' }])
    await run('plain', { tools: { allow: ['app_tool'] }, subagents: null })
    await run('solo', { tools: { allow: ['app_tool'] }, providers: false })
    await tick()
    expect(offered[0]).toContain('app_tool')
    expect(offered[0]).not.toContain('spawn_subagent')
    expect(offered[1]).not.toContain('app_tool')
  })
})

describe('standing approvals', () => {
  const policy = { auto: { pi: true }, globalTools: {}, remembered: { 'pane-1': ['shell'] } }
  const facts = (unattended: boolean, readOnly: boolean): ApprovalFacts => ({ unattended, readOnly })

  it('the switch reaches attended sessions but not unattended or read-only ones', () => {
    expect(grant(policy, 'pi', 'pane-1', 'edit files', facts(false, false))).toBe('always')
    expect(grant(policy, 'pi', 'pane-1', 'edit files', facts(true, false))).toBeNull()
    expect(grant(policy, 'pi', 'pane-1', 'edit files', facts(false, true))).toBeNull()
    expect(grant(policy, 'pi', 'pane-1', 'shell', facts(false, true))).toBe('remembered')
    expect(grant(policy, 'pi', 'pane-1', 'shell', facts(true, false))).toBeNull()
    expect(grant(policy, 'chat', 'pane-1', 'edit files', facts(false, false))).toBeNull()
    expect(grant(policy, 'pi', 'pane-2', 'shell', {})).toBe('always')
    expect(grant({ auto: {}, globalTools: {}, remembered: policy.remembered }, 'pi', 'pane-2', 'shell', {})).toBeNull()
  })
})

describe('work slices', () => {
  /** Drives the slice guard the way Pi does, without a Pi session. */
  function driveGuard(input: Parameters<SessionFactory>[0]) {
    const extension = (input.params.inline ?? []).find((candidate) => candidate.name === 'work-slice')
    expect(extension).toBeDefined()
    const handlers = new Map<string, (event: unknown) => unknown>()
    ;(extension!.factory as (pi: unknown) => void)({
      on: (name: string, handler: (event: unknown) => unknown) => {
        handlers.set(name, handler)
      }
    })
    return {
      start: () => handlers.get('agent_start')!({}),
      call: (event: unknown) => handlers.get('tool_call')!(event),
      result: (event: unknown) => handlers.get('tool_result')!(event)
    }
  }

  it('leaves a reply unbounded when the work slice is turned off', async () => {
    let received: Parameters<SessionFactory>[0] | null = null
    const { harness, events, run } = setup(async (input) => {
      received = input
      return fakeSession(async () => undefined, input.gate)
    })
    await run('slice-off', { workSlice: { enabled: false } })
    await tick(80)
    expect((received!.params.inline ?? []).some((extension) => extension.name === 'work-slice')).toBe(false)
    expect(received!.params.slice).toBeUndefined()
    expect(loadRun(harness.env.root, 'slice-off').status).toBe('completed')
    expect(events.some((event) => event.type === 'checkpoint')).toBe(false)
  })

  it('ends a reply at its work-slice budget with a derived checkpoint', async () => {
    const { harness, events, run } = setup(async (input) => fakeSession(async () => {
      const slice = driveGuard(input)
      slice.start()
      for (let step = 0; step < 4; step += 1) slice.call({ toolName: 'read', input: { path: `file-${step}` } })
    }, input.gate))
    await run('slice-budget', { workSlice: { maxToolCalls: 3, continue: false } })
    await tick(120)
    expect(loadRun(harness.env.root, 'slice-budget')).toMatchObject({ status: 'interrupted', terminalReason: 'slice_complete' })
    const checkpoint = events.find((event) => event.type === 'checkpoint')
    expect(checkpoint?.payload).toMatchObject({ slice: 1, reason: 'budget' })
  })

  it('keeps the checkpoint the model wrote and continues from it', async () => {
    const inputs: Parameters<SessionFactory>[0][] = []
    const { harness, run, sessionDir } = setup(async (input) => {
      inputs.push(input)
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(join(sessionDir, 'saved.jsonl'), `${JSON.stringify({ type: 'session', id: 'native-1' })}\n`)
      return fakeSession(async () => {
        const slice = driveGuard(input)
        slice.start()
        await input.tools.find((candidate) => candidate.name === 'checkpoint_write')!.execute({
          summary: 'Halfway through the boundary work',
          done: [{ item: 'Read the sandbox check', evidence: ['src/core/workspaceSandbox.ts'] }],
          next: 'Fix the failing sandbox test'
        })
        slice.result({ toolName: 'checkpoint_write', isError: false, input: {} })
        for (let step = 0; step < 4; step += 1) slice.call({ toolName: 'read', input: { path: `file-${step}` } })
      }, input.gate)
    })
    await run('slice-first', { workSlice: { maxToolCalls: 3, maxSlices: 2, continue: true } })
    await tick(250)
    expect(inputs).toHaveLength(2)
    expect(inputs[1].params.text).toBe('Continue from where you stopped.')
    expect(inputs[1].params.update?.content ?? '').toContain('Halfway through the boundary work')
    expect(loadRun(harness.env.root, 'slice-first').terminalReason).toBe('slice_complete')
    expect(inputs[1].params.runId).not.toBe('slice-first')
  })

  it('does not call a reply that rewrites its todo a stall', async () => {
    // Three updates with different items are the progress report PROP-0006 asks for, not a loop.
    const { harness, events, run } = setup(async (input) => fakeSession(async () => {
      const slice = driveGuard(input)
      slice.start()
      for (const items of [
        [{ text: 'Land the fix', status: 'pending' }],
        [{ text: 'Land the fix', status: 'in_progress' }, { text: 'Run the checks', status: 'pending' }],
        [{ text: 'Land the fix', status: 'completed' }, { text: 'Run the checks', status: 'in_progress' }],
        [{ text: 'Land the fix', status: 'completed' }, { text: 'Run the checks', status: 'completed' }]
      ]) {
        slice.call({ toolName: 'todo_write', input: { items } })
      }
    }, input.gate))
    await run('slice-todo', { workSlice: { continue: false } })
    await tick(120)
    expect(loadRun(harness.env.root, 'slice-todo')).toMatchObject({ status: 'completed' })
    expect(loadRun(harness.env.root, 'slice-todo').terminalReason).toBeNull()
    expect(events.some((event) => event.type === 'checkpoint')).toBe(false)
  })
})
