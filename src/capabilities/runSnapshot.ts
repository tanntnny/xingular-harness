import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { HarnessError, invalid } from '../core/errors'
import { readJson, safeId, writeJson } from '../core/fs'
import type { CapabilitySet } from './types'

export interface RunCapabilitySnapshot {
  version: 1
  caller: { agentId: string | null; projectId: string | null }
  tools: string[]
  connectors: string[]
  contributions: string[]
}

const path = (root: string, runId: string): string => join(root, 'runs', safeId(runId), 'capabilities.json')

function strings(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))] : []
}

export function capabilitySet(value: unknown): CapabilitySet {
  if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== 1) throw invalid('A capability set must use version 1.')
  const record = value as Record<string, unknown>
  return { version: 1, tools: strings(record.tools), connectors: strings(record.connectors), contributions: strings(record.contributions) }
}

/** Writes a run's capability set once. A resumed or duplicate launch cannot replace it. */
export function freezeRun(root: string, runId: string, caller: { agentId?: string | null; projectId?: string | null }, set: CapabilitySet): RunCapabilitySnapshot {
  const target = path(root, runId)
  const snapshot: RunCapabilitySnapshot = {
    version: 1,
    caller: { agentId: caller.agentId ?? null, projectId: caller.projectId ?? null },
    tools: strings(set.tools),
    connectors: strings(set.connectors),
    contributions: strings(set.contributions)
  }
  const existing = existsSync(target) ? readJson<RunCapabilitySnapshot>(target) : null
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(snapshot)) throw new HarnessError('capabilities_frozen', 'This run already has a different frozen capability set.')
    return existing
  }
  writeJson(target, snapshot)
  return snapshot
}

export function loadRun(root: string, runId: string): RunCapabilitySnapshot | null {
  const stored = readJson<unknown>(path(root, runId))
  if (!stored || typeof stored !== 'object' || (stored as { version?: unknown }).version !== 1) return null
  const record = stored as Record<string, unknown>
  const caller = record.caller && typeof record.caller === 'object' ? record.caller as Record<string, unknown> : {}
  return {
    version: 1,
    caller: { agentId: typeof caller.agentId === 'string' ? caller.agentId : null, projectId: typeof caller.projectId === 'string' ? caller.projectId : null },
    tools: strings(record.tools),
    connectors: strings(record.connectors),
    contributions: strings(record.contributions)
  }
}
