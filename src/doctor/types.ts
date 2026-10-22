import { z } from 'zod'
import type { CallerContext } from '../core/caller'
import type { CapabilitySet } from '../capabilities/types'
import type { VariantChoice } from '../variant/materialise'
import type { ToolResult } from '../tools/types'
import type { ActiveRun } from '../sessions/registry'

export const findingSchema = z.object({
  id: z.string(), category: z.string(), title: z.string(),
  status: z.enum(['pass', 'warning', 'fail', 'disabled', 'blocked', 'unverified']),
  verification: z.enum(['local', 'live']), evidence: z.string(), remedy: z.string().optional(),
  checkedAt: z.string()
})
export type DoctorFinding = z.infer<typeof findingSchema>
export type CheckResult = Pick<DoctorFinding, 'status' | 'evidence' | 'remedy'>

export interface DoctorContext {
  caller: CallerContext
  cwd: string
  accountId: string | null
  model: string | null
  tools: readonly string[]
  capabilities?: CapabilitySet
  variant?: VariantChoice | null
}

export interface DoctorCheck {
  id: string
  category: string
  title: string
  tools?: readonly string[]
  /** Readiness inspection only: no network, authentication or world actions. */
  local(signal: AbortSignal): Promise<CheckResult>
  live?: {
    /** Shown to the person before confirmation. Include destinations, costs and isolation. */
    notice: string
    run(context: DoctorProbeContext): Promise<CheckResult>
  }
}

export interface DoctorProbeContext {
  run: ActiveRun
  signal: AbortSignal
  context: DoctorContext
  /** Executes an enabled tool through the existing per-call gate. */
  call(tool: string, input: Record<string, unknown>): Promise<string | ToolResult>
}

/** Optional metadata on a callable tool provider; no new Harness extension point. */
export interface ProviderDiagnostics {
  diagnostics?(context: DoctorContext): DoctorCheck[] | Promise<DoctorCheck[]>
}

export const doctorInputSchema = z.object({
  context: z.object({
    caller: z.record(z.string(), z.unknown()).default({}), cwd: z.string().min(1),
    accountId: z.string().nullable(), model: z.string().nullable(), tools: z.array(z.string()),
    variant: z.union([
      z.object({ scope: z.string(), version: z.string().nullable().optional() }),
      z.object({ dir: z.string(), scope: z.string().nullable().optional() })
    ]).nullable().optional(),
    capabilities: z.object({ version: z.literal(1), tools: z.array(z.string()), connectors: z.array(z.string()), contributions: z.array(z.string()) }).optional()
  }),
  mode: z.enum(['local', 'live']).default('local'),
  checks: z.array(z.string()).default([]),
  /** A trusted host attests that the person approved these exact checks. */
  confirmed: z.boolean().default(false)
})
export interface DoctorInput {
  context: DoctorContext
  mode?: 'local' | 'live'
  checks?: string[]
  confirmed?: boolean
}

export const doctorReportSchema = z.object({
  id: z.string(), state: z.enum(['running', 'completed', 'cancelled']),
  startedAt: z.string(), endedAt: z.string().nullable(), mode: z.enum(['local', 'live']),
  context: z.object({ accountId: z.string().nullable(), model: z.string().nullable() }),
  completed: z.number(), total: z.number(), findings: z.array(findingSchema),
  liveChecks: z.array(z.object({ id: z.string(), title: z.string(), notice: z.string() }))
})
export type DoctorReport = z.infer<typeof doctorReportSchema>
