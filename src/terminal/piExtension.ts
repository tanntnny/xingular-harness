// Loaded by the `pi` command in a terminal session (`--extension`). It reports what the native
// session does to the harness, asks before each tool call, takes instructions the harness
// queues for it, and gives the session the harness's own tools. It runs in the `pi` process,
// so everything it knows about the harness comes through the session socket.
import type { AgentSession, ExtensionAPI, ExtensionContext, ExtensionUIDialogOptions } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import { connectionFromEnv, socketCall, terminalCall } from './client'
import { runAccountsMenu, type SessionAccount } from './accountsMenu'
import { runPluginsMenu } from './pluginMenu'
import { runHubMenu } from './hubMenu'
import { claimTerminalControl, controlCall } from './control'
import { SUBAGENT_OWNER, SUBAGENT_RECEIPT, SUBAGENT_RESULTS, subagentHistory, type SubagentReceipt } from '../sessions/subagents'
import { askUserTool } from '../tools/askUser'
import type { QuestionAnswer } from '../sessions/registry'
import { PLAN_INSTRUCTIONS, planRefusal } from '../sessions/planMode'

interface SocketTool {
  name: string
  label: string
  description: string
  parameters: Record<string, unknown>
}

export interface TerminalPlanRunState {
  active: boolean
  allowedTools: ReadonlySet<string>
}

/** How much text a tool handed back to the model. */
function resultSize(result: unknown): number | null {
  const content = (result as { content?: unknown } | null | undefined)?.content
  if (!Array.isArray(content)) return typeof result === 'string' ? result.length : null
  return content.reduce((total: number, part: { type?: string; text?: unknown }) => total + (part?.type === 'text' && typeof part.text === 'string' ? part.text.length : 0), 0)
}

async function withParentCancellation<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  const stop = () => { void controlCall('terminal.interrupt').catch(() => {}) }
  if (signal?.aborted) stop()
  signal?.addEventListener('abort', stop, { once: true })
  try { return await work() } finally { signal?.removeEventListener('abort', stop) }
}

/** /hub, /plugins and /accounts are pages: the owned terminal fills the screen, and Pi's own dialogs ignore the field. */
const PAGE: ExtensionUIDialogOptions & { page: boolean } = { page: true }

export default async function (pi: ExtensionAPI, planRun?: TerminalPlanRunState, getSession?: () => AgentSession) {
  await terminalCall('startup', { phase: 'Pi extension loaded' })
  let context: ExtensionContext | null = null
  let nativeSubagents = false
  let subagentParent = false
  let timer: ReturnType<typeof setInterval> | null = null
  let polling = false
  let failure: string | undefined
  const emptyUsage = () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0, costUsd: 0 })
  let usage = emptyUsage()
  let reasoningTokens: number | undefined
  let costReported = false
  let requestStartedAt: number | null = null
  const toolStartedAt = new Map<string, number>()
  const fileTools = new Map<string, string>()

  // The harness's own tools for this session (connected apps and what the application offers).
  let stage = 'Tool discovery'
  try {
    await terminalCall('startup', { phase: stage })
    const connection = connectionFromEnv()
    // Claimed here, before the model has run anything, and kept in this process's memory: a
    // command the model runs can read the session token from its environment, never this key.
    const control = await claimTerminalControl(connection).catch(() => null)
    pi.registerCommand('hub', {
      description: 'Browse and install reviewed skills, plugins, and reusable documents',
      handler: async (_args, ctx) => {
        if (!control) return ctx.ui.notify('This session cannot install hub items.', 'warning')
        await runHubMenu(
          { select: (title, options) => ctx.ui.select(title, options, PAGE), confirm: (title, message) => ctx.ui.confirm(title, message), notify: (message, level) => ctx.ui.notify(message, level) },
          (method, params) => socketCall(connection, method, params ?? {}, 300_000, control)
        )
      }
    })
    pi.registerCommand('plugins', {
      description: 'See what this session loads, and switch a plugin on or off or trust its code',
      handler: async (_args, ctx) => {
        if (!control) return ctx.ui.notify('This session cannot change plugins.', 'warning')
        const { projectId } = await socketCall<{ projectId: string | null }>(connection, 'plugins.session', {}, 15_000, control).catch(() => ({ projectId: null }))
        await runPluginsMenu(
          { select: (title, options) => ctx.ui.select(title, options, PAGE), confirm: (title, message) => ctx.ui.confirm(title, message), notify: (message, level) => ctx.ui.notify(message, level) },
          (method, params) => socketCall(connection, method, params ?? {}, 60_000, control),
          projectId
        )
      }
    })
    pi.registerCommand('accounts', {
      description: 'Add, sign in to, check, switch, or remove the Pi accounts this harness uses',
      handler: async (_args, ctx) => {
        if (!control) return ctx.ui.notify('This session cannot manage accounts.', 'warning')
        const session = await socketCall<SessionAccount>(connection, 'accounts.session', {}, 15_000, control).catch(() => null)
        if (!session) return ctx.ui.notify('This session has no account to manage.', 'warning')
        const outcome = await runAccountsMenu(
          {
            select: (title, options) => ctx.ui.select(title, options, PAGE),
            confirm: (title, message) => ctx.ui.confirm(title, message),
            input: (title, placeholder) => ctx.ui.input(title, placeholder),
            notify: (message, level) => ctx.ui.notify(message, level)
          },
          (method, params) => socketCall(connection, method, params ?? {}, 120_000, control),
          session
        )
        // The session restarts on the account it chose: Pi ends here, and the launcher starts it again.
        if (outcome === 'relaunch') ctx.shutdown()
      }
    })
    const { tools } = await socketCall<{ tools: SocketTool[] }>(connection, 'tools.list', {}, 15_000)
    stage = 'Tool registration'
    for (const tool of tools) {
      pi.registerTool({
        name: tool.name,
        label: tool.label,
        description: tool.description,
        parameters: Type.Unsafe(tool.parameters),
        async execute(_id, input) {
          const result = await socketCall<{ text: string }>(connection, 'tools.call', { name: tool.name, input: input as Record<string, unknown> }, 1_230_000)
          return { content: [{ type: 'text', text: result.text }], details: undefined }
        }
      })
    }
    const native = await controlCall<{ tools: SocketTool[] }>('terminal.subagents.tools')
    nativeSubagents = native.tools.length > 0
    for (const tool of native.tools) pi.registerTool({
      name: tool.name, label: tool.label, description: tool.description, parameters: Type.Unsafe(tool.parameters),
      execute: async (_id, input, signal) => {
        const result = await withParentCancellation(signal, () => controlCall<{ text: string; details?: Record<string, unknown> }>('terminal.subagents.call', { name: tool.name, input }, 2_147_483_647))
        return { content: [{ type: 'text' as const, text: result.text }], details: result.details ?? {} }
      }
    })
  } catch (error) {
    await terminalCall('startupFailed', { reason: `${stage} failed: ${error instanceof Error ? error.message : 'Unavailable'}` }).catch(() => {})
    throw error
  }

  pi.on('session_start', async (_event, ctx) => {
    context = ctx
    if (timer) clearInterval(timer)
    await terminalCall('ready', { nativeSessionId: ctx.sessionManager.getSessionFile() })
    timer = setInterval(() => {
      if (polling || !context) return
      polling = true
      void terminalCall<{ command: { type: string; text?: string } | null }>('poll', {}, 5_000)
        .then(({ command }) => {
          if (command?.type === 'interrupt') context?.abort()
          else if (command?.type === 'send') {
            if (context?.ui.getEditorText().trim()) throw new Error('The terminal contains a user draft.')
            // Pi 1.2 needs deliverAs while a run is busy; a message sent then waits for that run to finish.
            pi.sendUserMessage(command.text!, context?.isIdle() === false ? { deliverAs: 'followUp' } : undefined)
          }
        })
        .catch(() => {
          context?.abort()
          if (timer) clearInterval(timer)
        })
        .finally(() => {
          polling = false
        })
    }, 100)
  })
  pi.on('before_agent_start', async (event, ctx) => {
    context = ctx
    failure = undefined
    usage = emptyUsage()
    reasoningTokens = undefined
    costReported = false
    // A run a plugin starts with a custom message has no user prompt to record; it still begins a turn.
    const begun = await terminalCall<{ runId: string }>('begin', { text: event.messageType === 'user' ? event.prompt : '' })
    if (nativeSubagents) {
      pi.appendEntry(SUBAGENT_OWNER, { runId: begun.runId })
      await controlCall('terminal.subagents.register', { tools: pi.getActiveTools(), model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null, effort: pi.getThinkingLevel(), history: subagentHistory(ctx.sessionManager.getBranch()) })
      subagentParent = true
    }
    if (planRun && event.messageType === 'user') {
      if (planRun.active) event.systemPromptOptions.sections.plan = PLAN_INSTRUCTIONS
      else delete event.systemPromptOptions.sections.plan
    }
    const bang = event.messageType === 'user' ? /^\s*!\s*([\s\S]+)$/u.exec(event.prompt) : null
    if (!bang) return
    const command = bang[1]!
    const id = `initial-bash:${begun.runId}`
    const started = Date.now()
    await terminalCall('tool', { phase: 'start', id, name: 'bash', summary: command.slice(0, 200), input: JSON.stringify({ command }) })
    let refusal: string | undefined
    let result: Awaited<ReturnType<AgentSession['executeBash']>> | undefined
    if (planRun?.active) {
      refusal = 'Bash commands are disabled while a plan request is running.'
    } else {
      try {
        const policy = await terminalCall<{ allowed: boolean; reason?: string; requiresApproval?: boolean }>('policy', { tool: 'bash', args: { command } })
        if (policy.requiresApproval) {
          const approval = await terminalCall<{ decision: string }>('approval', { requestId: id, tool: 'bash', args: { command } })
          if (approval.decision !== 'approved') refusal = 'The user denied this Bash command.'
        } else if (!policy.allowed) {
          refusal = policy.reason ?? 'This Bash command is outside what the terminal allows.'
        }
        if (!refusal) {
          const session = getSession?.()
          if (!session) refusal = 'The native session is unavailable.'
          else result = await session.executeBash(command, undefined, { id })
        }
      } catch (error) {
        refusal = error instanceof Error ? error.message : 'The Bash policy or command failed.'
      }
    }
    const output = result?.output ?? refusal ?? 'The command did not complete.'
    const outputTruncated = output.length > 24_000
    await terminalCall('tool', {
      phase: 'end', id, name: 'bash', ok: !refusal && result?.exitCode === 0 && !result.cancelled,
      durationMs: Date.now() - started, resultChars: output.length,
      output: outputTruncated ? `${output.slice(0, 23_987)}\n…[truncated]` : output,
      ...(outputTruncated ? { outputTruncated: true } : {})
    })
    const instruction = refusal
      ? `The user's initial Bash command was not run. Reason: ${refusal}. Do not claim that it ran; explain the limitation and ask how to proceed.`
      : 'The user’s initial Bash command has already run. Read its native Bash result and explain what it shows. Do not run the same command again unless the user explicitly asks.'
    return { message: { customType: 'xingular-initial-bash', content: instruction, display: false, details: {} } }
  })
  const deliverChildren = async (event: any, ctx: ExtensionContext, settle: boolean) => {
    if (!nativeSubagents || (settle && event.outcome !== 'completed') || ctx.signal?.aborted) return
    const result = await withParentCancellation(ctx.signal, () => controlCall<{ text: string; receipt: SubagentReceipt } | null>('terminal.subagents.delivery', { history: subagentHistory([...ctx.sessionManager.getBranch(), ...event.entries]), settle }, 2_147_483_647))
    if (!result) return
    return { entries: [...event.entries, { type: 'custom_message' as const, customType: SUBAGENT_RESULTS, content: result.text, display: false, details: { [SUBAGENT_RECEIPT]: result.receipt } }], continue: true }
  }
  pi.on('turn_end', (event, ctx) => deliverChildren(event, ctx, false))
  pi.on('agent_before_settle', (event, ctx) => deliverChildren(event, ctx, true))
  pi.on('message_end', async (event) => {
    if (event.message.role !== 'assistant') return
    if (event.message.stopReason === 'error' || event.message.stopReason === 'aborted') failure = event.message.errorMessage ?? `Pi stopped: ${event.message.stopReason}`
    const text = event.message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
    if (text) await terminalCall('message', { text })
    if (event.message.usage) {
      const reported = event.message.usage
      usage.inputTokens += reported.input ?? 0
      usage.outputTokens += reported.output ?? 0
      usage.cacheReadTokens += reported.cacheRead ?? 0
      usage.cacheWriteTokens += reported.cacheWrite ?? 0
      usage.requests += 1
      if (typeof reported.reasoning === 'number') reasoningTokens = (reasoningTokens ?? 0) + reported.reasoning
      const cost = reported.cost?.total
      if (typeof cost === 'number') {
        usage.costUsd += cost
        costReported = true
      }
      const identity = { model: event.message.model, provider: event.message.provider }
      const { costUsd, ...tokens } = usage
      await terminalCall('usage', {
        ...tokens,
        ...(costReported ? { costUsd, costSource: 'harness' } : {}),
        ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
        contextTokens: (reported.input ?? 0) + (reported.cacheRead ?? 0) + (reported.cacheWrite ?? 0),
        ...(context?.model?.contextWindow ? { contextWindow: context.model.contextWindow } : {}),
        ...identity,
        request: {
          index: usage.requests,
          ...identity,
          responseId: event.message.responseId,
          inputTokens: reported.input ?? 0,
          cacheReadTokens: reported.cacheRead ?? 0,
          cacheWriteTokens: reported.cacheWrite ?? 0,
          outputTokens: reported.output ?? 0,
          ...(typeof reported.reasoning === 'number' ? { reasoningTokens: reported.reasoning } : {}),
          ...(typeof cost === 'number' ? { costUsd: cost, costSource: 'harness' } : {}),
          ...(requestStartedAt === null ? {} : { durationMs: Date.now() - requestStartedAt }),
          stopReason: event.message.stopReason
        }
      })
      requestStartedAt = null
    }
  })
  pi.on('turn_start', async () => {
    requestStartedAt = Date.now()
  })
  pi.on('tool_call', async (event) => {
    if (planRun?.active && !planRun.allowedTools.has(event.toolName)) {
      const reason = planRefusal(event.toolName, new Set()) ?? `Plan mode is research-only: ${event.toolName} is not available in this session.`
      return { block: true, reason }
    }
    try {
      const policy = await controlCall<{ allowed: boolean; reason?: string; requiresApproval?: boolean }>('terminal.policy', { tool: event.toolName, args: event.input })
      if (policy.requiresApproval) {
        const approval = await controlCall<{ decision: string }>('terminal.approval', { requestId: event.toolCallId, tool: event.toolName, args: event.input })
        if (approval.decision === 'approved') return
        return { block: true, reason: 'The user denied this action. Ask how they would like to proceed.' }
      }
      if (!policy.allowed) return { block: true, reason: policy.reason ?? 'Outside what this session may do.' }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return { block: true, reason: `The terminal controller is unavailable: ${detail}` }
    }
  })
  pi.on('tool_execution_start', async (event) => {
    if (['edit', 'write'].includes(event.toolName) && typeof event.args.path === 'string') fileTools.set(event.toolCallId, event.args.path)
    toolStartedAt.set(event.toolCallId, Date.now())
    await terminalCall('tool', { phase: 'start', id: event.toolCallId, name: event.toolName, summary: JSON.stringify(event.args).slice(0, 200) })
  })
  pi.on('tool_execution_end', async (event) => {
    const started = toolStartedAt.get(event.toolCallId)
    toolStartedAt.delete(event.toolCallId)
    const resultChars = resultSize(event.result)
    await terminalCall('tool', { phase: 'end', id: event.toolCallId, name: event.toolName, ok: !event.isError, ...(started === undefined ? {} : { durationMs: Date.now() - started }), ...(resultChars === null ? {} : { resultChars }) })
    const path = fileTools.get(event.toolCallId)
    fileTools.delete(event.toolCallId)
    if (!event.isError && path) await terminalCall('file', { path, change: 'modified' })
  })
  pi.on('agent_settled', async (event, ctx) => {
    if (subagentParent && !event.aborted && !failure) {
      try { await controlCall('terminal.subagents.verify', { history: subagentHistory(ctx.sessionManager.getBranch()) }, 2_147_483_647) } catch (error) { failure = error instanceof Error ? error.message : String(error) }
    }
    subagentParent = false
    await terminalCall('settled', { error: failure, aborted: event.aborted })
  })
  pi.on('user_bash', async () => {
    throw new Error('Use the ! command composer so this action can be checked.')
  })
  pi.on('session_shutdown', async () => {
    if (timer) clearInterval(timer)
    timer = null
    context = null
    // This clears the controller's readiness while the next native session binds. The
    // process-level control claim survives replacement; only the session poller stops.
    await terminalCall('shutdown').catch(() => {})
  })
  const ask = askUserTool({ requestAnswers: questions => terminalCall<QuestionAnswer[]>('questions', { questions }, 1_230_000) })
  pi.registerTool({
    name: ask.name, label: ask.label, description: ask.description,
    parameters: Type.Unsafe(ask.parameters(Type) as Record<string, unknown>),
    async execute(_id, input) {
      const result = await ask.execute(input as Record<string, unknown>)
      return { content: [{ type: 'text', text: typeof result === 'string' ? result : result.text }], details: undefined }
    }
  })
  pi.registerTool({
    name: 'ask_user_question',
    label: 'Ask a question',
    description: 'Ask the user a question and wait for their answer. Every question must include at least one choice and at least one choice must be recommended. Recommendations are visual only and never preselect answers; submitted choices keep their labels. Mark at most one choice recommended for single-choice questions or several when multiSelect is true.',
    parameters: Type.Object({
      question: Type.String(),
      options: Type.Array(Type.Object({ label: Type.String(), description: Type.Optional(Type.String()), recommended: Type.Optional(Type.Boolean()) }), {
        minItems: 1,
        contains: Type.Object({ recommended: Type.Literal(true) })
      }),
      multiSelect: Type.Optional(Type.Boolean())
    }),
    async execute(id, input) {
      if (!Array.isArray(input.options) || input.options.length === 0) throw new Error('Every question needs at least one choice.')
      const recommendedCount = input.options.filter(option => option.recommended).length
      if (recommendedCount === 0) throw new Error('Every question needs at least one recommended choice.')
      if (!input.multiSelect && recommendedCount > 1) throw new Error('A single-choice question may recommend at most one option.')
      const answer = await terminalCall('question', { requestId: id, ...input })
      return { content: [{ type: 'text', text: JSON.stringify(answer) }], details: undefined }
    }
  })
  await terminalCall('startup', { phase: 'Pi hooks registered' })
}
