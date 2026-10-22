// Run records and the run-event stream: the one contract every session shares. Every event is
// validated against these schemas before it is persisted or handed to a listener.
import { z } from 'zod'

export const runStatusSchema = z.enum(['queued', 'running', 'waiting_for_approval', 'waiting_for_input', 'interrupted', 'completed', 'failed'])
export type RunStatus = z.infer<typeof runStatusSchema>

export const runEventTypeSchema = z.enum([
  'started',
  'context.snapshot',
  'message.delta',
  'message.completed',
  'message.steered',
  'tool.started',
  'tool.completed',
  'retry.started',
  'retry.ended',
  'compaction.started',
  'compaction.ended',
  'approval.requested',
  'approval.resolved',
  'question.requested',
  'question.answered',
  'extension.notice',
  'reaction.added',
  'agent.message',
  'checklist.updated',
  'artifact.added',
  'file.changed',
  'usage.updated',
  'account.status',
  'status.changed',
  'failed',
  'completed'
])
export type RunEventType = z.infer<typeof runEventTypeSchema>

const messageDeltaPayload = z.object({ messageId: z.string(), text: z.string() })
const messageCompletedPayload = z.object({ messageId: z.string(), role: z.enum(['user', 'assistant']), text: z.string() })
/** A message the person sent into the run while it was going; the model reads it from its next request on. */
const messageSteeredPayload = z.object({ text: z.string() })
const contextSnapshotPayload = z.object({
  systemPrompt: z.string().max(100_000),
  contextUpdate: z.string().max(100_000).optional(),
  tools: z.array(z.object({ name: z.string(), description: z.string().max(2_000), parameters: z.unknown() })).max(120),
  systemPromptTruncated: z.boolean().optional(),
  contextUpdateTruncated: z.boolean().optional(),
  toolsTruncated: z.boolean().optional()
})
/** Generic reference to content a provider stores outside the run-event stream. */
export const toolAttachmentRefSchema = z.object({
  id: z.string().min(1).max(300),
  name: z.string().min(1).max(500),
  mimeType: z.string().min(1).max(100)
}).strict()
export const toolAttachmentRefsSchema = z.array(toolAttachmentRefSchema).max(16)
export type ToolAttachmentRef = z.infer<typeof toolAttachmentRefSchema>

const toolPayload = z.object({
  toolCallId: z.string(),
  name: z.string(),
  summary: z.string().max(200).optional(),
  input: z.string().max(24_000).optional(),
  inputTruncated: z.boolean().optional(),
  output: z.string().max(24_000).optional(),
  outputTruncated: z.boolean().optional(),
  ok: z.boolean().optional(),
  /** On `tool.completed`: how long the call ran, and the size of what it returned to the model. */
  durationMs: z.number().optional(),
  resultChars: z.number().optional(),
  /** Opaque attachment references. Content stays outside the run event stream. */
  attachments: toolAttachmentRefsSchema.optional()
})
const retryStartedPayload = z.object({ attempt: z.number(), maxAttempts: z.number(), delayMs: z.number(), error: z.string().max(1_000).optional() })
const retryEndedPayload = z.object({ attempt: z.number(), success: z.boolean(), error: z.string().max(1_000).optional() })
const compactionStartedPayload = z.object({ reason: z.string() })
const compactionEndedPayload = z.object({
  reason: z.string(),
  aborted: z.boolean(),
  willRetry: z.boolean().optional(),
  error: z.string().max(1_000).optional(),
  tokensBefore: z.number().optional(),
  tokensAfter: z.number().optional(),
  summary: z.string().max(24_000).optional(),
  summaryTruncated: z.boolean().optional()
})
/** Granted without asking: the standing switch, a remembered tool, or the embedding application's own scope. */
const approvalAutomaticSchema = z.enum(['always', 'remembered', 'scope'])
const approvalRequestedPayload = z.object({
  approvalId: z.string(),
  target: z.string(),
  action: z.string(),
  screenshotRef: z.string().optional(),
  operation: z.object({ tool: z.string(), args: z.unknown() }).optional(),
  /** A tool the user may choose to always allow for this session. */
  rememberable: z.boolean().optional(),
  /** Set when the request was granted as it was made, so nobody is waiting on it. */
  automatic: approvalAutomaticSchema.optional()
})
const approvalResolvedPayload = z.object({ approvalId: z.string(), decision: z.enum(['approved', 'denied', 'native']), automatic: approvalAutomaticSchema.optional() })
export const questionOptionSchema = z.object({ label: z.string().min(1), description: z.string().optional(), recommended: z.boolean().optional() })
export type QuestionOption = z.infer<typeof questionOptionSchema>
const questionBatchFields = {
  batchId: z.string().min(1).optional(),
  batchIndex: z.number().int().min(1).max(5).optional(),
  batchCount: z.number().int().min(1).max(5).optional()
}
const questionBatchRefinement = <T extends { batchId?: string; batchIndex?: number; batchCount?: number }>(value: T, context: z.RefinementCtx): void => {
  const fields = [value.batchId, value.batchIndex, value.batchCount]
  if (fields.some((field) => field !== undefined) && fields.some((field) => field === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Question batch fields must be supplied together.' })
  }
  if (value.batchIndex !== undefined && value.batchCount !== undefined && value.batchIndex > value.batchCount) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Question batch index cannot exceed its count.' })
  }
}
const questionRequestedPayload = z.object({
  questionId: z.string(),
  question: z.string().min(1),
  summary: z.string().min(1).max(100).optional(),
  options: z.array(questionOptionSchema),
  multiSelect: z.boolean(),
  allowText: z.boolean(),
  userOnly: z.boolean().optional(),
  ...questionBatchFields
}).superRefine(questionBatchRefinement)
const questionAnsweredPayload = z.object({
  questionId: z.string(),
  selected: z.array(z.string()),
  text: z.string().optional(),
  notes: z.record(z.string(), z.string().max(10_000)).optional(),
  ...questionBatchFields
}).superRefine(questionBatchRefinement)
/** A short emoji sequence, never words or numbers. */
const reactionAddedPayload = z.object({ emoji: z.string().min(1).refine((text) => Buffer.byteLength(text) <= 16 && !/[A-Za-z0-9\s]/.test(text)) })
/** A message this run's agent sent to (`to`) or received back from (`from`) another agent. */
const agentMessagePayload = z.object({ direction: z.enum(['to', 'from']), agentId: z.string(), agentName: z.string(), text: z.string() })
/** A status line, a notification or an error from a Pi extension loaded in the session. */
const extensionNoticePayload = z.object({
  kind: z.enum(['notify', 'status', 'widget', 'title', 'error']),
  level: z.enum(['info', 'warning', 'error']).optional(),
  key: z.string().optional(),
  text: z.string(),
  extension: z.string().optional()
})
/** One line of the run's checklist. The list has no ids: every update replaces all of it. */
export const checklistItemSchema = z.object({ text: z.string().min(1).max(500), status: z.enum(['pending', 'in_progress', 'completed']) }).strict()
export type ChecklistItem = z.infer<typeof checklistItemSchema>
export const MAX_CHECKLIST_ITEMS = 50
/** The whole checklist as the model last wrote it; the latest event replaces every earlier one. */
const checklistPayload = z.object({ items: z.array(checklistItemSchema).max(MAX_CHECKLIST_ITEMS) }).strict()
const artifactPayload = z.object({ artifactId: z.string(), name: z.string(), file: z.unknown().optional() })
const fileChangedPayload = z.object({ path: z.string(), change: z.enum(['added', 'modified', 'deleted']) })
/** Where a cost figure comes from: Pi reported it, or the tokens were priced at list rates. */
export const costSourceSchema = z.enum(['harness', 'estimate', 'mixed'])
export type CostSource = z.infer<typeof costSourceSchema>
/** What one model request used. Token fields mean the same as on the run's totals. */
export const usageRequestSchema = z.object({
  /** Position in the run, from 1. */
  index: z.number(),
  responseId: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  inputTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  cacheWriteTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  reasoningTokens: z.number().optional(),
  costUsd: z.number().optional(),
  costSource: z.enum(['harness', 'estimate']).optional(),
  /** Separate provider-supplied summary; never generic private thinking content. */
  reasoningSummary: z.string().max(4_000).optional(),
  /** From sending the request to the end of the response, and to its first output. */
  durationMs: z.number().optional(),
  ttftMs: z.number().optional(),
  stopReason: z.string().optional()
})
export type UsageRequest = z.infer<typeof usageRequestSchema>
/** Token totals so far in this run (cumulative for the run, not the native session). */
export const usagePayloadSchema = z.object({
  /** Input tokens that were not read from the provider's cache. */
  inputTokens: z.number().optional(),
  /** Includes reasoning tokens. */
  outputTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  cacheWriteTokens: z.number().optional(),
  reasoningTokens: z.number().optional(),
  costUsd: z.number().optional(),
  costSource: costSourceSchema.optional(),
  /** Model requests made so far. */
  requests: z.number().optional(),
  /** Size of the latest request (not cumulative), and the model's limit. */
  contextTokens: z.number().optional(),
  contextWindow: z.number().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  /** The request this update reports. */
  request: usageRequestSchema.optional()
})
export type UsagePayload = z.infer<typeof usagePayloadSchema>
export const accountIssueCategorySchema = z.enum(['auth_expired', 'rate_limited', 'quota', 'network', 'unknown'])
export type AccountIssueCategory = z.infer<typeof accountIssueCategorySchema>
export const accountLimitSchema = z.object({
  id: z.string(),
  label: z.string(),
  usedPercent: z.number().nullable().optional(),
  resetsAt: z.string().nullable().optional(),
  windowMinutes: z.number().nullable().optional(),
  status: z.string().nullable().optional()
})
export type AccountLimit = z.infer<typeof accountLimitSchema>
/** Limit snapshots, plan changes, and classified account failures. */
const accountStatusPayload = z.object({
  accountId: z.string(),
  category: accountIssueCategorySchema.optional(),
  message: z.string().optional(),
  resetsAt: z.string().optional(),
  plan: z.string().optional(),
  limits: z.array(accountLimitSchema).optional()
})
const statusPayload = z.object({ status: runStatusSchema, reason: z.string().optional() })
const failedPayload = z.object({ code: z.string(), message: z.string() })
const emptyPayload = z.object({}).passthrough()

/** Payload schema per discriminant. */
export const runEventPayloadSchemas = {
  started: emptyPayload,
  'context.snapshot': contextSnapshotPayload,
  'message.delta': messageDeltaPayload,
  'message.completed': messageCompletedPayload,
  'message.steered': messageSteeredPayload,
  'tool.started': toolPayload,
  'tool.completed': toolPayload,
  'retry.started': retryStartedPayload,
  'retry.ended': retryEndedPayload,
  'compaction.started': compactionStartedPayload,
  'compaction.ended': compactionEndedPayload,
  'approval.requested': approvalRequestedPayload,
  'approval.resolved': approvalResolvedPayload,
  'question.requested': questionRequestedPayload,
  'question.answered': questionAnsweredPayload,
  'extension.notice': extensionNoticePayload,
  'reaction.added': reactionAddedPayload,
  'agent.message': agentMessagePayload,
  'checklist.updated': checklistPayload,
  'artifact.added': artifactPayload,
  'file.changed': fileChangedPayload,
  'usage.updated': usagePayloadSchema,
  'account.status': accountStatusPayload,
  'status.changed': statusPayload,
  failed: failedPayload,
  completed: emptyPayload
} satisfies Record<RunEventType, z.ZodType>

export const runEventSchema = z
  .object({
    id: z.string(),
    runId: z.string(),
    sessionId: z.string(),
    sequence: z.number().int().nonnegative(),
    timestamp: z.string(),
    type: runEventTypeSchema,
    payload: z.unknown(),
    /** The native event this one was derived from, kept as evidence. */
    native: z.unknown().optional(),
    /** Set when consecutive text deltas were merged for relay; covers sequences coalescedFrom..sequence. */
    coalescedFrom: z.number().int().nonnegative().optional()
  })
  .superRefine((event, context) => {
    if (!runEventPayloadSchemas[event.type].safeParse(event.payload).success) {
      context.addIssue({ code: 'custom', path: ['payload'], message: `Invalid payload for ${event.type}` })
    }
  })
export type RunEvent = z.infer<typeof runEventSchema>

/**
 * One tracked execution interval of a session. `mode`, `harness`, `sessionType`, `worktreeId`,
 * `attachmentCount`, `exitCode`, `handoffId` and `trigger` belong to the embedding application:
 * the harness stores and returns them, and reads only `mode` (`chat` is an agent's own
 * conversation, `code` is a session in a project).
 */
export interface RunRecord {
  resumedFromRunId: string | null
  /** Opaque run lineage supplied by the embedding application. */
  parentRunId: string | null
  relation: string | null
  terminalReason: string | null
  id: string
  projectId: string | null
  mode: string
  harness: string
  sessionType: string
  sessionId: string
  nativeSessionId: string | null
  workingDirectory: string | null
  worktreeId: string | null
  goal: string | null
  attachmentCount: number
  startedAt: string
  endedAt: string | null
  status: string
  exitCode: number | null
  handoffId: string | null
  /** The account the run used. */
  accountId: string | null
  /** The agent that replied. */
  agentId: string | null
  /** What started the run. */
  trigger: string | null
  /** The harness tree the run used: its scope and version fingerprint. */
  harnessScope?: string | null
  harnessVersion?: string | null
}

const text = z.string().nullish().transform((value) => value ?? null)

export const runRecordSchema = z.object({
  resumedFromRunId: text,
  parentRunId: text,
  relation: text,
  terminalReason: text,
  id: z.string(),
  projectId: text,
  mode: z.string(),
  harness: z.string(),
  sessionType: z.string(),
  sessionId: z.string(),
  nativeSessionId: text,
  workingDirectory: text,
  worktreeId: text,
  goal: text,
  attachmentCount: z.number().int().nonnegative().default(0),
  startedAt: z.string(),
  endedAt: text,
  status: z.string(),
  exitCode: z.number().int().nullish().transform((value) => value ?? null),
  handoffId: text,
  accountId: text,
  agentId: text,
  trigger: text,
  harnessScope: text.optional(),
  harnessVersion: text.optional()
}) satisfies z.ZodType<RunRecord, unknown>

export const ACTIVE_STATUSES: readonly string[] = ['queued', 'running', 'waiting_for_approval', 'waiting_for_input']

export function isActiveStatus(status: string): boolean {
  return ACTIVE_STATUSES.includes(status)
}
