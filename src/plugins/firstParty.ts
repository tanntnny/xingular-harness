// Plugins that ship with the harness and are off until a person switches them on. Each is a Pi
// extension, written against the same API anyone's plugin uses. They are loaded as inline
// extensions, so they also run in unattended work, where nothing on disk is loaded, and they
// need no trust: they are the harness's own code.
//
// Both act on one run: a session is opened for each request a person or the application makes,
// so what they count starts at zero each time.
import type { PluginDescriptor, PluginSetting } from './types'

/** The part of Pi's extension API these two use. */
interface Api {
  on(event: 'tool_result', handler: (event: ToolResult) => unknown): void
  on(event: 'tool_call', handler: (event: { toolName: string }) => unknown): void
  on(event: 'turn_start', handler: () => unknown): void
  on(event: 'message_end', handler: (event: { message: { role: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } } }) => unknown): void
}

interface ToolResult {
  toolName: string
  content: ({ type: 'text'; text: string } | { type: string; [key: string]: unknown })[]
}

export const OUTPUT_TRIM = 'output-trim'
export const BUDGET_GUARD = 'budget-guard'
export const LESSONS = 'lessons'
export const LESSONS_CODE = 'Reflect after a run'

const OUTPUT_TRIM_SETTINGS: PluginSetting[] = [
  { key: 'maxChars', label: 'Longest tool result', description: 'A tool result longer than this many characters is cut to its beginning and its end.', default: 20_000, min: 2_000, max: 400_000 }
]

const BUDGET_GUARD_SETTINGS: PluginSetting[] = [
  { key: 'maxRequests', label: 'Model requests in one reply', description: 'After this many model requests in one reply or one run of work, tool calls are refused so the agent wraps up.', default: 60, min: 5, max: 2_000 },
  { key: 'maxTokens', label: 'Tokens in one reply', description: 'The same, counted in tokens of every kind (cached ones included). 0 means no token limit.', default: 0, min: 0, max: 500_000_000 }
]

export const LESSONS_SETTINGS: PluginSetting[] = [
  { key: 'minToolCalls', label: 'Tool calls before reflecting', description: 'Only a run that made at least this many tool calls is reflected on; shorter runs rarely teach anything.', default: 4, min: 1, max: 1_000 },
  { key: 'maxLessons', label: 'Most lessons kept', description: 'Once the Wiki holds this many lessons, no new one is written until some are removed.', default: 100, min: 1, max: 1_000 },
  { key: 'maxChars', label: 'Longest lesson', description: 'A lesson longer than this many characters is not kept.', default: 2_000, min: 200, max: 10_000 }
]

export const FIRST_PARTY_PLUGINS: readonly PluginDescriptor[] = [
  {
    id: OUTPUT_TRIM,
    title: 'Output trim',
    description: 'Cuts a very long tool result to its beginning and its end before the model reads it, and says how much was cut.',
    switchable: { on: false },
    settings: OUTPUT_TRIM_SETTINGS,
    code: [{ name: 'Trim long tool results', description: 'Runs after every tool call, in conversations, task threads and unattended work. Not in terminal sessions yet.' }]
  },
  {
    id: BUDGET_GUARD,
    title: 'Budget guard',
    description: 'Stops a reply that keeps going: past a limit of model requests or tokens, further tool calls are refused and the agent is told to wrap up.',
    switchable: { on: false },
    settings: BUDGET_GUARD_SETTINGS,
    code: [{ name: 'Refuse tool calls past the limit', description: 'Counts model requests and tokens in one reply, in conversations, task threads and unattended work. Not in terminal sessions yet.' }]
  },
  {
    id: LESSONS,
    title: 'Lessons',
    description: 'After a finished run, a short reflection reads what happened and may keep one general lesson in the Wiki under library/lessons, for later runs to find. It uses the same account and model as the run, so it costs tokens.',
    switchable: { on: false },
    settings: LESSONS_SETTINGS,
    code: [{ name: LESSONS_CODE, description: 'Runs in the background after a completed top-level run with enough tool calls. It reads only that run\'s record, has no tools that change anything, and writes at most one Wiki note.' }]
  }
]

/** A setting's value: what a person saved when it is a number inside the setting's range, else its default. */
export function settingValue(setting: PluginSetting, saved: Record<string, unknown> | undefined): number {
  const value = saved?.[setting.key]
  return typeof value === 'number' && Number.isFinite(value) && value >= setting.min && value <= setting.max ? Math.floor(value) : setting.default
}

const values = (settings: readonly PluginSetting[], saved: Record<string, unknown> | undefined): Record<string, number> => Object.fromEntries(settings.map((setting) => [setting.key, settingValue(setting, saved)]))

/** The text of a long result, cut to its first 70% and its last 30% of `maxChars`, with a line between that says what is missing. */
export function trimText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const head = Math.floor(maxChars * 0.7)
  const tail = maxChars - head
  const cut = text.length - maxChars
  return `${text.slice(0, head)}\n\n[… ${cut} of ${text.length} characters were cut here by the Output trim plugin. Ask for a narrower result (a line range, a filter, a smaller file) to see them. …]\n\n${text.slice(text.length - tail)}`
}

export function outputTrim(saved: Record<string, unknown> | undefined): (pi: Api) => void {
  const { maxChars } = values(OUTPUT_TRIM_SETTINGS, saved)
  return (pi) => {
    pi.on('tool_result', (event) => {
      const texts = event.content.filter((part): part is { type: 'text'; text: string } => part.type === 'text' && typeof (part as { text?: unknown }).text === 'string')
      const total = texts.reduce((sum, part) => sum + part.text.length, 0)
      if (total <= maxChars) return undefined
      // Several text parts are read as one result; pictures and anything else pass through untouched.
      const trimmed = trimText(texts.map((part) => part.text).join('\n'), maxChars)
      return { content: [{ type: 'text', text: trimmed }, ...event.content.filter((part) => part.type !== 'text')] }
    })
  }
}

export function budgetGuard(saved: Record<string, unknown> | undefined): (pi: Api) => void {
  const { maxRequests, maxTokens } = values(BUDGET_GUARD_SETTINGS, saved)
  return (pi) => {
    let requests = 0
    let tokens = 0
    let refusedInRequest = 0
    pi.on('turn_start', () => {
      requests += 1
    })
    pi.on('message_end', (event) => {
      if (event.message.role !== 'assistant' || !event.message.usage) return
      const usage = event.message.usage
      tokens += (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
    })
    // Pi's own event before a request can change what is sent and cannot refuse it, so the limit
    // is held where the loop can be stopped: at the tool calls that keep it going.
    pi.on('tool_call', () => {
      const over = requests >= maxRequests ? `${maxRequests} model requests` : maxTokens > 0 && tokens >= maxTokens ? `${maxTokens} tokens` : null
      if (!over) return undefined
      // The first refusal leaves the agent one request to say what is done. If it calls tools
      // again instead, the batch ends the reply.
      const again = refusedInRequest !== 0 && refusedInRequest !== requests
      refusedInRequest ||= requests
      return {
        block: true,
        terminate: again,
        reason: `This reply reached its limit of ${over} (the Budget guard plugin). Call no more tools. Tell the user what is done and what is left; they can raise the limit on the Plugins page.`
      }
    })
  }
}

export interface InlineExtension {
  name: string
  /** A Pi extension factory. Typed loosely so this module needs nothing of Pi's to be loaded. */
  factory: unknown
}

/** The first-party extensions switched on for a caller, each with the settings a person saved. */
export function firstPartyExtensions(on: (pluginId: string) => boolean, settings: Record<string, Record<string, unknown>>): InlineExtension[] {
  const extensions: InlineExtension[] = []
  if (on(OUTPUT_TRIM)) extensions.push({ name: OUTPUT_TRIM, factory: outputTrim(settings[OUTPUT_TRIM]) })
  if (on(BUDGET_GUARD)) extensions.push({ name: BUDGET_GUARD, factory: budgetGuard(settings[BUDGET_GUARD]) })
  return extensions
}
