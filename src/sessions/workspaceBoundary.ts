import type { RunRecord } from './contracts'
import type { ScopeDecision } from './policy'
import { isWithinWorkspace, resolveWorkspaceRoot, resolveWritePath, verifyWorkspaceRoot } from '../core/workspace'

export const WORKSPACE_FILE_WRITE_TOOLS = new Set(['edit', 'write'])

export interface WorkspaceWriteInspection {
  input: unknown
  path: string | null
  outside: boolean
  reason: string | null
}

/** Canonicalize native file-write arguments and identify an explicit workspace escape. */
export function inspectWorkspaceWrite(
  workspaceRoot: string,
  cwd: string,
  tool: string,
  input: unknown
): WorkspaceWriteInspection {
  if (!WORKSPACE_FILE_WRITE_TOOLS.has(tool.toLowerCase()) || !input || typeof input !== 'object' || Array.isArray(input)) {
    return { input, path: null, outside: false, reason: null }
  }
  const args = input as Record<string, unknown>
  if (typeof args.path !== 'string') return { input, path: null, outside: false, reason: null }

  const root = verifyWorkspaceRoot(workspaceRoot)
  const path = resolveWritePath(args.path, cwd)
  const outside = !isWithinWorkspace(root, path)
  return {
    input: { ...args, path },
    path,
    outside,
    reason: outside ? `Write target ${path} is outside the active project workspace ${root}.` : null
  }
}

/** Adds the mandatory per-operation boundary without allowing it to waive host hard denials. */
export function combineWorkspaceScope(scope: ScopeDecision, inspection: WorkspaceWriteInspection): ScopeDecision {
  if (!inspection.outside) return scope
  if (!scope.allowed && (scope.automatic || !scope.requiresApproval)) return scope
  return {
    ...scope,
    allowed: false,
    requiresApproval: true,
    humanOnly: true,
    allowGlobalApproval: scope.humanOnly ? scope.allowGlobalApproval : true,
    reason: inspection.reason
  }
}

/** Resolve a root for pre-boundary run records, then inspect the write using the pinned directory. */
export function inspectRunWorkspaceWrite(run: RunRecord, tool: string, input: unknown): WorkspaceWriteInspection {
  const cwd = run.workingDirectory
  const root = run.workspaceRoot ?? (cwd ? resolveWorkspaceRoot(cwd) : null)
  if (!root || !cwd) {
    if (WORKSPACE_FILE_WRITE_TOOLS.has(tool.toLowerCase())) throw new Error('The active project workspace could not be resolved; file writes are blocked.')
    return { input, path: null, outside: false, reason: null }
  }
  return inspectWorkspaceWrite(root, cwd, tool, input)
}
