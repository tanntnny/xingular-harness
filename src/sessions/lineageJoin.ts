import type { AgentBeforeSettleEvent, BoundaryResult, ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

import { takeChars } from '../core/text'
import { isActiveStatus } from './contracts'
import { readEvents, runFamily } from './runStore'
import type { InlineExtension } from '../plugins/firstParty'

interface RunSummary {
  id: string
  status: string
  goal: string | null
  terminalReason: string | null
}

function directChildren(root: string, runId: string): RunSummary[] {
  try {
    return runFamily(root, runId).runs
      .map(({ run }) => run)
      .filter((run) => run.parentRunId === runId)
      .map((run) => ({ id: run.id, status: run.status, goal: run.goal, terminalReason: run.terminalReason }))
  } catch {
    return []
  }
}

function settled(root: string, runId: string): boolean {
  return directChildren(root, runId).every((child) => !isActiveStatus(child.status))
}

function alreadyIncluded(event: AgentBeforeSettleEvent, runId: string): boolean {
  return JSON.stringify(event.context.contextMessages).includes(runId)
}

function childReport(root: string, child: RunSummary): string {
  const reply = readEvents(root, child.id)
    .filter((event) => event.type === 'message.completed' && (event.payload as { role?: unknown }).role === 'assistant')
    .at(-1)
  const payload = reply?.payload as { text?: unknown } | undefined
  const text = payload && typeof payload.text === 'string' ? takeChars(payload.text, 8000) : ''
  const lines = [`Run ${child.id} · ${child.status}`, `Goal: ${child.goal?.trim() || '(not recorded)'}`]
  if (text) lines.push(`Result:\n${text}`)
  if (child.status !== 'completed' && child.terminalReason) lines.push(`Stopped because: ${child.terminalReason}`)
  return lines.join('\n')
}

async function waitForChildren(root: string, runId: string, signal?: AbortSignal): Promise<boolean> {
  while (!signal?.aborted) {
    if (settled(root, runId)) return true
    await new Promise<void>((resolve) => setTimeout(resolve, 250))
  }
  return false
}

function install(pi: ExtensionAPI, root: string, runId: string): void {
  pi.on('agent_before_settle', async (event, context: ExtensionContext): Promise<BoundaryResult | undefined> => {
    if (event.outcome !== 'completed' || settled(root, runId)) return undefined
    const completed = await waitForChildren(root, runId, context.signal)
    if (!completed || context.signal?.aborted) return undefined

    const unreported = directChildren(root, runId).filter((child) => !alreadyIncluded(event, child.id))
    if (!unreported.length) return undefined
    const summary = takeChars(
      `Independent run results. Include each result or failure in the reply; the user may open each run for its full history.\n\n${unreported.map((child) => childReport(root, child)).join('\n\n')}`,
      32_000
    )
    return {
      entries: [...event.entries, { type: 'custom_message', customType: 'run-lineage-results', content: summary, display: false }],
      continue: true
    }
  })
}

export function runLineageJoin(root: string, runId: string): InlineExtension {
  return { name: 'run-lineage-join', factory: (pi: ExtensionAPI) => install(pi, root, runId) }
}
