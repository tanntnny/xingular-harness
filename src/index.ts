// @xingular/harness: a Pi agent harness. Multi-account Pi sessions, a compiled system prompt
// with stable-prefix delivery, a memory lifecycle (Wiki, blocks, facts, recall, sleep-time
// consolidation), tools with a gate and standing approvals, connected apps over MCP, and
// skills (a person's own and built-in).
//
// An application embeds it with `createHarness` and extends it through prompt sections, tool
// providers, a tool policy, a secret store, and a directory of its own names. Everything else
// is reachable by path, e.g. `@xingular/harness/memory/wiki`.
export { createHarness, Harness, type HarnessOptions, type Recovery } from './harness'

export { Bus, log, type Notice } from './core/bus'
export { EMPTY_DIRECTORY, type Directory, type HarnessEnv } from './core/env'
export { HarnessError, invalid, notFound, toErrorShape, type ErrorShape } from './core/errors'
export { findBinary, searchPath } from './core/path'

export { fileSecretStore, memorySecretStore, secretKey, type SecretStore } from './accounts/secrets'
export type { Account, AccountsOverview, Pool } from './accounts/store'
export type { ModelOption } from './accounts/accounts'

export type { CallerContext } from './memory/caller'
export { dispatch as memoryCall } from './memory/dispatch'

export {
  compile,
  render,
  SECTION_ORDER,
  CONTEXT_MESSAGE_TYPE,
  CONTEXT_SNAPSHOT_KEY,
  type ContextPack,
  type ContextProfile,
  type HostSection,
  type HostToolGroup,
  type Launch,
  type Reference,
  type Section
} from './prompt/compile'

export { runEventSchema, runRecordSchema, isActiveStatus, type RunEvent, type RunEventType, type RunRecord } from './sessions/contracts'
export type { ApprovalFacts, ApprovalPolicy, AutomaticReason } from './sessions/approvals'
export type { ScopeDecision, ToolCall, ToolPolicy } from './sessions/policy'
export type { ActiveRun, ApprovalDecision, ApprovalInput, QuestionAnswer, QuestionInput } from './sessions/registry'
export type { RunFields, SessionRunInput } from './sessions/sessions'
export type { Effort } from './sessions/runner'

export { describeTool, WIKI_TOOLS, WIKI_TOOL_NAMES, type WikiCall, type WikiToolDefinition } from './tools/definitions'
export type { ToolProvider, ToolResult, ToolSession, ToolSpec } from './tools/types'

export type { BrokeredTools, BrokerSession, BrokerTool } from './mcp/service'
export type { Connection, ConnectionInput } from './mcp/types'

export { configureBuiltins, type RegistryItem, type RegistryState } from './skills/registry'

export type { TerminalAssets, TerminalLaunch, TerminalPrepareInput } from './terminal/terminals'

export { methods } from './server/methods'
export { remoteDirectory, remotePolicy, remoteSecrets, remoteTools } from './server/remote'
export { PROTOCOL_VERSION, RpcPeer, stdioTransport, type Handler, type Transport } from './server/rpc'
export { attach, serve, type Served } from './server/serve'
