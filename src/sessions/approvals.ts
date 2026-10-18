// What the user has chosen to stop being asked about: an "always approve" switch, tools allowed
// across a harness state directory, and tools remembered for one session.
import { chmodSync } from 'node:fs'
import { join } from 'node:path'

import type { Bus } from '../core/bus'
import { invalid } from '../core/errors'
import { readJson, writeJson } from '../core/fs'
import type { RunRecord } from './contracts'

/** Kinds of session with a switch: an agent's own conversations, and sessions in a project. */
export const APPROVAL_KEYS = ['chat', 'pi'] as const

export interface ApprovalPolicy {
  /** Switch key → every approval is granted without asking. */
  auto: Record<string, boolean>
  /** Approval key → tools allowed across sessions that share this local state directory. */
  globalTools: Record<string, string[]>
  /** Session id → approval targets always allowed there. */
  remembered: Record<string, string[]>
}

/** Why a request is granted without asking. */
export type AutomaticReason = 'always' | 'remembered' | 'scope'

/** What only the embedding application knows about a pending approval. */
export interface ApprovalFacts {
  /** Unattended work keeps to its saved scope whatever the switches say. */
  unattended?: boolean
  /** The session may not change anything; the switch must not approve its way out of that. */
  readOnly?: boolean
  /** The application's own scope already covers this exact operation. */
  inScope?: boolean
}

/** Why the standing choices grant this request, if they do. */
export function decide(policy: ApprovalPolicy, key: string, sessionId: string, target: string): AutomaticReason | null {
  if (policy.auto[key]) return 'always'
  if (policy.globalTools[key]?.includes(target)) return 'remembered'
  return policy.remembered[sessionId]?.includes(target) ? 'remembered' : null
}

export function grant(policy: ApprovalPolicy, key: string, sessionId: string, target: string, facts: ApprovalFacts = {}): AutomaticReason | null {
  if (facts.unattended) return null
  // "Always approve" must not let a read-only session approve its way out of read-only mode.
  return decide(facts.readOnly ? { auto: {}, globalTools: {}, remembered: policy.remembered } : policy, key, sessionId, target)
}

/** A conversation's runs share one switch whatever model they use; other runs follow their own. */
export const approvalKey = (run: Pick<RunRecord, 'mode' | 'harness'>): string => (run.mode === 'chat' ? 'chat' : run.harness)

export class Approvals {
  private readonly path: string

  constructor(stateDir: string, private readonly bus: Bus) {
    this.path = join(stateDir, 'approvals.json')
  }

  read(): ApprovalPolicy {
    const stored = readJson<Partial<ApprovalPolicy>>(this.path) ?? {}
    return { auto: stored.auto ?? {}, globalTools: stored.globalTools ?? {}, remembered: stored.remembered ?? {} }
  }

  private change(update: (policy: ApprovalPolicy) => void): ApprovalPolicy {
    const policy = this.read()
    update(policy)
    writeJson(this.path, policy)
    try {
      chmodSync(this.path, 0o600)
    } catch {
      // The file was written; a mode that cannot be set is not worth failing the change.
    }
    this.bus.emit({ type: 'approvals.changed' })
    return policy
  }

  isAuto(key: string): boolean {
    try {
      return Boolean(this.read().auto[key])
    } catch {
      return false
    }
  }

  /** Why this run's approval for `target` can be granted without asking, if it can. */
  automatic(run: RunRecord, target: string, facts: ApprovalFacts = {}): AutomaticReason | null {
    // What the application's own scope already covers needs neither the switch nor the user.
    return grant(this.read(), approvalKey(run), run.sessionId, target, facts) ?? (!facts.unattended && facts.inScope ? 'scope' : null)
  }

  setAuto(key: string, on: boolean): ApprovalPolicy {
    if (!(APPROVAL_KEYS as readonly string[]).includes(key)) throw invalid('Unknown harness.')
    return this.change((policy) => void (policy.auto[key] = on))
  }

  /** Always allow `target` for every session in this approval profile and state directory. */
  allowTool(key: string, target: string): ApprovalPolicy {
    if (!(APPROVAL_KEYS as readonly string[]).includes(key)) throw invalid('Unknown harness.')
    if (!target.trim()) throw invalid('A tool is required.')
    return this.change((policy) => {
      const targets = (policy.globalTools[key] ??= [])
      if (!targets.includes(target)) targets.push(target)
    })
  }

  revokeTool(key: string, target: string): ApprovalPolicy {
    if (!(APPROVAL_KEYS as readonly string[]).includes(key)) throw invalid('Unknown harness.')
    return this.change((policy) => {
      const targets = policy.globalTools[key]?.filter((item) => item !== target) ?? []
      if (targets.length) policy.globalTools[key] = targets
      else delete policy.globalTools[key]
    })
  }

  /** Always allow `target` in this session. */
  remember(sessionId: string, target: string): ApprovalPolicy {
    if (!target.trim()) throw invalid('A tool is required.')
    return this.change((policy) => {
      const targets = (policy.remembered[sessionId] ??= [])
      if (!targets.includes(target)) targets.push(target)
    })
  }

  forget(sessionId: string, target: string): ApprovalPolicy {
    return this.change((policy) => {
      const targets = policy.remembered[sessionId]?.filter((item) => item !== target) ?? []
      if (targets.length) policy.remembered[sessionId] = targets
      else delete policy.remembered[sessionId]
    })
  }

  /** Forgets what was remembered for a session that no longer exists. */
  forgetSession(sessionId: string): void {
    try {
      if (sessionId in this.read().remembered) this.change((policy) => void delete policy.remembered[sessionId])
    } catch {
      // Nothing recorded.
    }
  }
}
