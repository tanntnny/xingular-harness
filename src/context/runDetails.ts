import { loadRun as loadCapabilities } from '../capabilities/runSnapshot'
import { loadRun, readEvents } from '../sessions/runStore'

/** Facts recorded for one run. Null means that the fact was not recorded. */
export interface RunDetails {
  runId: string
  status: string | null
  mode: string | null
  model: string | null
  effort: string | null
  variantScope: string | null
  variantVersion: string | null
  workspaceRoot: string | null
  tools: string[] | null
  connectors: string[] | null
  skills: string[] | null
  plugins: string[] | null
}

export function runDetails(root: string, runId: string): RunDetails {
  const run = loadRun(root, runId)
  const capabilities = loadCapabilities(root, runId)
  const snapshot = readEvents(root, runId).filter((event) => event.type === 'context.snapshot').at(-1)
  const payload = snapshot?.payload as { tools?: { name: string }[]; toolsTruncated?: boolean } | undefined
  return {
    runId: run.id,
    status: run.status ?? null,
    mode: run.effectiveMode ?? null,
    model: run.model ?? null,
    effort: run.effort ?? null,
    variantScope: run.variantScope ?? null,
    variantVersion: run.variantVersion ?? null,
    workspaceRoot: run.workspaceRoot ?? null,
    tools: payload && !payload.toolsTruncated && Array.isArray(payload.tools) ? payload.tools.map((tool) => tool.name) : null,
    connectors: capabilities?.connectors ?? null,
    skills: run.loadedSkills ?? null,
    plugins: run.activatedPlugins ?? null
  }
}
