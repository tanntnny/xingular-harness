// Hosts that share one long-lived harness (ADR-0083, phase 3). A host that embeds the harness in its
// own process supplies its secret store, tool policy, names, tools, connected-apps broker and refine
// host in-process. A host that connects to the daemon over its socket supplies the same things as
// calls the harness makes back to it (page 10), and the harness has to know which host's answer a
// call needs, because terminal windows share the process. A session belongs to the host that started
// its run; a run with no host (a terminal's) is gated and given tools as it would be with no host.
//
// The hub holds no application's name or concept (INV-BND-2): a host says what it is called and what
// it supplies when it registers.
import { HarnessError } from '../core/errors'
import type { Directory } from '../core/env'
import type { SecretStore } from '../accounts/secrets'
import type { DoctorCheck, DoctorContext } from '../doctor/types'
import type { BrokerSession, BrokeredTools } from '../mcp/service'
import type { RefineHost } from '../refine/host'
import type { RunEvent } from '../sessions/contracts'
import type { ToolPolicy } from '../sessions/policy'
import { findRun } from '../sessions/runStore'
import type { ToolProvider, ToolSession, ToolSpec } from '../tools/types'
import { remoteDirectory, remotePolicy, remoteSecrets, remoteTools } from './remote'
import type { RpcPeer } from './rpc'

/** What a host tells the harness when it registers. */
export interface HostRegistration {
  /** Names the host for as long as the daemon runs: a host that reconnects under the same name gets its sessions back. */
  name: string
  secrets?: boolean
  policy?: boolean
  directory?: boolean
  tools?: boolean
  /** The names of the tools it offers through the connected-apps broker, and a sentence for the discovery tool. */
  broker?: { names: string[]; note?: string } | false
  refine?: boolean
}

interface Host {
  name: string
  peer: RpcPeer
  registration: HostRegistration
  secrets?: SecretStore
  policy?: ToolPolicy
  directory?: Directory
  tools?: ToolProvider
  brokerNames: Set<string>
}

export interface HostHubOptions {
  root(): string
  /** Tools the harness itself offers a host's session beside the host's own (for example a paired browser's). */
  extraTools?(session: ToolSession): ToolSpec[] | Promise<ToolSpec[]>
  /** Called once, the first time a host registers a tool provider, a broker or a refine host. */
  install?: { tools?(provider: ToolProvider): void; broker?(tools: BrokeredTools): void; refine?(host: RefineHost): void }
}

const OWNER_LIMIT = 5000
const unavailable = (name: string): HarnessError => new HarnessError('host_unavailable', `The host ${name} that started this session is not connected.`)

export class HostHub {
  private readonly hosts = new Map<string, Host>()
  private readonly byPeer = new Map<RpcPeer, Host>()
  private readonly owners = new Map<string, string>()
  private readonly unowned = new Set<string>()
  private installed = { tools: false, broker: false, refine: false }

  /** Secrets from the host that supplies them; with none connected a call fails, never answers empty. */
  readonly secrets: SecretStore = {
    get: async (key) => this.secretHost().get(key),
    set: async (key, value) => this.secretHost().set(key, value),
    delete: async (key) => this.secretHost().delete(key)
  }

  /** The policy of the host that owns the run; a run with no host is not gated by one. */
  readonly policy: ToolPolicy = {
    scope: async (call) => {
      const policy = this.policyFor(call.run.sessionId, call.run.id)
      return policy ? policy.scope(call) : { allowed: true }
    },
    authorize: async (call) => {
      const policy = this.policyFor(call.run.sessionId, call.run.id)
      if (policy) await policy.authorize(call)
    },
    approval: async (input) => {
      const owner = this.ownerOf(input.run.sessionId, input.run.id)
      if (!owner) return {}
      const host = this.hosts.get(owner)
      // Nobody can say what the host's scope covers: nothing is approved on its behalf.
      return host?.policy?.approval ? host.policy.approval(input) : { unattended: true }
    },
    connections: async (input) => {
      const owner = this.ownerOf(input.sessionId, input.runId ?? undefined)
      if (!owner) return input.connectionIds
      const host = this.hosts.get(owner)
      return host?.policy?.connections ? host.policy.connections(input) : []
    }
  }

  readonly directory: Directory = {
    agentName: (id) => this.firstDirectory((directory) => directory.agentName(id)),
    sessionAgent: (id) => this.firstDirectory((directory) => directory.sessionAgent(id))
  }

  readonly tools: ToolProvider = Object.assign(
    async (session: ToolSession): Promise<ToolSpec[]> => {
      const owner = this.ownerOf(session.run.sessionId, session.run.runId)
      const own = owner ? await this.hosts.get(owner)?.tools?.(session) ?? [] : []
      const extra = owner ? await this.options.extraTools?.(session) ?? [] : []
      // The harness's own tool of a name wins over the host's (a paired browser's over the host's native one).
      const taken = new Set(extra.map((spec) => spec.name))
      return [...own.filter((spec) => !taken.has(spec.name)), ...extra]
    },
    {
      diagnostics: async (context: DoctorContext): Promise<DoctorCheck[]> =>
        (await Promise.all([...this.hosts.values()].map((host) => host.tools?.diagnostics?.(context) ?? []))).flat()
    }
  )

  readonly broker: BrokeredTools

  readonly refine: RefineHost = {
    prepareWorkspace: async (input) => {
      const host = this.refineHost()
      const result = await host.peer.callHost<{ cwd: string; token: unknown }>('refine.workspace', input, 120_000)
      return { cwd: result.cwd, cleanup: async () => void (await host.peer.callHost('refine.cleanup', { token: result.token }, 120_000)) }
    },
    session: (input) => this.refineHost().peer.callHost('refine.session', input, 60_000),
    deliverable: (input) => this.refineHost().peer.callHost('refine.deliverable', input, 60_000)
  }

  /** A sentence for the discovery tool, from the host that registered a broker. */
  private note = ''

  constructor(private readonly options: HostHubOptions) {
    const hub = this
    this.broker = {
      list: async (session) => {
        const host = hub.brokerHost(session)
        return host ? host.peer.callHost('broker.list', { session: wire(session) }, 90_000) : []
      },
      has: (name) => [...hub.hosts.values()].some((host) => host.brokerNames.has(name)),
      call: async (session, name, args) => {
        const host = hub.brokerHost(session)
        if (!host) throw new HarnessError('host_unavailable', 'The host that offers this tool is not connected.')
        return host.peer.callHost('broker.call', { session: wire(session), name, args }, 360_000)
      },
      revision: async (session) => {
        const host = hub.brokerHost(session)
        return host ? host.peer.callHost('broker.revision', { session: wire(session) }, 30_000) : null
      },
      get discoveryNote() {
        return hub.note
      }
    }
  }

  /** A connection becomes a host: what it supplies is routed to it from now on. */
  register(peer: RpcPeer, registration: HostRegistration): { name: string; resumed: string[] } {
    const name = typeof registration?.name === 'string' ? registration.name.trim() : ''
    if (!name) throw new HarnessError('invalid_request', 'A host needs a name.')
    const previous = this.hosts.get(name)
    if (previous && previous.peer !== peer) this.byPeer.delete(previous.peer)
    const host: Host = { name, peer, registration, brokerNames: new Set(registration.broker ? registration.broker.names : []) }
    if (registration.secrets) host.secrets = remoteSecrets(peer)
    if (registration.policy) host.policy = remotePolicy(peer)
    if (registration.directory) host.directory = remoteDirectory(peer)
    if (registration.tools) host.tools = remoteTools(peer)
    this.hosts.set(name, host)
    this.byPeer.set(peer, host)
    if (registration.broker) this.note = registration.broker.note ?? ''
    if (host.tools && !this.installed.tools) {
      this.installed.tools = true
      this.options.install?.tools?.(this.tools)
    }
    if (registration.broker && !this.installed.broker) {
      this.installed.broker = true
      this.options.install?.broker?.(this.broker)
    }
    if (registration.refine && !this.installed.refine) {
      this.installed.refine = true
      this.options.install?.refine?.(this.refine)
    }
    return { name, resumed: [...this.owners].filter(([, owner]) => owner === name).map(([sessionId]) => sessionId) }
  }

  /** A connection closed. Its sessions stay its own, so the host finds them again when it reconnects. */
  drop(peer: RpcPeer): void {
    const host = this.byPeer.get(peer)
    if (!host) return
    this.byPeer.delete(peer)
    if (this.hosts.get(host.name) === host) this.hosts.delete(host.name)
  }

  isHost(peer: RpcPeer): boolean {
    return this.byPeer.has(peer)
  }

  hostNames(): string[] {
    return [...this.hosts.keys()]
  }

  /** The connection started a run: the session is the host's from now on. */
  claim(peer: RpcPeer, sessionId: unknown): void {
    const host = this.byPeer.get(peer)
    if (!host || typeof sessionId !== 'string' || !sessionId) return
    if (!this.owners.has(sessionId) && this.owners.size >= OWNER_LIMIT) this.owners.delete(this.owners.keys().next().value as string)
    this.owners.set(sessionId, host.name)
    this.unowned.delete(sessionId)
  }

  /** Whether a run event goes to this connection: a host hears only its own sessions' events, anyone else hears all. */
  deliver(peer: RpcPeer, event: RunEvent): boolean {
    const host = this.byPeer.get(peer)
    if (!host) return true
    return this.ownerOf(event.sessionId, event.runId) === host.name
  }

  /** The host that owns a session, directly or through the run that started it (a subagent's). */
  ownerOf(sessionId: string, runId?: string): string | null {
    const direct = this.owners.get(sessionId)
    if (direct) return direct
    if (this.unowned.has(sessionId) && !runId) return null
    let id = runId
    for (let depth = 0; id && depth < 6; depth += 1) {
      const record = findRun(this.options.root(), id)
      if (!record) break
      const owner = this.owners.get(record.sessionId)
      if (owner) {
        this.owners.set(sessionId, owner)
        return owner
      }
      id = record.parentRunId ?? undefined
    }
    if (this.unowned.size > 2000) this.unowned.clear()
    this.unowned.add(sessionId)
    return null
  }

  /** The scope and authorize calls of the host that owns the run, or null when no host does. */
  private policyFor(sessionId: string, runId: string): { scope: NonNullable<ToolPolicy['scope']>; authorize: NonNullable<ToolPolicy['authorize']> } | null {
    const owner = this.ownerOf(sessionId, runId)
    if (!owner) return null
    const host = this.hosts.get(owner)
    if (!host) throw unavailable(owner)
    // A host that supplies no policy leaves its runs ungated, as an embedded host with none does.
    if (!host.policy?.scope || !host.policy.authorize) return { scope: async () => ({ allowed: true }), authorize: async () => undefined }
    return { scope: host.policy.scope.bind(host.policy), authorize: host.policy.authorize.bind(host.policy) }
  }

  private secretHost(): SecretStore {
    for (const host of this.hosts.values()) if (host.secrets) return host.secrets
    throw new HarnessError('host_unavailable', 'The host that keeps this profile\'s credentials is not connected.')
  }

  private firstDirectory(look: (directory: Directory) => string | null): string | null {
    for (const host of this.hosts.values()) {
      const found = host.directory ? look(host.directory) : null
      if (found) return found
    }
    return null
  }

  private brokerHost(session: BrokerSession): Host | null {
    const owner = this.ownerOf(session.sessionId, session.runId ?? undefined)
    const host = owner ? this.hosts.get(owner) : undefined
    return host?.registration.broker ? host : null
  }

  private refineHost(): Host {
    for (const host of this.hosts.values()) if (host.registration.refine) return host
    throw new HarnessError('host_unavailable', 'The host that prepares refinement workspaces is not connected.')
  }
}

/** What a host needs to know about a broker session: who asks, never the token. */
function wire(session: BrokerSession): Record<string, unknown> {
  return { sessionId: session.sessionId, runId: session.runId, caller: session.caller, readOnly: session.readOnly, depth: session.depth }
}
