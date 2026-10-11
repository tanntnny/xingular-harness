// Sleep-time consolidation: a Pi session that reads new evidence (an imported source or a
// settled run) or a set of full memory blocks, and proposes changes. It has no file or shell
// tools, only proposal tools, so every change goes back to the proposal check, which looks each
// quoted excerpt up in the evidence before anything is written.
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'

import type { AccountContext } from '../accounts/env'
import { HarnessError } from '../core/errors'
import { MEMORY_KINDS } from './facts'
import { LINK_TYPES, PAGE_TYPES } from './store'

export interface ExistingPage {
  id: string
  title: string
  type: string
  path?: string
  summary: string
  /** The page's current text, for the few pages closest to the evidence. */
  body?: string
}

export interface ExistingMemory {
  id: string
  title: string
  kind: string
  namespace: string
  body: string
}

/** A memory block attached to the run, in full. */
export interface ExistingBlock {
  id: string
  label: string
  description: string
  limit: number
  body: string
}

export type MaintenanceTrigger = { kind: 'ingest'; sourceId: string; sourceName: string; text: string } | { kind: 'run'; runId: string; transcript: string } | { kind: 'consolidate' }

export interface MaintenanceRequest {
  jobId: string
  /** Where new pages go by default: /library or /projects/<slug>. */
  namespace: string
  trigger: MaintenanceTrigger
  pages: ExistingPage[]
  memories?: ExistingMemory[]
  blocks?: ExistingBlock[]
  namespaces?: { namespace: string; label: string }[]
  index: string
}

/** What the session proposed, as its tools received it. Nothing here has been checked yet. */
export interface MaintenanceResult {
  pages: unknown[]
  memories: unknown[]
  blocks: unknown[]
  flags: unknown[]
}

const EVIDENCE_RULE = `Every change must carry sourceRefs with an excerpt: a short passage (at least a few words) copied
exactly from the evidence. The host looks the excerpt up in the evidence and discards any change whose
excerpt it cannot find, so never paraphrase an excerpt and never cite something the evidence does not say.`

const runInstructions = (product: string): string => `You consolidate memory for ${product} after a run has finished ("sleep-time" work).
You are given the run's transcript, the memory blocks that were in its context, the facts that apply,
and related Wiki pages. Decide what is worth keeping for future work, then:
- rethink_block: rewrite a memory block when the run taught something that belongs in it (see each
  block's description). Give the complete new content, merged with what is already there. Remove
  what the run showed to be wrong or finished. Stay within the block's limit.
- propose_memory: record a short standing fact, preference, decision, or piece of feedback. Update
  an existing fact by id, or replace one with supersedes. Use low confidence when unsure.
- propose_page: update a page that ALREADY EXISTS, by its id, with its complete new body (merge with
  the current text shown to you; never drop established content unless the evidence supersedes it).
  You cannot create pages: one run is an episode, not a page. What a run merely observed (a tool
  result, a status, a list that will change) is not durable knowledge; leave it out.
- flag_claim: send an uncertain, contradictory, or sensitive claim to the review inbox instead.
${EVIDENCE_RULE}
Use {"kind":"run","ref":"<the run id>","excerpt":"…"}.
Skip small talk and transient details. Most runs need few changes; it is fine to change nothing.`

const ingestInstructions = (product: string): string => `You maintain ${product}'s global knowledge Wiki (Karpathy-style LLM Wiki).
Raw sources are immutable evidence; Wiki pages are durable, interlinked Markdown syntheses, one per
entity, concept, or decision, updated in place. The Wiki is one corpus: the Library (/library) and one
namespace per project (/projects/<name>). Facts are short typed statements.
Read the imported source and decide what durable knowledge it adds. Then:
- propose_page once per page to create or update. To update, pass the existing page id and the
  complete new body (merge with what the page already says; never drop established content unless
  the source supersedes it, and say so). Prefer updating an existing page over creating a near
  duplicate. New pages go to the job's namespace unless they clearly belong elsewhere.
- propose_memory for a short standing fact, preference, decision, or piece of feedback. Use namespace
  "/" when it applies everywhere.
- Link related pages with typed links (references, depends_on, supersedes, contradicts,
  produced_by, uses) using existing page ids or ids you propose.
- flag_claim for a claim that is uncertain, contradicts an existing page, or contains secrets or
  personal data that should not be stored.
${EVIDENCE_RULE}
Use {"kind":"source","ref":"<the source id>","excerpt":"…"}.
Prefer few, well-structured pages. Page ids are short kebab-case slugs. It is fine to propose nothing.`

const consolidateInstructions = (product: string): string => `You tidy ${product}'s memory blocks. Each block below is close to its
character limit. For each one, call rethink_block with a shorter version that keeps everything still
true and useful: merge repeats, drop what is finished or superseded, and tighten the wording. Do not
add anything that is not already in the block. The new content must be shorter than the current one.`

export function instructions(kind: MaintenanceTrigger['kind'], product: string): string {
  return kind === 'run' ? runInstructions(product) : kind === 'ingest' ? ingestInstructions(product) : consolidateInstructions(product)
}

/** The proposal tools each kind of job gets. */
export function toolNames(kind: MaintenanceTrigger['kind']): string[] {
  if (kind === 'consolidate') return ['rethink_block']
  if (kind === 'run') return ['rethink_block', 'propose_memory', 'propose_page', 'flag_claim']
  return ['propose_page', 'propose_memory', 'flag_claim']
}

export function prompt(request: MaintenanceRequest): string {
  const blocks = request.blocks?.length
    ? request.blocks.map((block) => `<block id="${block.id}" label="${block.label}" chars="${Array.from(block.body).length}/${block.limit}">\n${block.description}\n---\n${block.body.trim() || '(empty)'}\n</block>`).join('\n\n')
    : '(none)'
  if (request.trigger.kind === 'consolidate') return `Memory blocks to condense:\n\n${blocks}`
  const existing = request.pages.length ? request.pages.map((page) => `- ${page.id} (${page.type}${page.path ? `, ${page.path}` : ''}): ${page.title} — ${page.summary}`).join('\n') : '(no pages yet)'
  const bodies = request.pages.filter((page) => page.body?.trim()).map((page) => `<page id="${page.id}" title="${page.title}">\n${page.body}\n</page>`).join('\n\n')
  const memories = request.memories?.length ? request.memories.map((memory) => `- ${memory.id} [${memory.kind}, ${memory.namespace}] ${memory.title}: ${memory.body}`).join('\n') : '(none)'
  const namespaces = ['/library', ...(request.namespaces ?? []).map((namespace) => `${namespace.namespace} (${namespace.label})`)].join(', ')
  const evidence = request.trigger.kind === 'ingest' ? `Imported source ${request.trigger.sourceId} ("${request.trigger.sourceName}"):\n\n${request.trigger.text}` : `Settled run ${request.trigger.runId} transcript:\n\n${request.trigger.transcript}`
  return [
    `Namespace for this job: ${request.namespace}`,
    `Namespaces: ${namespaces}`,
    ...(request.trigger.kind === 'run' ? [`Memory blocks in this run's context:\n\n${blocks}`] : []),
    `Current index:\n${request.index}`,
    `Relevant pages:\n${existing}`,
    ...(bodies ? [`Current text of the closest pages:\n\n${bodies}`] : []),
    `Facts:\n${memories}`,
    `New evidence:\n${evidence}`
  ].join('\n\n')
}

export interface MaintainerSession {
  prompt(text: string): Promise<void>
  dispose(): void
  /** Assistant error text, if the provider failed. */
  error(): string | null
}

type Collector = { page: (proposal: unknown) => string; memory: (proposal: unknown) => string; block: (proposal: unknown) => string; flag: (flag: unknown) => string }

export type MaintainerFactory = (input: {
  cwd: string
  /** Which job this is; it decides the instructions and the tools. */
  kind: MaintenanceTrigger['kind']
  product: string
  account: AccountContext
  runtime: () => Promise<ModelRuntime>
  collect: Collector
}) => Promise<MaintainerSession>

export const piMaintainerFactory: MaintainerFactory = async ({ cwd, kind, product, account, runtime, collect }) => {
  const pi = await import('@earendil-works/pi-coding-agent')
  const { Type } = await import('typebox')
  const agentDir = account.configDir
  const resourceLoader = new pi.DefaultResourceLoader({ cwd, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, appendSystemPromptOverride: (base) => [...base, instructions(kind, product)] })
  await resourceLoader.reload()
  const sourceRefs = Type.Array(
    Type.Object({
      kind: Type.Union([Type.Literal('source'), Type.Literal('run'), Type.Literal('url')]),
      ref: Type.String(),
      excerpt: Type.Optional(Type.String({ description: 'A passage copied exactly from the evidence' }))
    })
  )
  const reply = (text: string) => ({ content: [{ type: 'text' as const, text }], details: {} })
  const tools = [
    pi.defineTool({
      name: 'rethink_block',
      label: 'Rewrite block',
      description: 'Rewrite one memory block with its complete new content. The host checks the excerpt and the block limit before anything is written.',
      parameters: Type.Object({ block: Type.String({ description: 'The block id, as given in <block id="…">' }), body: Type.String({ description: 'The complete new content of the block' }), sourceRefs: Type.Optional(sourceRefs) }),
      execute: async (_id, input) => reply(collect.block({ sourceRefs: [], ...(input as object) }))
    }),
    pi.defineTool({
      name: 'propose_page',
      label: 'Propose page',
      description: 'Create or update one Wiki page. The host validates it before anything is written.',
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: 'Existing page id to update, or a new kebab-case id' })),
        title: Type.String(),
        type: Type.Union(PAGE_TYPES.map((value) => Type.Literal(value))),
        body: Type.String({ description: 'Complete Markdown body' }),
        namespace: Type.Optional(Type.String({ description: 'For a new page: /library or /projects/<name>; defaults to the job namespace' })),
        sourceRefs,
        links: Type.Array(Type.Object({ toId: Type.String(), type: Type.Union(LINK_TYPES.map((value) => Type.Literal(value))) }))
      }),
      execute: async (_id, input) => reply(collect.page(input))
    }),
    pi.defineTool({
      name: 'propose_memory',
      label: 'Propose fact',
      description: 'Create or update one fact: a short standing statement agents can look up. The host validates it before anything is written.',
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: 'Existing fact id to update, or a new kebab-case id' })),
        title: Type.String(),
        kind: Type.Union(MEMORY_KINDS.map((value) => Type.Literal(value))),
        body: Type.String({ description: 'One to a few sentences' }),
        namespace: Type.Optional(Type.String({ description: '/ for everywhere, or /projects/<name>' })),
        confidence: Type.Optional(Type.Union([Type.Literal('high'), Type.Literal('medium'), Type.Literal('low')])),
        supersedes: Type.Optional(Type.String({ description: 'Id of the fact this replaces' })),
        sourceRefs
      }),
      execute: async (_id, input) => reply(collect.memory(input))
    }),
    pi.defineTool({
      name: 'flag_claim',
      label: 'Flag claim',
      description: 'Send an uncited, contradictory, uncertain, or sensitive claim to the review inbox instead of the Wiki.',
      parameters: Type.Object({ claim: Type.String(), kind: Type.Union([Type.Literal('uncited'), Type.Literal('contradiction'), Type.Literal('low_confidence'), Type.Literal('sensitive')]), reason: Type.String() }),
      execute: async (_id, input) => reply(collect.flag(input))
    })
  ]
  const allowed = toolNames(kind)
  const { session } = await pi.createAgentSession({
    cwd,
    agentDir,
    modelRuntime: await runtime(),
    tools: allowed,
    customTools: tools.filter((tool) => allowed.includes((tool as { name: string }).name)) as never,
    resourceLoader,
    sessionManager: pi.SessionManager.inMemory(cwd)
  })
  let lastError: string | null = null
  session.subscribe((event) => {
    if (event.type !== 'message_end') return
    const message = event.message as { role?: string; stopReason?: string; errorMessage?: string }
    if (message.role === 'assistant' && message.stopReason === 'error') lastError = message.errorMessage ?? 'Provider error'
  })
  return { prompt: (text) => session.prompt(text), dispose: () => session.dispose(), error: () => lastError }
}

/** Runs one job's session and returns what it proposed. Nothing is written here. */
export async function runMaintenance(request: MaintenanceRequest, input: Omit<Parameters<MaintainerFactory>[0], 'kind' | 'collect'>, factory: MaintainerFactory = piMaintainerFactory): Promise<MaintenanceResult> {
  const result: MaintenanceResult = { pages: [], memories: [], blocks: [], flags: [] }
  const titled = (proposal: unknown): string => String((proposal as { title?: unknown } | null)?.title ?? '')
  const session = await factory({
    ...input,
    kind: request.trigger.kind,
    collect: {
      page: (proposal) => {
        result.pages.push(proposal)
        return `Proposed "${titled(proposal)}". The host will validate it.`
      },
      memory: (proposal) => {
        result.memories.push(proposal)
        return `Proposed memory "${titled(proposal)}". The host will validate it.`
      },
      block: (proposal) => {
        result.blocks.push(proposal)
        return `Proposed a rewrite of ${String((proposal as { block?: unknown } | null)?.block ?? '')}. The host will validate it.`
      },
      flag: (flag) => {
        result.flags.push(flag)
        return 'Sent to the review inbox.'
      }
    }
  })
  try {
    await session.prompt(prompt(request))
    const error = session.error()
    if (error) throw new HarnessError('provider_error', error)
  } finally {
    session.dispose()
  }
  return result
}
