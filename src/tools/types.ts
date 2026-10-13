// A tool as the harness holds it: described without Pi imports, so a provider can be written
// against this package alone. The session turns each one into a Pi tool.
import type { CallerContext } from '../memory/caller'
import type { CapabilitySet } from '../capabilities/types'
import type { ActiveRun } from '../sessions/registry'

export interface ToolResult {
  text: string
  image?: { data: string; mimeType: string }
}

export interface ToolSpec {
  name: string
  label: string
  description: string
  /** Builds the TypeBox parameter schema. */
  parameters: (type: typeof import('typebox').Type) => unknown
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
