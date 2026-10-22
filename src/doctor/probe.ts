import { randomUUID } from 'node:crypto'
import type { Harness } from '../harness'
import { resolve } from '../capabilities/api'
import { freezeRun } from '../capabilities/runSnapshot'
import { runRecordSchema } from '../sessions/contracts'
import { saveRun } from '../sessions/runStore'
import { HarnessError } from '../core/errors'
import type { DoctorContext, DoctorProbeContext } from './types'
import { materialise } from '../variant/materialise'

/** A real, tool-only diagnostic run. Model requests, if selected, use Pi's account runtime. */
export async function diagnosticProbe<T>(harness: Harness, context: DoctorContext, inputSignal: AbortSignal, action: (probe: DoctorProbeContext) => Promise<T>): Promise<T> {
  const interrupt = new AbortController()
  const signal = AbortSignal.any([inputSignal, interrupt.signal])
  signal.throwIfAborted()
  const root = harness.env.root
  const id = randomUUID()
  const caller = { ...context.caller, runId: id, sessionId: id, surface: 'doctor' }
  const available = await resolve(harness, { ...context.caller, cwd: context.cwd, tools: context.tools })
  const capabilities = {
    version: 1 as const,
    tools: available.tools.filter(tool => context.tools.includes(tool) && (!context.capabilities || context.capabilities.tools.includes(tool))),
    connectors: available.connectors.filter(connector => !context.capabilities || context.capabilities.connectors.includes(connector)),
    contributions: available.contributions.filter(item => !context.capabilities || context.capabilities.contributions.includes(item))
  }
  signal.throwIfAborted()
  if (context.accountId) harness.accounts.find(context.accountId)
  const variant = context.variant ? materialise(root, context.variant, { trust: harness.trust }) : null
  saveRun(root, runRecordSchema.parse({
    id, sessionId: id, mode: 'doctor', harness: 'pi', sessionType: 'structured', workingDirectory: context.cwd,
    startedAt: new Date().toISOString(), status: 'running', goal: 'User-approved diagnostic probe',
    accountId: context.accountId, agentId: caller.agentId ?? null, projectId: caller.projectId ?? null, trigger: 'doctor',
    variantScope: variant?.scope ?? null, variantVersion: variant?.fingerprint ?? null
  }))
  freezeRun(root, id, caller, capabilities)
  const run = harness.runs.start(id, id)
  run.onInterrupt(() => interrupt.abort())
  const abort = () => { run.finish('interrupted'); void harness.world.release(id) }
  signal.addEventListener('abort', abort, { once: true })
  const gate = harness.sessions.diagnosticGate(run, caller)
  try {
    signal.throwIfAborted()
    const result = await action({
      signal, context, run,
      call: async (name, input) => {
        signal.throwIfAborted()
        if (run.finished || !capabilities.tools.includes(name)) throw new HarnessError('doctor_blocked', 'This tool is outside the diagnostic capability set.')
        const refusal = await gate.check(name, input)
        if (refusal) throw new HarnessError('doctor_blocked', 'The tool policy refused this diagnostic call.')
        signal.throwIfAborted()
        const callId = randomUUID()
        run.emit('tool.started', { toolCallId: callId, name, summary: 'Synthetic diagnostic input' })
        try {
          let result
          if (name === 'mcp_list_tools') {
            if (typeof input.connectionId !== 'string') throw new HarnessError('doctor_blocked', 'A connection must be selected.')
            const broker = harness.apps.grant({ sessionId: id, runId: id, caller, readOnly: true, depth: 0, capabilities: { ...capabilities, connectors: capabilities.connectors.filter(connector => connector === input.connectionId) } })
            const count = await harness.apps.diagnosticList(broker, input.connectionId, signal)
            result = { text: `${count} tools listed.`, details: { doctorOk: true, toolCount: count } }
          } else {
            const tools = await harness.sessions.diagnosticTools({ run, caller, allow: capabilities.tools, depth: 0, cwd: context.cwd, capabilities })
            const tool = tools.find(tool => tool.name === name)
            if (!tool) throw new HarnessError('doctor_blocked', 'No provider supplies this diagnostic tool.')
            signal.throwIfAborted()
            result = await tool.execute(input)
          }
          signal.throwIfAborted()
          run.emit('tool.completed', { toolCallId: callId, name, ok: true })
          return result
        } catch (error) {
          run.emit('tool.completed', { toolCallId: callId, name, ok: false })
          throw error
        }
      }
    })
    return result
  } catch (error) {
    run.finish(signal.aborted ? 'interrupted' : 'failed', { code: 'doctor_failed', message: 'The diagnostic probe failed.' })
    throw error
  } finally {
    signal.removeEventListener('abort', abort)
    run.finish(signal.aborted ? 'interrupted' : 'completed')
    harness.apps.revokeRun(id, id)
    await harness.world.release(id)
  }
}
