// The seams of refinement. The method (recursion, selection, reflection, library) needs only
// these: something that runs a harness on a task (an Executor) and something that runs an
// improver session over an evidence folder (an Improver). The harness supplies Pi-backed ones;
// tests and the demo supply deterministic ones.
//
// Shaped after Harness² (Apache-2.0, Google LLC; `core/spec.py`, `substrate/base.py`,
// `core/proposer.py`).
import type { Variant } from '../variant/surface'
import type { WorkPrompts } from './prompts'

export type RecursionMode = 'parallel' | 'sequential'

/** One piece of work to refine on. */
export interface RefineTask {
  /** Stable id of the task; names its folder and its library entry. */
  id: string
  /** The request, as the agent received it, with any expected answer stripped. */
  prompt: string
  /** The harness scope: whose variant this is and whose library it reads and grows. */
  scope: string
  /** A grouping inside the scope's library. Defaults to the scope. */
  domain?: string
  /** Material the work was done from, served to improvers and the selector as `source/`. */
  sourceDir?: string | null
  /** Paths that must never reach a model (answer keys and the like), as globs. */
  leakGlobs?: string[]
  /** The text about the work the prompts interpolate. */
  prompts?: WorkPrompts
  /** Whether a harness here may carry subagents. Default true. */
  allowSubagents?: boolean
}

/** What the method knows about one finished execution. Never carries a score. */
export interface Rollout {
  label: string
  runId: string
  /** A folder that holds this execution's evidence. */
  dir: string
  ok: boolean
  delivered: boolean
  costUsd: number
  wallMs: number
  error: string
}

export interface Executor {
  /**
   * Runs one execution of `task` with the harness in `variantDir` (null: the base harness) and
   * returns what it produced. A failure is returned as `ok: false`, never thrown.
   */
  execute(task: RefineTask, variantDir: string | null, label: string, runId: string): Promise<Rollout>
  /** The execution in the shared `[ACTION]/[OBSERVATION]/[ERROR]` grammar. */
  trajectory(rollout: Rollout, options: { obsTrunc: number }): string
  /** filename → readable text, one entry per artifact produced. */
  deliverableFiles(rollout: Rollout): Record<string, string>
  /** Extra validation of a proposed variant for this task; throw with every problem listed. */
  validateVariant?(task: RefineTask, variant: Variant): void
}

export interface ImproverReply {
  label: string
  text: string
  costUsd: number
  attempts: number
  cached: boolean
  /** The harvested folder, when the call asked for one; null when it did not come back. */
  workspace: string | null
}

export class ImproverError extends Error {
  constructor(message: string, readonly attempts = 0, readonly costUsd = 0) {
    super(message)
    this.name = 'ImproverError'
  }
}

export interface ImproverCall {
  /** The instruction; evidence stays on disk under `context/`. */
  mission: string
  /** The folder copied into the session as `context/`. */
  contextDir: string
  /** A unique label for the audit trail and cache. */
  label: string
  /** A path inside the session's folder to copy out before it is removed, e.g. `context/harness`. */
  harvest?: string
  signal?: AbortSignal
}

export interface Improver {
  call(input: ImproverCall): Promise<ImproverReply>
}
