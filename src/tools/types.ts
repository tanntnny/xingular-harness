// A tool as the harness holds it: described without Pi imports, so a provider can be written
// against this package alone. The session turns each one into a Pi tool.
import type { CallerContext } from '../memory/caller'
import type { CapabilitySet } from '../capabilities/types'
import type { ActiveRun } from '../sessions/registry'
import type { ToolAttachmentRef } from '../sessions/contracts'

export interface ToolResult {
  text: string
  /** Native-history metadata; never interpreted as model instructions. */
  details?: Record<string, unknown>
  image?: { data: string; mimeType: string }
  /** References to content stored by the provider; bytes never enter the run-event stream. */
  attachments?: ToolAttachmentRef[]
}

export interface ToolSpec {
  name: string
  label: string
  description: string
  /** Builds the TypeBox parameter schema. */
  parameters: (type: typeof import('typebox').Type) => unknown
  /** Only reads or asks; such a tool stays callable in plan mode. */
  readOnly?: boolean
  /** Whether this particular call is safe for plan-mode research. Refusals happen before approvals. */
  planModeSafe?: (input: Record<string, unknown>) => boolean
  execute: (input: Record<string, unknown>) => Promise<string | ToolResult>
}

/** What a tool provider is told about the session it is building tools for. */
export interface ToolSession {
  run: ActiveRun
  caller: CallerContext
  /** The tool names switched on for this session. */
  allow: readonly string[]
  /** Hops from the user to this session (0 when the user started it). */
  depth: number
  /** The session's working folder. */
  cwd: string
  /** The capability set frozen when this run started. */
  capabilities: CapabilitySet
}

/** Builds the tools a session may be given. Only those named in `allow` are registered. */
export type ToolProvider = (session: ToolSession) => ToolSpec[] | Promise<ToolSpec[]>
