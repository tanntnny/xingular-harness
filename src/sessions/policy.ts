// What the embedding application decides about a session's tool calls. The harness asks; it
// never assumes: with no policy, every enabled tool may run and gated tools ask the user.
import type { CallerContext } from '../memory/caller'
import type { ApprovalFacts } from './approvals'
import type { RunRecord } from './contracts'

export interface ToolCall {
  run: RunRecord
  caller: CallerContext
  tool: string
  args: unknown
}

export interface ScopeDecision {
  /** The run is unattended: nothing may ask a person, so what is not allowed is refused. */
  automatic?: boolean
  allowed: boolean
  /** Not allowed as it stands, but a person may approve this one call. */
  requiresApproval?: boolean
  /** Whatever standing choices exist, a person decides this call: no always-approve, no remembered answer. */
  humanOnly?: boolean
  reason?: string | null
}

export interface ToolPolicy {
  /** Whether the call is inside what this run may do. Asked before every tool call. */
  scope?(call: ToolCall): Promise<ScopeDecision>
  /** Whether the tool is still switched on. Asked before a call and again after an approval; throws to block. */
  authorize?(call: ToolCall): Promise<void>
  /** Facts about a pending approval that only the application knows. */
  approval?(input: { run: RunRecord; target: string; operation?: { tool: string; args: unknown } }): Promise<ApprovalFacts>
  /** The connected apps this session may reach, out of those its scope already allows. */
  connections?(input: { sessionId: string; runId: string | null; caller: CallerContext; connectionIds: string[] }): Promise<string[]>
}
