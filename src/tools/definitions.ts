// The memory and Wiki tools a session gets, defined once. An SDK session gets them as Pi tools;
// a terminal session gets them from the `agentx-wiki` command or the bundled MCP server. All of
// them reach the same calls.

export type WikiCall =
  | 'memory.append' | 'memory.replace' | 'memory.rethink'
  | 'recall.search' | 'recall.read'
  | 'wiki.entrypoint' | 'wiki.search' | 'wiki.read' | 'wiki.list' | 'wiki.skill' | 'wiki.memory' | 'wiki.propose'

/** A JSON Schema object, kept loose so TypeBox, MCP, and the CLI can all use it. */
export type JsonSchema = { type: string; properties?: Record<string, unknown>; required?: string[]; [key: string]: unknown }

export interface WikiToolDefinition {
  name: string
  call: WikiCall
  label: string
  description: string
  parameters: JsonSchema
  /** The compiled prompt is injected at launch; the tool exists for sessions that need it again. */
  bootstrap?: boolean
}

/** The kinds of entry a model names. A fact was called `memory` before; that word is still accepted. */
export const WIKI_ENTRY_KINDS = ['page', 'fact', 'block', 'skill', 'rule', 'prompt'] as const
export const WIKI_PAGE_TYPES = ['project', 'person', 'concept', 'decision', 'summary', 'question', 'reference'] as const
export const WIKI_MEMORY_KINDS = ['preference', 'fact', 'decision', 'feedback'] as const
export const WIKI_LINK_TYPES = ['references', 'depends_on', 'supersedes', 'contradicts', 'produced_by', 'uses'] as const

const text = (description: string) => ({ type: 'string', description })
const block = text('The block\'s label as shown in your memory blocks: user, persona, notes, project/<slug>, or a shared block\'s label')

/** Core memory: the blocks that are always in the caller's context. */
export const MEMORY_TOOLS: WikiToolDefinition[] = [
  {
    name: 'memory_append',
    call: 'memory.append',
    label: 'Add to memory',
    description:
      'Add a line or short passage to the end of one of your memory blocks. Use it when you learn something worth keeping across conversations: about the user, about how you work, or about a project. The change is saved at once and the user can undo it.',
    parameters: { type: 'object', properties: { block, text: text('What to add') }, required: ['block', 'text'] }
  },
  {
    name: 'memory_replace',
    call: 'memory.replace',
    label: 'Correct memory',
    description: 'Replace one exact passage in a memory block, to correct or remove something that is no longer true. Copy the old passage exactly; pass an empty new passage to delete it.',
    parameters: { type: 'object', properties: { block, old: text('The exact passage to replace'), new: text('What replaces it') }, required: ['block', 'old', 'new'] }
  },
  {
    name: 'memory_rethink',
    call: 'memory.rethink',
    label: 'Rewrite memory',
    description: 'Rewrite a whole memory block, to condense it when it is close to its limit or has grown repetitive. Keep everything that is still true and useful.',
    parameters: { type: 'object', properties: { block, body: text('The complete new content of the block') }, required: ['block', 'body'] }
  }
]

/** History: what was said and done in earlier conversations and runs. */
export const RECALL_TOOLS: WikiToolDefinition[] = [
  {
    name: 'history_search',
    call: 'recall.search',
    label: 'Search history',
    description:
      'Search what was said and done before: your earlier conversations (including a chat the user cleared), tool use, and Harness runs. Any word may match; the best matches come first. An agent searches its own conversations unless scope is "all" or a project is given. A Harness session searches Harness runs in its own project.',
    parameters: {
      type: 'object',
      properties: {
        query: text('Words to look for'),
        scope: { type: 'string', enum: ['mine', 'all'], description: 'mine (default): your own conversations. all: every conversation and Harness run.' },
        project: text('Only Harness runs in this project (its name or slug)'),
        since: text('Only from this date on, as YYYY-MM-DD'),
        limit: { type: 'integer', minimum: 1, maximum: 30 }
      },
      required: ['query']
    }
  },
  {
    name: 'history_read',
    call: 'recall.read',
    label: 'Read a run',
    description: 'Read one earlier run in order: the request, the replies, and the tools used. Pass a run id from history_search.',
    parameters: { type: 'object', properties: { run: text('Run id') }, required: ['run'] }
  }
]

export const WIKI_TOOLS: WikiToolDefinition[] = [
  ...MEMORY_TOOLS,
  ...RECALL_TOOLS,
  {
    name: 'wiki_entrypoint',
    call: 'wiki.entrypoint',
    label: 'Context pack',
    description: 'Your {product} context pack again: memory blocks, rules, the skills index, the project map, and tool guidance. It is already in your instructions at the start; call this to see its current state.',
    parameters: { type: 'object', properties: {} },
    bootstrap: true
  },
  {
    name: 'wiki_search',
    call: 'wiki.search',
    label: 'Search Wiki',
    description:
      'Search everything written down in {product}: the Library, every project namespace, facts, skills, rules, and prompts. Results from the current project rank higher. Each hit has a path and an [id@revision] citation.',
    parameters: {
      type: 'object',
      properties: {
        query: text('What to look for'),
        kinds: { type: 'array', items: { type: 'string', enum: [...WIKI_ENTRY_KINDS] }, description: 'Only these kinds of entries' },
        namespace: text('Only this namespace, such as /library or /projects/<name>'),
        limit: { type: 'integer', minimum: 1, maximum: 50 }
      },
      required: ['query']
    }
  },
  {
    name: 'wiki_read',
    call: 'wiki.read',
    label: 'Read Wiki entry',
    description: 'Read one Wiki page, fact, skill, rule, or prompt in full, with its sources, links, and backlinks. Pass an id (arch, skills/review) or a Wiki path (/projects/agent-x/arch).',
    parameters: { type: 'object', properties: { id: text('Entry id or Wiki path'), revision: text('Optional pinned revision selected for this reply'), offset: { type: 'integer', minimum: 0, description: 'Character offset when reading a pinned revision; use nextOffset to continue.' } }, required: ['id'] }
  },
  {
    name: 'wiki_list',
    call: 'wiki.list',
    label: 'List Wiki',
    description: 'List Wiki namespaces and pages (optionally in one namespace), or all facts, skills, rules, or prompts.',
    parameters: {
      type: 'object',
      properties: { namespace: text('A namespace such as /library or /projects/<name>'), kind: { type: 'string', enum: [...WIKI_ENTRY_KINDS] } }
    }
  },
  {
    name: 'skill_load',
    call: 'wiki.skill',
    label: 'Load skill',
    description: "Load a skill's instructions by name, or list every skill (and which are active) when no name is given. Follow a skill's steps when the task matches it.",
    parameters: { type: 'object', properties: { name: text('Skill name or id, such as review or skills/review') } }
  },
  {
    name: 'memory_facts',
    call: 'wiki.memory',
    label: 'Recall facts',
    description: 'Recall facts: short statements, preferences, decisions, and feedback. Without a query it returns the facts that apply to the current project.',
    parameters: { type: 'object', properties: { query: text('What to recall'), namespace: text('/ or a project namespace') } }
  },
  {
    name: 'wiki_propose',
    call: 'wiki.propose',
    label: 'Propose Wiki update',
    description:
      'Record durable knowledge. kind "fact" for a short fact, preference, decision, or piece of feedback, "page" to update an existing page or add one about an entity or concept (not about one run), or "skill"/"rule"/"prompt" to suggest a change to those. ' +
      'Cite evidence in sourceRefs: {"kind":"run","ref":"current","excerpt":"…"} with a passage copied exactly from this conversation or run (what the user wrote, or what you already said), a source id, or a URL. ' +
      'A run reference without an excerpt found in the run is not evidence. Cited pages and facts apply right away (with undo); uncited or low-confidence ones, and every skill, rule, or prompt change, wait in the Wiki Inbox for the user. Never include secrets.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: [...WIKI_ENTRY_KINDS] },
        title: text('Title (or the skill/rule/prompt name)'),
        body: text('Markdown body. For a fact, a few lines.'),
        id: text('Existing id to update'),
        type: text(`Page type (${WIKI_PAGE_TYPES.join(', ')}) or what sort of fact (${WIKI_MEMORY_KINDS.join(', ')})`),
        namespace: text('Where it belongs: /library, /projects/<name>, or / for a fact that applies everywhere. Defaults to the current project.'),
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        description: text('One line for a skill, rule, or prompt'),
        supersedes: text('Id of a fact this one replaces'),
        volatile: { type: 'boolean', description: 'For a fact: true when it describes current state that will change (an open issue list, who is on call)' },
        reason: text('Why this change is needed (skills, rules, prompts)'),
        sourceRefs: {
          type: 'array',
          items: { type: 'object', properties: { kind: { type: 'string', enum: ['run', 'source', 'url'] }, ref: { type: 'string' }, excerpt: { type: 'string', description: 'For a run or source: a passage copied exactly from it' } }, required: ['kind'] }
        },
        links: {
          type: 'array',
          items: { type: 'object', properties: { toId: { type: 'string' }, type: { type: 'string', enum: [...WIKI_LINK_TYPES] } }, required: ['toId', 'type'] }
        }
      },
      required: ['kind', 'title', 'body']
    }
  }
]

/** Tools agents get when the context pack is already in their instructions. */
/** A tool's description with the application's name in it. */
export const describeTool = (tool: WikiToolDefinition, productName: string): string => tool.description.replaceAll('{product}', productName)

export const WIKI_AGENT_TOOLS = WIKI_TOOLS.filter((tool) => !tool.bootstrap)
export const WIKI_TOOL_NAMES = WIKI_AGENT_TOOLS.map((tool) => tool.name)
