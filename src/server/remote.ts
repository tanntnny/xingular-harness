// What a host that is not a Node program supplies over the protocol instead of in-process:
// its secret store, its policy, its names for agents, and its own tools. Each is a call to the
// host; the harness works without any of them.
import { z } from 'zod'
import { findingSchema } from '../doctor/types'
import type { SecretStore } from '../accounts/secrets'
import type { Directory } from '../core/env'
import type { ToolPolicy } from '../sessions/policy'
import type { ToolProvider, ToolSpec } from '../tools/types'
import type { RpcPeer } from './rpc'

/** `secrets.get`, `secrets.set`, `secrets.delete` on the host. */
export function remoteSecrets(peer: RpcPeer): SecretStore {
  return {
    get: (key) => peer.callHost<string | null>('secrets.get', { key }),
    set: async (key, value) => void (await peer.callHost('secrets.set', { key, value })),
    delete: async (key) => void (await peer.callHost('secrets.delete', { key }))
  }
}

/** `policy.scope`, `policy.authorize`, `policy.approval`, `policy.connections` on the host. */
export function remotePolicy(peer: RpcPeer): ToolPolicy {
  const identify = (call: { run: { id: string; sessionId: string }; caller: unknown; tool: string; args: unknown }) => ({ runId: call.run.id, sessionId: call.run.sessionId, caller: call.caller, tool: call.tool, args: call.args })
  return {
    scope: (call) => peer.callHost('policy.scope', identify(call), 90_000),
    authorize: async (call) => void (await peer.callHost('policy.authorize', identify(call), 90_000)),
    approval: (input) => peer.callHost('policy.approval', { runId: input.run.id, sessionId: input.run.sessionId, target: input.target, operation: input.operation ?? null }),
    connections: (input) => peer.callHost('policy.connections', input)
  }
}

/**
 * Names the host knows and the harness shows in what it writes. The host pushes them with the
 * `directory.set` method, because the lookups are synchronous.
 */
export function remoteDirectory(peer: RpcPeer): Directory {
  let agents: Record<string, string> = {}
  let sessions: Record<string, string> = {}
  peer.handle('directory.set', (params: { agents?: Record<string, string>; sessions?: Record<string, string> }) => {
    if (params.agents) agents = params.agents
    if (params.sessions) sessions = { ...sessions, ...params.sessions }
  })
  return { agentName: (id) => agents[id] ?? null, sessionAgent: (id) => sessions[id] ?? null }
}

interface HostTool {
  name: string
  label?: string
  description: string
  /** JSON Schema of the tool's input. */
  parameters: Record<string, unknown>
}

/**
 * Tools the host registers with `tools.register` and runs when the harness calls `tools.call`
 * back. A session is given those its `allow` list names.
 */
export function remoteTools(peer: RpcPeer): ToolProvider {
  let registered: HostTool[] = []
  const descriptor = z.object({
    id: z.string().min(1), category: z.string(), title: z.string(), tools: z.array(z.string()),
    probe: z.object({ notice: z.string(), tool: z.string(), input: z.record(z.string(), z.unknown()), contains: z.string().min(1) }).optional()
  })
  let diagnostics: z.infer<typeof descriptor>[] = []
  peer.handle('tools.register', (params: { tools?: HostTool[]; diagnostics?: unknown[] }) => {
    diagnostics = z.array(descriptor).parse(params.diagnostics ?? [])
    registered = Array.isArray(params.tools) ? params.tools : []
    return { registered: registered.map((tool) => tool.name) }
  })
  const provider: ToolProvider = (session) =>
    registered
      .filter((tool) => session.allow.includes(tool.name))
      .map(
        (tool): ToolSpec => ({
          name: tool.name,
          label: tool.label ?? tool.name,
          description: tool.description,
          parameters: (Type) => Type.Unsafe(tool.parameters),
          execute: async (input) => {
            const result = await peer.callHost<unknown>('tools.call', { name: tool.name, input, runId: session.run.runId, sessionId: session.run.sessionId, caller: session.caller, depth: session.depth, cwd: session.cwd }, 1_230_000)
            return typeof result === 'string' ? result : JSON.stringify(result)
          }
        })
      )
  provider.diagnostics = context => diagnostics.map(check => ({
    id: `host.${check.id}`, category: check.category, title: check.title, tools: check.tools,
    local: async signal => {
      signal.throwIfAborted()
      const result = await peer.callHost('tools.diagnose', { id: check.id, context }, 8000)
      return findingSchema.pick({ status: true, evidence: true, remedy: true }).parse(result)
    },
    live: check.probe ? {
      notice: check.probe.notice,
      run: async probe => {
        const result = await probe.call(check.probe!.tool, check.probe!.input)
        const text = typeof result === 'string' ? result : result.text
        return { status: text.includes(check.probe!.contains) ? 'pass' as const : 'fail' as const, evidence: 'The registered host tool probe completed; the expected response marker was checked.' }
      }
    } : undefined
  }))
  return provider
}
