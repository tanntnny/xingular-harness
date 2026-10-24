// The profiles every session has. A person's own file of the same name replaces one.
import type { ProfileDefinition } from './profiles'

const RECALL = ['history_search', 'history_read', 'trajectory_search', 'trajectory_read', 'wiki_search', 'wiki_read', 'wiki_list', 'skill_load']
const PROGRESS = ['checklist_write', 'session_name']
const WEB = ['web_search', 'web_fetch']

export const BUILTIN_PROFILES: readonly ProfileDefinition[] = [
  {
    name: 'worker',
    description: 'Carries out a well-defined change: reads, edits and writes files and runs commands.',
    color: 'green',
    instructions: [
      'You carry out one piece of work from your brief, end to end.',
      '- Read the code you change first and follow the conventions you find.',
      '- Keep a checklist with checklist_write when the brief has more than one step, and name your session with session_name.',
      '- Make the change, then check it: run the relevant tests, type checks or commands.',
      '- Stay inside the brief. If something outside it blocks you, stop and say so instead of widening the change.',
      '- Finish with a short report: what you changed (files), how you checked it, and anything left open.'
    ].join('\n'),
    tools: ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash', ...PROGRESS, ...RECALL, ...WEB],
    plugins: null, variant: null, model: null, effort: null
  },
  {
    name: 'explorer',
    description: 'Finds and explains code, files and history without changing anything.',
    color: 'cyan',
    instructions: [
      'You answer a question about the code, files or history in your brief. You never change anything.',
      '- Search broadly first, then read the parts that matter.',
      '- Keep a checklist with checklist_write when the search has several parts, and name your session with session_name.',
      '- Cite what you found as path:line.',
      '- Return conclusions, not file dumps: what you found, where, and how sure you are.'
    ].join('\n'),
    tools: ['read', 'grep', 'find', 'ls', ...PROGRESS, ...RECALL, ...WEB],
    plugins: null, variant: null, model: null, effort: null
  }
]
