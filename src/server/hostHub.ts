// Hosts that share one long-lived harness (ADR-0083, phase 3). A host that embeds the harness in its
// own process supplies its secret store, tool policy, names, tools, connected-apps broker and refine
// host in-process. A host that connects to the daemon over its socket supplies the same things as
// calls the harness makes back to it (page 10), and the harness has to know which host's answer a
// call needs, because terminal windows share the process. A session belongs to the host that started
// its run; a run with no host (a terminal's) is gated and given tools as it would be with no host.
//
// The hub holds no application's name or concept (INV-BND-2): a host says what it is called and what
// it supplies when it registers.
import { AsyncLocalStorage } from 'node:async_hooks'

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
  /** How long a call that needs a host waits for it to come back before it fails (default two minutes). */
  awayMs?: number
  /** How many sessions' owners are remembered; the least recently used is forgotten first. */
  ownerLimit?: number
}

const OWNER_LIMIT = 50_000
/** Notices that belong to the call that caused them (a sign-in URL opens where the person asked for it). */
const PRIVATE_NOTICES = new Set(['connections.openUrl', 'accounts.loginEvent'])
const unavailable = (name: string): HarnessError => new HarnessError('host_unavailable', `The host ${name} that started this session is not connected.`)

export class HostHub {
  private readonly hosts = new Map<string, Host>()
  private readonly byPeer = new Map<RpcPeer, Host>()
  private readonly owners = new Map<string, string>()
  private readonly unowned = new Set<string>()
  private readonly arrivals = new Set<(name: string) => void>()
  private installed = { tools: false, broker: false, refine: false }

  /**
   * The host connection a call came in on, for as long as that call's work runs. A run started inside it
   * (a side question, a refinement, a subagent, a doctor probe) belongs to that host without the call
   * having to say so.
   */
  readonly origin = new AsyncLocalStorage<RpcPeer>()

  /** Secrets from the host that supplies them; with none connected a call fails, never answers empty. */
  readonly secrets: SecretStore = {
    get: async (key) => (await this.secretHost()).get(key),
    set: async (key, value) => (await this.secretHost()).set(key, value),
    delete: async (key) => (await this.secretHost()).delete(key)
  }

  /** The policy of the host that owns the run; a run with no host is not gated by one. */
  readonly policy: ToolPolicy = {
    scope: async (call) => {
      const policy = await this.policyFor(call.run.sessionId, call.run.id)
      return policy ? policy.scope(call) : { allowed: true }
    },
    authorize: async (call) => {
      const policy = await this.policyFor(call.run.sessionId, call.run.id)
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
        const owner = hub.ownerOf(session.sessionId, session.runId ?? undefined)
        const host = owner ? await hub.until(() => { const found = hub.hosts.get(owner); return found?.registration.broker ? found : undefined }) : undefined
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
    for (const wake of [...this.arrivals]) wake(name)
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
    this.own(sessionId, host.name)
  }

  /** A run started while a host's call was being served: its session is that host's. */
  claimFromCall(sessionId: string): void {
    const peer = this.origin.getStore()
    if (peer) this.claim(peer, sessionId)
  }

  /** Records an owner and makes it the newest, so the sessions in use are the last to be forgotten. */
  private own(sessionId: string, name: string): void {
    this.owners.delete(sessionId)
    this.owners.set(sessionId, name)
    while (this.owners.size > (this.options.ownerLimit ?? OWNER_LIMIT)) this.owners.delete(this.owners.keys().next().value as string)
    this.unowned.delete(sessionId)
  }

  /** Whether a run event goes to this connection: a host hears only its own sessions' events, anyone else hears all. */
  deliver(peer: RpcPeer, event: RunEvent): boolean {
    const host = this.byPeer.get(peer)
    if (!host) return true
    return this.ownerOf(event.sessionId, event.runId) === host.name
  }

  /**
   * Whether a notice goes to this connection. A sign-in link belongs to the call that asked for it: the
   * host that made the call, or, for a call no host made, the clients that are not hosts.
   */
  deliverNotice(peer: RpcPeer, notice: { type?: string }): boolean {
    if (!notice.type || !PRIVATE_NOTICES.has(notice.type)) return true
    const origin = this.origin.getStore()
    return origin ? origin === peer : !this.byPeer.has(peer)
  }

  /** The host that owns a session, directly or through the run that started it (a subagent's). */
  ownerOf(sessionId: string, runId?: string): string | null {
    const direct = this.owners.get(sessionId)
    if (direct) {
      this.own(sessionId, direct)
      return direct
    }
    if (this.unowned.has(sessionId) && !runId) return null
    let id = runId
    for (let depth = 0; id && depth < 6; depth += 1) {
      const record = findRun(this.options.root(), id)
      if (!record) break
      const owner = this.owners.get(record.sessionId)
      if (owner) {
        this.own(sessionId, owner)
        return owner
      }
      id = record.parentRunId ?? undefined
    }
    if (this.unowned.size > 2000) this.unowned.clear()
    this.unowned.add(sessionId)
    return null
  }

  /** The scope and authorize calls of the host that owns the run, or null when no host does. */
  private async policyFor(sessionId: string, runId: string): Promise<{ scope: NonNullable<ToolPolicy['scope']>; authorize: NonNullable<ToolPolicy['authorize']> } | null> {
    const owner = this.ownerOf(sessionId, runId)
    if (!owner) return null
    // A host that is briefly away (it restarted) is waited for; a run is never gated by nobody.
    const host = await this.until(() => this.hosts.get(owner))
    if (!host) throw unavailable(owner)
    // A host that supplies no policy leaves its runs ungated, as an embedded host with none does.
    if (!host.policy?.scope || !host.policy.authorize) return { scope: async () => ({ allowed: true }), authorize: async () => undefined }
    return { scope: host.policy.scope.bind(host.policy), authorize: host.policy.authorize.bind(host.policy) }
  }

  private async secretHost(): Promise<SecretStore> {
    const host = await this.until(() => [...this.hosts.values()].find((candidate) => candidate.secrets))
    if (!host?.secrets) throw new HarnessError('host_unavailable', 'The host that keeps this profile\'s credentials is not connected.')
    return host.secrets
  }

  /** The host `find` looks for, now or when one registers within `awayMs`; undefined when none comes. */
  private async until(find: () => Host | undefined): Promise<Host | undefined> {
    const now = find()
    if (now) return now
    const limit = this.options.awayMs ?? 120_000
    if (limit <= 0) return undefined
    return new Promise<Host | undefined>((resolve) => {
      const done = (host?: Host): void => {
        clearTimeout(timer)
        this.arrivals.delete(arrived)
        resolve(host)
      }
      const arrived = (): void => {
        const found = find()
        if (found) done(found)
      }
      const timer = setTimeout(() => done(undefined), limit)
      timer.unref?.()
      this.arrivals.add(arrived)
    })
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
