// A session turn on Pi. Pi owns the model loop, native history, and tool use; this module opens
// the session with the compiled prompt and the session's tools, and maps Pi's events onto the
// run-event contract. Gated tools pause for the user's approval before they run.
import type { CreateAgentSessionOptions, ModelRuntime } from '@earendil-works/pi-coding-agent'

import { classifyMessage } from '../accounts/accounts'
import type { AccountContext } from '../accounts/env'
import { HarnessError } from '../core/errors'
import { CONTEXT_MESSAGE_TYPE, CONTEXT_SNAPSHOT_KEY, type ContextUpdate } from '../prompt/compile'
import type { RegistryResources } from '../skills/registry'
import type { ToolSpec } from '../tools/types'
import type { UsageRequest } from './contracts'
import { completedReasoningSummary, REASONING_SUMMARY_APIS, requestConciseReasoningSummary } from './reasoningSummaries'
import type { ActiveRun } from './registry'

export const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof EFFORTS)[number]

/** What one turn needs once its prompt is compiled and its tools are chosen. */
export interface TurnParams {
  runId: string
  cwd: string
  sessionDir: string
  /** The native history to open, or `null` to start a fresh one. */
  historyFile: string | null
  model: string | null
  effort?: Effort | null
  text: string
  images?: { mediaType: string; data: string }[]
  /** App-origin notes placed before the text of the request. */
  preamble?: string | null
  /** Unattended: no project extensions, no context files, settings held in memory. */
  automatic?: boolean
  account: AccountContext
  resources?: RegistryResources
  /** The stable part of the compiled prompt: the only text added to Pi's own. */
  system: string
  /** Changed state, saved as a hidden message in native history before the request. */
  update: ContextUpdate | null
}

// ---- Pi session seam (real implementation below; tests inject a fake) ----------------

/** Structural view of the Pi events the harness consumes. */
export type PiEvent =
  | { type: 'message_start'; message: { role: string } }
  | { type: 'message_update'; message: { role: string }; assistantMessageEvent: { type: string; delta?: string } }
  | {
      type: 'message_end'
      message: {
        role: string
        content?: Array<{ type: string; text?: string; thinkingSignature?: string }>
        api?: string
        usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number; cost?: { total?: number } }
        model?: string
        provider?: string
        responseId?: string
        stopReason?: string
        errorMessage?: string
      }
    }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_execution_end'; toolCallId: string; toolName: string; isError: boolean; result?: unknown }
  | { type: string }

export interface PiSessionLike {
  sessionId: string
  model?: { input: string[]; contextWindow?: number }
  getActiveToolNames?(): string[]
  getAllTools?(): Array<{ name: string; description?: string; parameters?: unknown }>
  subscribe(listener: (event: PiEvent) => void): () => void
  prompt(text: string, options?: { images?: unknown[] }): Promise<void>
  sendCustomMessage?(message: { customType: string; content: string; display: boolean; details: unknown }, options: { triggerTurn: boolean }): Promise<void>
  abort(): Promise<void>
  dispose(): void
}

export interface ToolGate {
  /** Resolves to a block reason, or null to let the call run. */
  check(toolName: string, input: unknown): Promise<string | null>
}

export type SessionFactory = (input: {
  params: TurnParams
  /** Pi's own tools and the custom tools switched on for this turn, in order. */
  allow: string[]
  gate: ToolGate
  /** Custom tools already bound to this run. */
  tools: ToolSpec[]
  runtime: () => Promise<ModelRuntime>
}) => Promise<PiSessionLike>

/** A one-line description of a tool call, for an approval request or the activity list. */
export function summarize(input: unknown, toolName = ''): string {
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>
    // Typed text is never recorded, only its length.
    if (/_type$/.test(toolName) && typeof record.text === 'string') return `${String(record.selector ?? record.app ?? '')} (${record.text.length} characters)`.trim()
    const primary = record.command ?? record.path ?? record.file_path ?? record.query
    if (typeof primary === 'string') return primary.slice(0, 200)
  }
  return JSON.stringify(input ?? {}).slice(0, 200)
}

function assistantText(message: { content?: Array<{ type: string; text?: string }> }): string {
  return (message.content ?? []).filter((part) => part.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('')
}

/** How much text a tool handed back to the model: what its result adds to every later request. */
export function resultSize(result: unknown): number | null {
  if (typeof result === 'string') return result.length
  const content = (result as { content?: unknown } | null | undefined)?.content
  if (!Array.isArray(content)) return null
  return content.reduce((total: number, part: { type?: string; text?: unknown }) => total + (part?.type === 'text' && typeof part.text === 'string' ? part.text.length : 0), 0)
}

const MAX_EVIDENCE_CHARS = 24_000
const MAX_SYSTEM_PROMPT_CHARS = 100_000
const MAX_TOOL_SPECS = 120

function limitedText(value: string, maximum = MAX_EVIDENCE_CHARS): { text: string; truncated: boolean } {
  const characters = Array.from(value)
  const marker = '\n…[truncated]'
  return characters.length > maximum ? { text: `${characters.slice(0, Math.max(0, maximum - Array.from(marker).length)).join('')}${marker}`, truncated: true } : { text: value, truncated: false }
}

function evidenceText(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value === undefined) return null
  const content = (value as { content?: unknown } | null)?.content
  if (Array.isArray(content)) {
    const parts = content.flatMap((part) => {
      if (!part || typeof part !== 'object') return []
      const item = part as { type?: unknown; text?: unknown }
      if (item.type === 'text' && typeof item.text === 'string') return [item.text]
      return item.type === 'image' ? ['[image content omitted]'] : []
    })
    if (parts.length) return parts.join('\n')
  }
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

function boundedSchema(value: unknown, budget: { remaining: number }, depth = 0): { value: unknown; truncated: boolean } {
  if (budget.remaining <= 0 || depth > 12) return { value: '[truncated]', truncated: true }
  if (typeof value === 'string') {
    const { text, truncated } = limitedText(value, Math.min(MAX_EVIDENCE_CHARS, budget.remaining))
    budget.remaining -= Array.from(text).length
    return { value: text, truncated }
  }
  if (Array.isArray(value)) {
    const values: unknown[] = []
    let truncated = value.length > 200
    for (const item of value.slice(0, 200)) {
      const next = boundedSchema(item, budget, depth + 1)
      values.push(next.value)
      truncated ||= next.truncated
      if (budget.remaining <= 0) break
    }
    return { value: values, truncated: truncated || values.length < value.length }
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    const output: Record<string, unknown> = {}
    let truncated = entries.length > 200
    for (const [key, item] of entries.slice(0, 200)) {
      if (budget.remaining <= 0) {
        truncated = true
        break
      }
      const next = boundedSchema(item, budget, depth + 1)
      output[key] = next.value
      truncated ||= next.truncated
    }
    return { value: output, truncated }
  }
  return { value: value ?? null, truncated: false }
}

function contextToolSpecs(session: PiSessionLike): { tools: Array<{ name: string; description: string; parameters: unknown }>; truncated: boolean } {
  const allTools = session.getAllTools?.() ?? []
  const activeNames = session.getActiveToolNames?.()
  const source = activeNames ? allTools.filter((tool) => activeNames.includes(tool.name)) : allTools
  const tools = source.slice(0, MAX_TOOL_SPECS).map((tool) => {
    const description = limitedText(tool.description ?? '', 2_000)
    const parameters = boundedSchema(tool.parameters ?? {}, { remaining: 4_000 })
    return { spec: { name: tool.name, description: description.text, parameters: parameters.value }, truncated: description.truncated || parameters.truncated }
  })
  return { tools: tools.map((entry) => entry.spec), truncated: source.length > MAX_TOOL_SPECS || tools.some((entry) => entry.truncated) }
}

const numberField = (event: Record<string, unknown>, key: string, fallback = 0): number => (typeof event[key] === 'number' && Number.isFinite(event[key]) ? (event[key] as number) : fallback)
const stringField = (event: Record<string, unknown>, key: string, fallback = ''): string => (typeof event[key] === 'string' ? (event[key] as string) : fallback)

/** Streams one request through a Pi session, translating events for the run. */
export async function runTurn(run: ActiveRun, session: PiSessionLike, params: TurnParams): Promise<void> {
  let messageIndex = 0
  let requestIndex = 0
  let currentMessageId: string | null = null
  let lastError: string | null = null
  let aborted = false
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, requests: 0 }
  let usageReported = false
  // Only some providers report a reasoning split; absent stays absent rather than zero.
  let reasoningTokens: number | undefined
  // One model request runs from a turn's start to its assistant message's end.
  let requestStartedAt: number | null = null
  let firstOutputAt: number | null = null
  let costReported = false
  const toolStartedAt = new Map<string, number>()

  const systemPrompt = limitedText(params.system, MAX_SYSTEM_PROMPT_CHARS)
  const contextUpdate = limitedText(params.update?.content ?? '', MAX_SYSTEM_PROMPT_CHARS)
  const toolSpecs = contextToolSpecs(session)
  run.emit('context.snapshot', {
    systemPrompt: systemPrompt.text,
    ...(contextUpdate.text ? { contextUpdate: contextUpdate.text } : {}),
    tools: toolSpecs.tools,
    ...(systemPrompt.truncated ? { systemPromptTruncated: true } : {}),
    ...(contextUpdate.truncated ? { contextUpdateTruncated: true } : {}),
    ...(toolSpecs.truncated ? { toolsTruncated: true } : {})
  })

  run.onInterrupt(async () => {
    aborted = true
    await session.abort()
  })

  const unsubscribe = session.subscribe((event) => {
    switch (event.type) {
      case 'message_start': {
        const { message } = event as Extract<PiEvent, { type: 'message_start' }>
        if (message.role === 'assistant') currentMessageId = `${run.runId}:m${messageIndex++}`
        break
      }
      case 'turn_start': {
        requestStartedAt = Date.now()
        firstOutputAt = null
        break
      }
      case 'message_update': {
        const update = event as Extract<PiEvent, { type: 'message_update' }>
        if (update.message.role === 'assistant') firstOutputAt ??= Date.now()
        if (update.message.role === 'assistant' && update.assistantMessageEvent.type === 'text_delta' && update.assistantMessageEvent.delta) {
          currentMessageId ??= `${run.runId}:m${messageIndex++}`
          run.emit('message.delta', { messageId: currentMessageId, text: update.assistantMessageEvent.delta })
        }
        break
      }
      case 'message_end': {
        const { message } = event as Extract<PiEvent, { type: 'message_end' }>
        if (message.role !== 'assistant') break
        requestIndex += 1
        const messageId = currentMessageId ?? `${run.runId}:m${messageIndex++}`
        currentMessageId = null
        const text = assistantText(message)
        if (text) run.emit('message.completed', { messageId, role: 'assistant', text })
        const reasoningSummary = completedReasoningSummary(message)
        if (message.usage || reasoningSummary) {
          const reported = message.usage
          if (reported) {
            usageReported = true
            usage.inputTokens += reported.input ?? 0
            usage.outputTokens += reported.output ?? 0
            usage.cacheReadTokens += reported.cacheRead ?? 0
            usage.cacheWriteTokens += reported.cacheWrite ?? 0
            usage.costUsd += reported.cost?.total ?? 0
            if (typeof reported.reasoning === 'number') reasoningTokens = (reasoningTokens ?? 0) + reported.reasoning
          }
          usage.requests = requestIndex
          const cost = reported?.cost?.total
          if (typeof cost === 'number') costReported = true
          const ended = Date.now()
          const request: UsageRequest = {
            index: requestIndex,
            ...(message.responseId ? { responseId: message.responseId } : {}),
            ...(message.model ? { model: message.model } : {}),
            ...(message.provider ? { provider: message.provider } : {}),
            ...(reported
              ? {
                  inputTokens: reported.input ?? 0,
                  cacheReadTokens: reported.cacheRead ?? 0,
                  cacheWriteTokens: reported.cacheWrite ?? 0,
                  outputTokens: reported.output ?? 0,
                  ...(typeof reported.reasoning === 'number' ? { reasoningTokens: reported.reasoning } : {})
                }
              : {}),
            ...(reasoningSummary ? { reasoningSummary } : {}),
            ...(typeof cost === 'number' ? { costUsd: cost, costSource: 'harness' as const } : {}),
            ...(requestStartedAt === null ? {} : { durationMs: ended - requestStartedAt }),
            ...(requestStartedAt === null || firstOutputAt === null ? {} : { ttftMs: Math.max(0, firstOutputAt - requestStartedAt) }),
            ...(message.stopReason ? { stopReason: message.stopReason } : {})
          }
          requestStartedAt = null
          const contextWindow = session.model?.contextWindow
          const { costUsd, ...tokens } = usage
          run.emit('usage.updated', {
            ...(usageReported ? tokens : { requests: requestIndex }),
            // A cost nobody reported is unknown, not zero.
            ...(usageReported && costReported ? { costUsd, costSource: 'harness' as const } : {}),
            ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
            ...(reported ? { contextTokens: (reported.input ?? 0) + (reported.cacheRead ?? 0) + (reported.cacheWrite ?? 0) } : {}),
            ...(contextWindow ? { contextWindow } : {}),
            ...(message.model ? { model: message.model } : {}),
            ...(message.provider ? { provider: message.provider } : {}),
            request
          })
        }
        if (message.stopReason === 'error' && message.errorMessage) {
          lastError = message.errorMessage
          const category = classifyMessage(message.errorMessage)
          if (category) run.emit('account.status', { accountId: params.account.id, category, message: message.errorMessage.slice(0, 500) })
        }
        if (message.stopReason === 'aborted') aborted = true
        break
      }
      case 'tool_execution_start': {
        const tool = event as Extract<PiEvent, { type: 'tool_execution_start' }>
        toolStartedAt.set(tool.toolCallId, Date.now())
        const input = evidenceText(tool.args)
        const boundedInput = input === null ? null : limitedText(input)
        run.emit('tool.started', {
          toolCallId: tool.toolCallId,
          name: tool.toolName,
          summary: summarize(tool.args, tool.toolName),
          ...(boundedInput ? { input: boundedInput.text, ...(boundedInput.truncated ? { inputTruncated: true } : {}) } : {})
        })
        break
      }
      case 'tool_execution_end': {
        const tool = event as Extract<PiEvent, { type: 'tool_execution_end' }>
        const started = toolStartedAt.get(tool.toolCallId)
        toolStartedAt.delete(tool.toolCallId)
        const resultChars = resultSize(tool.result)
        const output = evidenceText(tool.result)
        const boundedOutput = output === null ? null : limitedText(output)
        run.emit('tool.completed', {
          toolCallId: tool.toolCallId,
          name: tool.toolName,
          ok: !tool.isError,
          ...(started === undefined ? {} : { durationMs: Date.now() - started }),
          ...(resultChars === null ? {} : { resultChars }),
          ...(boundedOutput ? { output: boundedOutput.text, ...(boundedOutput.truncated ? { outputTruncated: true } : {}) } : {})
        })
        break
      }
      case 'auto_retry_start': {
        const retry = event as unknown as Record<string, unknown>
        run.emit('retry.started', {
          attempt: numberField(retry, 'attempt', 1),
          maxAttempts: numberField(retry, 'maxAttempts', 1),
          delayMs: numberField(retry, 'delayMs'),
          ...(stringField(retry, 'errorMessage') ? { error: stringField(retry, 'errorMessage').slice(0, 1000) } : {})
        })
        break
      }
      case 'auto_retry_end': {
        const retry = event as unknown as Record<string, unknown>
        run.emit('retry.ended', { attempt: numberField(retry, 'attempt', 1), success: retry.success === true, ...(stringField(retry, 'finalError') ? { error: stringField(retry, 'finalError').slice(0, 1000) } : {}) })
        break
      }
      case 'compaction_start': {
        run.emit('compaction.started', { reason: stringField(event as unknown as Record<string, unknown>, 'reason', 'context limit') })
        break
      }
      case 'compaction_end': {
        const compaction = event as unknown as Record<string, unknown>
        const summary = evidenceText(compaction.result)
        const boundedSummary = summary ? limitedText(summary) : null
        run.emit('compaction.ended', {
          reason: stringField(compaction, 'reason', 'context limit'),
          aborted: compaction.aborted === true,
          ...(typeof compaction.willRetry === 'boolean' ? { willRetry: compaction.willRetry } : {}),
          ...(stringField(compaction, 'errorMessage') ? { error: stringField(compaction, 'errorMessage').slice(0, 1000) } : {}),
          ...(boundedSummary ? { summary: boundedSummary.text, ...(boundedSummary.truncated ? { summaryTruncated: true } : {}) } : {})
        })
        break
      }
    }
  })

  try {
    if (params.update) {
      if (!session.sendCustomMessage) throw new HarnessError('provider_error', 'The Pi session cannot receive the compiled context update.')
      // The delivered snapshot is saved with the message, so the next turn compares against what Pi really holds.
      await session.sendCustomMessage({ customType: CONTEXT_MESSAGE_TYPE, content: params.update.content, display: false, details: { [CONTEXT_SNAPSHOT_KEY]: params.update.snapshot } }, { triggerTurn: false })
    }
    const prompt = params.preamble ? `${params.preamble}\n\n${params.text}` : params.text
    const images = (params.images ?? []).map((image) => ({ type: 'image', source: { type: 'base64', mediaType: image.mediaType, data: image.data } }))
    await session.prompt(prompt, images.length ? { images } : undefined)
    if (aborted) run.finish('interrupted')
    else if (lastError) run.finish('failed', { code: 'provider_error', message: lastError })
    else run.finish('completed')
  } catch (error) {
    if (aborted) run.finish('interrupted')
    else run.finish('failed', { code: 'provider_error', message: error instanceof Error ? error.message : String(error) })
  } finally {
    unsubscribe()
    session.dispose()
  }
}

/** Opens a Pi session for one turn: the account's runtime, the compiled prompt, and the gated tools. */
export const piSessionFactory: SessionFactory = async ({ params, allow, gate, tools, runtime: loadRuntime }) => {
  const pi = await import('@earendil-works/pi-coding-agent')
  const { Type } = await import('typebox')
  const runtime = await loadRuntime()

  let model: unknown
  let thinkingLevel: CreateAgentSessionOptions['thinkingLevel'] = params.effort ?? undefined
  if (params.model) {
    const resolved = pi.resolveCliModel({ cliModel: params.model, modelRuntime: runtime })
    if (resolved.error || !resolved.model) throw new HarnessError('provider_unavailable', resolved.error ?? `Model ${params.model} is not available.`)
    model = resolved.model
    thinkingLevel ??= resolved.thinkingLevel
  }

  const gatedExtension = (api: { on: (event: 'tool_call', handler: (event: { toolName: string; input: unknown }) => Promise<unknown>) => void }) => {
    api.on('tool_call', async (event) => {
      const reason = await gate.check(event.toolName, event.input)
      return reason ? { block: true, reason } : undefined
    })
  }

  const agentDir = params.account.configDir
  const automaticSettings = params.automatic ? pi.SettingsManager.inMemory({}) : undefined
  const resourceLoader = new pi.DefaultResourceLoader({
    ...(automaticSettings ? { settingsManager: automaticSettings, noExtensions: true, noContextFiles: true } : {}),
    cwd: params.cwd,
    agentDir,
    extensionFactories: [{ name: 'agent-x-approvals', factory: gatedExtension as never, hidden: true }],
    additionalSkillPaths: params.resources?.skillPaths ?? [],
    additionalPromptTemplatePaths: params.resources?.promptPaths ?? [],
    // The compiler writes one prompt; nothing else is appended here.
    appendSystemPromptOverride: (base) => [...base, ...(params.system.trim() ? [params.system] : [])]
  })
  await resourceLoader.reload()

  const customTools = tools
    .filter((tool) => allow.includes(tool.name))
    .map((spec) =>
      pi.defineTool({
        name: spec.name,
        label: spec.label,
        description: spec.description,
        parameters: spec.parameters(Type) as never,
        execute: async (_toolCallId, input) => {
          const result = await spec.execute(input as Record<string, unknown>)
          const output = typeof result === 'string' ? { text: result } : result
          return { content: [{ type: 'text', text: output.text }, ...(output.image ? [{ type: 'image', data: output.image.data, mimeType: output.image.mimeType }] : [])] as never, details: {} }
        }
      })
    )

  const { session } = await pi.createAgentSession({
    cwd: params.cwd,
    agentDir,
    modelRuntime: runtime,
    ...(model ? { model: model as never } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    tools: allow,
    customTools: customTools as never,
    resourceLoader,
    ...(automaticSettings ? { settingsManager: automaticSettings } : {}),
    sessionManager: params.historyFile ? pi.SessionManager.open(params.historyFile, params.sessionDir, params.cwd) : pi.SessionManager.continueRecent(params.cwd, params.sessionDir)
  })
  const piSession = session as unknown as PiSessionLike & { agent: { streamFunction: typeof runtime.streamSimple } }
  const streamAgent = piSession.agent
  const originalStream = streamAgent.streamFunction
  streamAgent.streamFunction = (streamModel, context, options) => {
    if (!streamModel.reasoning || !REASONING_SUMMARY_APIS.has(streamModel.api)) return originalStream(streamModel, context, options)
    return originalStream(streamModel, context, {
      ...options,
      onPayload: async (payload, requestModel) => {
        const overridden = await options?.onPayload?.(payload, requestModel)
        const requested = requestConciseReasoningSummary(overridden ?? payload)
        return requested.requested || overridden !== undefined ? requested.payload : undefined
      }
    })
  }
  return piSession
}
