// Loaded by the `pi` command in a terminal session (`--extension`). It reports what the native
// session does to the harness, asks before each tool call, takes instructions the harness
// queues for it, and gives the session the harness's own tools. It runs in the `pi` process,
// so everything it knows about the harness comes through the session socket.
import { readFileSync } from 'node:fs'

import { createBashTool, createEditTool, createEditToolDefinition, createPowerShellTool, createWriteTool, createWriteToolDefinition, type AgentSession, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import { bodyOf } from '../core/frontmatter'

import { connectionFromEnv, socketCall, terminalCall } from './client'
import { controlCall } from './control'
import { SPAWN_SUBAGENT, SUBAGENT_OWNER, SUBAGENT_RECEIPT, SUBAGENT_RESULTS, subagentHistory, type SubagentReceipt } from '../sessions/subagents'
import { PLAN_RESEARCH_TOOLS } from '../agents/planResearch'
import { askUserTool } from '../tools/askUser'
import { TODO_WRITE, todoTool } from '../tools/todo'
import { finishTool } from '../tools/finish'
import { createStopGateState, handoffFields, stopCheckpointReason, stopGate, stopOutcome, stopSummary, STOP_GATE_EXTENSION } from '../sessions/stopGate'
import { createSliceState, DEFAULT_SLICE_POLICY, parseWorkSlice, sliceContinuation, workSliceGuard, type SlicePolicy } from '../sessions/workSlice'
import { DEFAULT_COMMAND_TIMEOUT_SECONDS, withCommandBudget } from '../core/commandBudget'
import { SESSION_NAME, deriveSessionName, sessionNameTool } from '../tools/sessionName'
import { CAPABILITY_DISCOVERY, describeCapabilities } from '../tools/getCapabilities'
import type { QuestionAnswer } from '../sessions/registry'
import { PLAN_INSTRUCTIONS, PLAN_REPAIR_CUSTOM_TYPE, PLAN_REPAIR_INSTRUCTIONS, parsePlanOutcome, planRefusal } from '../sessions/planMode'
import { compactionCheckpoint } from '../sessions/compactionCheckpoint'
import { requiredSkillsText, sessionStateText, type RequiredSkillText } from '../prompt/compile'
import type { SessionState } from '../sessions/sessionState'
import type { TodoItem } from '../sessions/contracts'
import { pruneToolImages } from '../world/images'
import { parseInitialBashCommand } from '../sessions/initialBash'
import { skillInvocations } from './tui/skillInvocation'
import { inspectWorkspaceWrite } from '../sessions/workspaceBoundary'
import { createWorkspaceShellTool } from '../core/workspaceBashTool'
import { createWorkspaceBashOperations, runWithWorkspaceWriteScope } from '../core/workspaceSandbox'
import { createWorkspaceFileTools, type WorkspaceWriteAuthorization } from '../core/workspaceWriteOperations'
import { BUDGET_GUARD, OUTPUT_TRIM, budgetGuard, outputTrim } from '../plugins/firstParty'

/** How long reply text gathers before it is sent on to a paired phone. */
const STREAM_FLUSH_MS = 150

interface SocketTool {
  name: string
  label: string
  description: string
  parameters: Record<string, unknown>
}

export interface TerminalPlanRunState {
  active: boolean
  allowedTools: ReadonlySet<string>
  connectors?: string[]
  subagentProfiles?: { normal: string; plan: string }
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

export default async function (pi: ExtensionAPI, planRun?: TerminalPlanRunState, getSession?: () => AgentSession) {
  await terminalCall('startup', { phase: 'Pi extension loaded' })
  let context: ExtensionContext | null = null
  let nativeSubagents = false
  let subagentParent = false
  let stoppedChildren: { text: string; receipt: SubagentReceipt } | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let turnStartedAt = 0
  let polling = false
  let failure: string | undefined
  let failureCode: 'provider_error' | undefined
  let messageAborted = false
  let turnActive = false
  let lastContextTokens: number | undefined
  let planRepairAttempted = false
  let lastPlanText = ''
  const emptyUsage = () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0, costUsd: 0 })
  let usage = emptyUsage()
  let reasoningTokens: number | undefined
  let costReported = false
  let requestStartedAt: number | null = null
  let pendingRefusals: Promise<unknown>[] = []
  const toolStartedAt = new Map<string, number>()
  const fileTools = new Map<string, string>()
  const writeAuthorizations = new Map<string, WorkspaceWriteAuthorization>()
  let workspaceRoot: string | null = null
  let sessionState: string | null = null
  let stateDelivered = false
  let autoNameTried = false
  let lastTodo: TodoItem[] = []

  // The harness's own tools for this session (connected apps and what the application offers).
  let stage = 'Tool discovery'
  try {
    await terminalCall('startup', { phase: stage })
    const connection = connectionFromEnv()
    const { tools } = await socketCall<{ tools: SocketTool[] }>(connection, 'tools.list', {}, 15_000)
    stage = 'Tool registration'
    for (const tool of tools) {
      pi.registerTool({
        name: tool.name,
        label: tool.label,
        description: tool.description,
        parameters: Type.Unsafe(tool.parameters),
        async execute(_id, input) {
          const result = await socketCall<{ text: string; images?: { data: string; mimeType: string }[]; details?: Record<string, unknown> }>(connection, 'tools.call', { name: tool.name, input: input as Record<string, unknown> }, 1_230_000)
          const images = (result.images ?? []).map((image) => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType }))
          return { content: [{ type: 'text' as const, text: result.text }, ...images], details: result.details }
        }
      })
    }
    // The harness's own extensions a person switched on, as a structured session loads them inline.
    const own = await socketCall<{ plugins: { id: string; settings: Record<string, unknown> }[] }>(connection, 'firstParty.list', {}, 15_000)
      .then((reply) => reply?.plugins ?? [], () => [])
    for (const plugin of own) {
      if (plugin.id === OUTPUT_TRIM) outputTrim(plugin.settings)(pi as never)
      if (plugin.id === BUDGET_GUARD) budgetGuard(plugin.settings)(pi as never)
    }
    const native = await controlCall<{ tools: SocketTool[]; profiles?: { normal: string; plan: string } }>('terminal.subagents.tools')
    nativeSubagents = native.tools.length > 0
    if (planRun && native.profiles) planRun.subagentProfiles = native.profiles
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

  pi.registerTool({
    ...CAPABILITY_DISCOVERY,
    parameters: Type.Unsafe(CAPABILITY_DISCOVERY.parameters),
    async execute(_id, input) {
      const active = pi.getActiveTools()
      const tools = pi.getAllTools()
      const selected = planRun?.active ? [...planRun.allowedTools] : active
      const name = input && typeof input === 'object' && typeof (input as Record<string, unknown>).tool === 'string'
        ? (input as Record<string, string>).tool
        : undefined
      const text = JSON.stringify(describeCapabilities({
        capabilities: { version: 1, tools: selected, connectors: planRun?.connectors ?? [], contributions: [] },
        active,
        registered: tools
      }, name))
      return { content: [{ type: 'text' as const, text }], details: undefined }
    }
  })

  const workspaceBash = createWorkspaceBashOperations(() => workspaceRoot, {
    bypassWorkspaceBoundary: async (request) => {
      const result = await controlCall<{ bypass: boolean }>('terminal.workspaceBoundaryBypass', { tool: 'bash', args: { command: request.command, cwd: request.cwd, workspaceRoot: request.workspaceRoot } })
      return result.bypass
    },
    requestWorkspaceWriteScope: async (request) => {
      const result = await controlCall<{ approved: boolean }>('terminal.workspaceEscape', { tool: 'bash', args: { command: request.command, workspaceWriteScope: 'outside' }, reason: request.reason })
      return result.approved
    },
    workspaceWriteScope: () => planRun?.active ? 'read-only' : undefined
  })
  pi.registerTool(createWorkspaceShellTool({ createBashTool, createPowerShellTool }, process.cwd(), workspaceBash))
  const nativeFileTools = createWorkspaceFileTools({ createWriteTool, createWriteToolDefinition, createEditTool, createEditToolDefinition }, process.cwd(), writeAuthorizations)
  pi.registerTool(nativeFileTools.write)
  pi.registerTool(nativeFileTools.edit)

  // The current name and this run's todo ride with each request; they never change the stable prefix.
  pi.on('context', (event) => {
    if (!sessionState || stateDelivered) return
    stateDelivered = true
    return {
      messages: [...event.messages, {
        role: 'custom' as const,
        customType: 'xingular-session-state',
        content: sessionState,
        display: false,
        timestamp: Date.now()
      }]
    }
  })
  compactionCheckpoint({ planInstructions: () => planRun?.active ? PLAN_INSTRUCTIONS : null })(pi)

  // A terminal reply is bounded like any other (PROP-0041): a checkpoint at each boundary, and the
  // reply continues in place up to the policy's slice cap (ADR-0070) before the person decides.
  let slicePolicy: SlicePolicy
  try {
    slicePolicy = parseWorkSlice(undefined)
  } catch (error) {
    slicePolicy = { ...DEFAULT_SLICE_POLICY }
    console.error(`${error instanceof Error ? error.message : String(error)} Using the default work slices.`)
  }
  const sliceState = createSliceState(slicePolicy)
  // `XINGULAR_WORK_SLICE=off` at launch leaves terminal replies unbounded, as before PROP-0041.
  // One stop-gate state per terminal session; each reply resets it, and `finish` reads it.
  const gateState = createStopGateState()
  if (slicePolicy.enabled) workSliceGuard({
    policy: slicePolicy,
    state: sliceState,
    onRefuse: (event, reason) => { pendingRefusals.push(terminalCall('refusal', { toolCallId: event.toolCallId, name: event.toolName, code: 'work_slice', reason: reason.slice(0, 2_000) }).catch(() => {})) }
  })(pi)

  // Only the latest screenshots stay in what the model sees (world/images.ts).
  pi.on('context', (event) => {
    const messages = pruneToolImages(event.messages as never[])
    return messages === (event.messages as never[]) ? undefined : { messages: messages as never }
  })

  pi.on('session_start', async (_event, ctx) => {
    context = ctx
    sessionState = null
    stateDelivered = false
    autoNameTried = false
    lastTodo = []
    if (timer) clearInterval(timer)
    // The branch's parent runs let the controller show the latest one's rows again on reopen.
    await terminalCall('ready', { nativeSessionId: ctx.sessionManager.getSessionFile(), owners: subagentHistory(ctx.sessionManager.getBranch?.() ?? []).owners })
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
    failureCode = undefined
    messageAborted = false
    lastContextTokens = undefined
    planRepairAttempted = false
    lastPlanText = ''
    usage = emptyUsage()
    reasoningTokens = undefined
    costReported = false
    // A run a plugin starts with a custom message has no user prompt to record; it still begins a turn.
    const begun = await terminalCall<{ runId: string; workspaceRoot: string }>('begin', { text: event.messageType === 'user' ? event.prompt : '', model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null, effort: pi.getThinkingLevel?.() ?? null })
    turnActive = true
    workspaceRoot = typeof begun.workspaceRoot === 'string' ? begun.workspaceRoot : null
    if (!workspaceRoot) throw new Error('The active project workspace could not be resolved; the turn was not started.')
    // Every turn marks its run on the branch, so a reopened conversation finds its latest one.
    pi.appendEntry(SUBAGENT_OWNER, { runId: begun.runId })
    // A live reply reports progress so a person and the watchdog can tell a long turn from a wedged
    // one; a turn that stops producing anything is settled with reason `stalled` (INV-RUN-14).
    turnStartedAt = Date.now()
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = setInterval(() => {
      void terminalCall('heartbeat', {
        steps: sliceState.steps,
        elapsedMs: Date.now() - turnStartedAt,
        lastTool: sliceState.lastTool,
        compactions: sliceState.compactions,
        slice: sliceState.slice,
        maxToolCalls: slicePolicy.enabled ? slicePolicy.maxToolCalls : 0
      }, 10_000).catch(() => {})
    }, 30_000)
    heartbeat.unref?.()
    stoppedChildren = null
    if (nativeSubagents) {
      const snapshot = await controlCall<{ connectors?: string[]; subagentProfiles?: { normal: string; plan: string }; notice?: { text: string; receipt: SubagentReceipt } | null }>('terminal.subagents.register', { tools: pi.getActiveTools(), model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null, effort: pi.getThinkingLevel(), plan: planRun?.active === true, history: subagentHistory(ctx.sessionManager.getBranch()) })
      if (planRun && Array.isArray(snapshot.connectors)) planRun.connectors = snapshot.connectors
      if (planRun && snapshot.subagentProfiles) planRun.subagentProfiles = snapshot.subagentProfiles
      stoppedChildren = snapshot.notice ?? null
      subagentParent = true
    }
    if (planRun && event.messageType === 'user') {
      if (planRun.active) event.systemPromptOptions.sections.plan = PLAN_INSTRUCTIONS
      else delete event.systemPromptOptions.sections.plan
      if (planRun.subagentProfiles) event.systemPromptOptions.sections.subagents = planRun.active ? planRun.subagentProfiles.plan : planRun.subagentProfiles.normal
    }
    const bang = event.messageType === 'user' ? /^\s*!\s*([\s\S]+)$/u.exec(event.prompt) : null
    if (!bang) return
    const initial = parseInitialBashCommand(bang[1]!)
    const command = initial.command
    const args = { command, ...(initial.workspaceWriteScope === 'outside' ? { workspaceWriteScope: 'outside' } : {}) }
    const id = `initial-bash:${begun.runId}`
    const started = Date.now()
    await terminalCall('tool', { phase: 'start', id, name: 'bash', summary: command.slice(0, 200), input: JSON.stringify(args) })
    let refusal: string | undefined
    let refusalCode: string | undefined
    let result: Awaited<ReturnType<AgentSession['executeBash']>> | undefined
    if (!command) {
      refusal = 'Enter a Bash command after !outside.'
    } else if (planRun?.active) {
      refusal = 'Bash commands are disabled while a plan request is running.'
      refusalCode = 'plan_mode'
    } else {
      let checkingGate = true
      try {
        const policy = await terminalCall<{ allowed: boolean; reason?: string; requiresApproval?: boolean }>('policy', { tool: 'bash', args })
        if (policy.requiresApproval) {
          const approval = await terminalCall<{ decision: string }>('approval', { requestId: id, tool: 'bash', args })
          if (approval.decision !== 'approved') {
            refusal = 'The user denied this Bash command.'
            refusalCode = 'approval_denied'
          }
        } else if (!policy.allowed) {
          refusal = policy.reason ?? 'This Bash command is outside what the terminal allows.'
          refusalCode = 'policy'
        }
        checkingGate = false
        if (!refusal) {
          const session = getSession?.()
          if (!session) refusal = 'The native session is unavailable.'
          else result = await runWithWorkspaceWriteScope(initial.workspaceWriteScope, () => withCommandBudget(() => session.executeBash(command, undefined, { id, operations: workspaceBash }), () => session.abortBash(), DEFAULT_COMMAND_TIMEOUT_SECONDS))
        }
      } catch (error) {
        refusal = error instanceof Error ? error.message : 'The Bash policy or command failed.'
        if (checkingGate) refusalCode = 'controller_unavailable'
      }
    }
    if (refusal && refusalCode) await terminalCall('refusal', { toolCallId: id, name: 'bash', code: refusalCode, reason: refusal.slice(0, 2_000) }).catch(() => {})
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
  // A second handler, so the notice joins any initial-Bash message rather than replacing it.
  pi.on('before_agent_start', async () => {
    const notice = stoppedChildren
    stoppedChildren = null
    if (notice) return { message: { customType: SUBAGENT_RESULTS, content: notice.text, display: false, details: { [SUBAGENT_RECEIPT]: notice.receipt } } }
  })
  // A `$name` anywhere in the message makes that skill required for this request. The skill's text is
  // delivered as a hidden request-scoped message, so the person's own wording reaches the model unchanged.
  pi.on('before_agent_start', async (event) => {
    if (event.messageType !== 'user' || /^\s*!/u.test(event.prompt)) return
    if (pi.getSettings?.().enableSkillCommands === false) return
    const skills = (pi.getCommands?.() ?? [])
      .filter((command) => command.source === 'skill')
      .map((command) => ({
        name: command.name.replace(/^skill:/, ''),
        path: command.sourceInfo.path,
        ...(command.sourceInfo.baseDir ? { baseDir: command.sourceInfo.baseDir } : {})
      }))
    if (!skills.length) return
    const names = skillInvocations(event.prompt, new Set(skills.map((skill) => skill.name)))
    if (!names.length) return
    const entries: RequiredSkillText[] = names.map((name) => {
      const skill = skills.find((candidate) => candidate.name === name)!
      try {
        return { name, path: skill.path, baseDir: skill.baseDir, body: bodyOf(readFileSync(skill.path, 'utf8')) }
      } catch {
        return { name, path: skill.path, body: '' }
      }
    })
    const content = requiredSkillsText(entries)
    return content ? { message: { customType: 'xingular-required-skills', content, display: false, details: { skills: names } } } : undefined
  })
  // A new user turn starts with an empty todo. The previous list is context, not this run's list.
  // A substantive first turn also gets a provisional name when the terminal policy allows it.
  pi.on('before_agent_start', async (event, ctx) => {
    if (event.messageType !== 'user') return
    const branch = ctx.sessionManager.getBranch?.() ?? []
    const hasUser = branch.some((entry) => entry.type === 'message' && (entry as { message?: { role?: string } }).message?.role === 'user')
    let name = typeof pi.getSessionName === 'function' ? pi.getSessionName() ?? null : null
    if (!name && !autoNameTried && pi.setSessionName) {
      const candidate = deriveSessionName(event.prompt)
      if (candidate) {
        autoNameTried = true
        try {
          const policy = await controlCall<{ allowed: boolean; requiresApproval?: boolean }>('terminal.policy', { tool: SESSION_NAME, args: { name: candidate } })
          if (policy.allowed && !policy.requiresApproval) {
            pi.setSessionName(candidate)
            name = candidate
          }
        } catch {
          // Session naming is metadata; a refused or failed name never fails the turn.
        }
      }
    }
    const state: SessionState = {
      name,
      todo: [],
      ...(lastTodo.length ? { previousTodo: lastTodo } : {}),
      firstTurn: !hasUser
    }
    lastTodo = []
    const active = typeof pi.getActiveTools === 'function' ? pi.getActiveTools() : null
    sessionState = sessionStateText(state, {
      name: active ? active.includes(SESSION_NAME) : true,
      todo: active ? active.includes(TODO_WRITE) : true
    })
    stateDelivered = false
  })
  const deliverChildren = async (event: any, ctx: ExtensionContext, settle: boolean) => {
    if (!nativeSubagents || (settle && event.outcome !== 'completed') || ctx.signal?.aborted) return
    const result = await withParentCancellation(ctx.signal, () => controlCall<{ text: string; receipt: SubagentReceipt } | null>('terminal.subagents.delivery', { history: subagentHistory([...ctx.sessionManager.getBranch(), ...event.entries]), settle }, 2_147_483_647))
    if (!result) return
    return { entries: [...event.entries, { type: 'custom_message' as const, customType: SUBAGENT_RESULTS, content: result.text, display: false, details: { [SUBAGENT_RECEIPT]: result.receipt } }], continue: true }
  }
  pi.on('turn_end', (event, ctx) => deliverChildren(event, ctx, false))
  pi.on('agent_before_settle', (event, ctx) => deliverChildren(event, ctx, true))
  pi.on('agent_before_settle', (event, ctx) => {
    if (!planRun?.active || planRepairAttempted || event.outcome !== 'completed' || event.continue || ctx.signal?.aborted || failure || sliceState.endedBy || parsePlanOutcome(lastPlanText).kind !== 'invalid') return
    planRepairAttempted = true
    return {
      entries: [...event.entries, { type: 'custom_message', customType: PLAN_REPAIR_CUSTOM_TYPE, content: PLAN_REPAIR_INSTRUCTIONS, display: false, details: { reason: 'invalid_plan_outcome' } }],
      continue: true
    }
  })
  // The stop gate (ADR-0069), after subagent delivery and plan repair so it sees their continuations:
  // a terminal reply that ends with open todo items is sent back, up to its cap, unless it declared
  // with `finish` that the person is needed. Plan replies are not gated.
  stopGate({
    state: gateState,
    active: () => !planRun?.active,
    sliceEnded: () => sliceState.endedBy !== null,
    failed: () => Boolean(failure),
    onNudge: (count, open) => {
      void terminalCall('notice', { kind: 'notify', level: 'info', extension: STOP_GATE_EXTENSION, text: `Stop gate ${count}: the reply ended with ${open.length} open todo item${open.length === 1 ? '' : 's'}; continuing.` }).catch(() => undefined)
    }
  })(pi)
  // After the stop gate, which stays silent at a slice boundary: a reply that did work and reached
  // its budget continues as the next slice of the same run (ADR-0070).
  if (slicePolicy.enabled) sliceContinuation({
    policy: slicePolicy,
    state: sliceState,
    active: () => !planRun?.active,
    failed: () => Boolean(failure),
    blocked: () => Boolean(gateState.finish && gateState.finish.status !== 'done'),
    todo: () => gateState.todo,
    next: () => handoffFields(gateState).next,
    onContinue: (ended) => {
      void terminalCall('checkpoint', { summary: `Work slice ${ended.slice} reached its limit after ${ended.steps} steps; the reply continues.`, ...handoffFields(gateState), files: [], checks: [], decisions: [], slice: ended.slice, reason: 'budget' }).catch(() => undefined)
      void terminalCall('notice', { kind: 'notify', level: 'info', extension: STOP_GATE_EXTENSION, text: `Work slice ${ended.slice} reached ${ended.limit ?? 'its limit'}; continuing with slice ${ended.slice + 1} of up to ${slicePolicy.maxSlices}.` }).catch(() => undefined)
    }
  })(pi)
  // Reply text as it streams, batched, for a paired phone (remote control). The completed message
  // carries the same id and replaces whatever streamed.
  let streamId: string | null = null
  let streamText = ''
  let streamTimer: ReturnType<typeof setTimeout> | null = null
  let streamCount = 0
  const flushStream = () => {
    streamTimer = null
    if (!streamId || !streamText) return
    const text = streamText
    streamText = ''
    void terminalCall('delta', { id: streamId, text }).catch(() => undefined)
  }
  pi.on('message_update', (event) => {
    const update = event.assistantMessageEvent
    if (event.message.role !== 'assistant' || update.type !== 'text_delta' || !update.delta) return
    streamId ??= `${Date.now().toString(36)}-${++streamCount}`
    streamText += update.delta
    streamTimer ??= setTimeout(flushStream, STREAM_FLUSH_MS)
  })
  pi.on('message_end', async (event) => {
    if (event.message.role !== 'assistant') return
    const messageId = streamId
    if (streamTimer) clearTimeout(streamTimer)
    streamTimer = null
    streamText = ''
    streamId = null
    if (event.message.stopReason === 'error') {
      failure = event.message.errorMessage || 'Pi stopped: error'
      failureCode = 'provider_error'
    }
    if (event.message.stopReason === 'aborted') messageAborted = true
    const text = event.message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
    lastPlanText = text
    if (text) await terminalCall('message', messageId ? { id: messageId, text } : { text })
    if (event.message.usage) {
      const reported = event.message.usage
      lastContextTokens = (reported.input ?? 0) + (reported.cacheRead ?? 0) + (reported.cacheWrite ?? 0)
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
  pi.on('session_before_compact', async (event, ctx) => {
    if (!turnActive) return
    await terminalCall('compaction.started', { reason: event.reason, ...(lastContextTokens === undefined ? {} : { contextTokens: lastContextTokens }), ...(ctx.model?.contextWindow ? { contextWindow: ctx.model.contextWindow } : {}) })
  })
  pi.on('session_compact', async (event) => {
    if (!turnActive) return
    sliceState.compactions += 1
    const summary = event.compactionEntry.summary
    const chars = Array.from(summary)
    const marker = '\n…[truncated]'
    const truncated = chars.length > 24_000
    await terminalCall('compaction.ended', { reason: event.reason, aborted: false, tokensBefore: event.compactionEntry.tokensBefore, willRetry: event.willRetry, ...(summary ? { summary: truncated ? `${chars.slice(0, 24_000 - Array.from(marker).length).join('')}${marker}` : summary, ...(truncated ? { summaryTruncated: true } : {}) } : {}) })
  })
  pi.on('session_compact_failed', async (event) => {
    if (!turnActive) return
    sliceState.compactions += 1
    await terminalCall('compaction.ended', { reason: event.reason, aborted: event.aborted, willRetry: event.willRetry, ...(event.errorMessage ? { error: event.errorMessage.slice(0, 1_000) } : {}) })
  })
  pi.on('turn_start', async () => {
    requestStartedAt = Date.now()
  })
  pi.on('tool_call', async (event, ctx) => {
    const refuse = async (code: string, reason: string) => {
      await terminalCall('refusal', { toolCallId: event.toolCallId, name: event.toolName, code, reason: reason.slice(0, 2_000) }).catch(() => {})
      return { block: true as const, reason }
    }
    if (planRun?.active && !planRun.allowedTools.has(event.toolName)) {
      const reason = planRefusal(event.toolName, new Set(), event.input) ?? `Plan mode is research-only: ${event.toolName} is not available in this session.`
      return refuse('plan_mode', reason)
    }
    if (planRun?.active && event.toolName === SPAWN_SUBAGENT) {
      try {
        const eligibility = await controlCall<{ allowed: boolean; reason?: string }>('terminal.subagents.planSafe', { input: event.input })
        if (!eligibility.allowed) return refuse('plan_mode', eligibility.reason ?? 'This profile is not eligible for plan-mode research.')
      } catch (error) {
        return refuse('controller_unavailable', `Plan-mode research eligibility could not be verified: ${error instanceof Error ? error.message : 'controller unavailable'}`)
      }
    } else if (planRun?.active) {
      const reason = planRefusal(event.toolName, new Set(PLAN_RESEARCH_TOOLS), event.input)
      if (reason) return refuse('plan_mode', reason)
    }
    let authorization: WorkspaceWriteAuthorization | undefined
    if ((event.toolName === 'edit' || event.toolName === 'write') && typeof event.input.path === 'string') {
      try {
        if (!workspaceRoot) throw new Error('The active project workspace is unavailable.')
        const inspection = inspectWorkspaceWrite(workspaceRoot, ctx.cwd, event.toolName, event.input)
        Object.assign(event.input, inspection.input)
        if (!inspection.path) throw new Error('The native file-write target could not be verified.')
        authorization = {
          workspaceRoot,
          cwd: ctx.cwd,
          path: inspection.path,
          outside: inspection.outside,
          authorized: false
        }
      } catch (error) {
        return refuse('workspace', error instanceof Error ? error.message : 'The active project workspace could not be verified.')
      }
    }
    try {
      const policy = await controlCall<{ allowed: boolean; reason?: string; requiresApproval?: boolean }>('terminal.policy', { tool: event.toolName, args: event.input })
      if (policy.requiresApproval) {
        const approval = await controlCall<{ decision: string }>('terminal.approval', { requestId: event.toolCallId, tool: event.toolName, args: event.input })
        if (approval.decision !== 'approved') return refuse('approval_denied', 'The user denied this action. Do not repeat it or ask for permission in a message; choose another approach or report what is blocked.')
      } else if (!policy.allowed) {
        return refuse('policy', policy.reason ?? 'Outside what this session may do.')
      }
      if (authorization) {
        authorization.authorized = true
        writeAuthorizations.set(event.toolCallId, authorization)
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return refuse('controller_unavailable', `The terminal controller is unavailable: ${detail}`)
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
    await Promise.all(pendingRefusals)
    pendingRefusals = []
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = null
    if (subagentParent && !event.aborted && !failure) {
      try { await controlCall('terminal.subagents.verify', { history: subagentHistory(ctx.sessionManager.getBranch()) }, 2_147_483_647) } catch (error) { failure = error instanceof Error ? error.message : String(error) }
    }
    subagentParent = false
    // A reply that stopped at its work-slice boundary is not a completed task: the record says so,
    // so a host can offer the continuation instead of treating it as done (PROP-0041).
    // A reply that ended with open todo items is not completed either (ADR-0069): it stopped for the
    // person, or the stop gate's nudges ran out. The harness writes its checkpoint from the todo list.
    const aborted = event.aborted || messageAborted
    const stop = !sliceState.endedBy && !failure && !aborted && !planRun?.active ? stopOutcome(gateState) : null
    if (stop) {
      await terminalCall('checkpoint', { summary: stopSummary(stop), ...handoffFields(gateState), files: [], checks: [], decisions: [], slice: sliceState.slice, reason: stopCheckpointReason(stop) }).catch(() => undefined)
    } else if (sliceState.endedBy && !failure && !aborted) {
      // The guard ended the reply and promised the model the harness would keep its state.
      await terminalCall('checkpoint', { summary: `The reply stopped after ${sliceState.steps} steps at its work-slice boundary.`, ...handoffFields(gateState), files: [], checks: [], decisions: [], slice: sliceState.slice, reason: sliceState.endedBy }).catch(() => undefined)
    }
    const reason = sliceState.endedBy ? 'slice_complete' : stop?.code
    const code = sliceState.endedBy === 'compaction-thrash' ? 'compaction_thrash' : sliceState.endedBy === 'budget' ? 'slice_budget' : stop?.code
    await terminalCall('settled', { error: failure, ...(failureCode ? { errorCode: failureCode } : {}), aborted, ...(reason ? { reason } : {}), ...(code ? { code } : {}) })
    turnActive = false
  })
  pi.on('user_bash', async () => {
    throw new Error('Use the ! command composer so this action can be checked.')
  })
  pi.on('session_shutdown', async () => {
    if (timer) clearInterval(timer)
    timer = null
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = null
    context = null
    turnActive = false
    sessionState = null
    stateDelivered = false
    autoNameTried = false
    lastTodo = []
    // This clears the controller's readiness while the next native session binds. The
    // process-level control claim survives replacement; only the session poller stops.
    await terminalCall('shutdown').catch(() => {})
  })
  const naming = sessionNameTool(() => ({
    get sessionName() { return pi.getSessionName() },
    setSessionName: name => pi.setSessionName(name)
  }))
  pi.registerTool({
    name: naming.name, label: naming.label, description: naming.description,
    parameters: Type.Unsafe(naming.parameters(Type) as Record<string, unknown>),
    async execute(_id, input) {
      const result = await naming.execute(input as Record<string, unknown>)
      return { content: [{ type: 'text', text: typeof result === 'string' ? result : result.text }], details: undefined }
    }
  })
  // The todo list is recorded on the harness run; the shared tool validates and the socket carries the event.
  let recorded: Promise<unknown> = Promise.resolve()
  const todo = todoTool({ emit: (_type, payload) => { recorded = terminalCall('todo', payload as Record<string, unknown>) } })
  pi.registerTool({
    name: todo.name, label: todo.label, description: todo.description,
    parameters: Type.Unsafe(todo.parameters(Type) as Record<string, unknown>),
    async execute(_id, input) {
      recorded = Promise.resolve()
      const result = await todo.execute(input as Record<string, unknown>)
      await recorded
      const items = (input as { items?: unknown }).items
      if (Array.isArray(items)) lastTodo = items as TodoItem[]
      return { content: [{ type: 'text', text: typeof result === 'string' ? result : result.text }], details: undefined }
    }
  })
  // The one explicit way to end a reply with open todo items (ADR-0069); the stop gate reads what it records.
  const finish = finishTool(gateState)
  pi.registerTool({
    name: finish.name, label: finish.label, description: finish.description,
    parameters: Type.Unsafe(finish.parameters(Type) as Record<string, unknown>),
    async execute(_id, input) {
      const result = await finish.execute(input as Record<string, unknown>)
      return { content: [{ type: 'text', text: typeof result === 'string' ? result : result.text }], details: undefined }
    }
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
  // One question tool, as in every structured session: the terminal has no ask_user_question alias (PROP-0039).
  await terminalCall('startup', { phase: 'Pi hooks registered' })
}
