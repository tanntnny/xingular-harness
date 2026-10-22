// A first variant for a caller that had none, built from what shaped it before harness
// variants existed: its instructions (c1), the rules switched on for it (c2), its memory blocks and
// the person's own block (c3), and the skills switched on for it (c6). Read straight from the
// files an earlier harness left in the data root; nothing there is changed.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import * as frontmatter from '../core/frontmatter'
import * as attachments from '../plugins/attachments'
import { GUARDRAILS, MEMORY, PI_SURFACE, SYSTEM_PROMPT, TOOL_GUIDANCE, type Variant } from './surface'
import { alwaysOnText, autotrigger, validate } from './variant'

export interface SeedInput {
  /** The caller whose rules, skills and memory blocks to carry over. */
  agentId?: string | null
  projectId?: string | null
  /** The caller's own instructions. */
  instructions?: string
}

function body(text: string): string {
  return (frontmatter.parse(text)?.body ?? text).trim()
}

function read(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function folders(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => !name.startsWith('.')).sort()
  } catch {
    return []
  }
}

/** Where an earlier Wiki kept memory blocks: in place, or where they were moved aside. */
function blocksDir(root: string): string | null {
  if (existsSync(join(root, 'wiki', 'blocks'))) return join(root, 'wiki', 'blocks')
  const moved = folders(join(root, 'legacy')).filter((name) => name.startsWith('wiki-')).reverse()
  for (const name of moved) if (existsSync(join(root, 'legacy', name, 'blocks'))) return join(root, 'legacy', name, 'blocks')
  return null
}

function skillName(stem: string): string {
  return stem.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|-+$/g, '').slice(0, 64) || 'skill'
}

/** The legacy pieces for a caller, before they are put together. */
export function legacyPieces(root: string, input: SeedInput): { rules: string[]; skills: Record<string, string>; memory: string[] } {
  const choices = attachments.load(root)
  const scope = { agentId: input.agentId ?? null, projectId: input.projectId ?? null }
  const on = (id: string) => attachments.attached(choices, [id], scope, false)

  const rules: string[] = []
  const rulesDir = join(root, 'registry', 'rules')
  for (const name of folders(rulesDir)) {
    const stem = name.replace(/\.md$/, '')
    const path = name.endsWith('.md') ? join(rulesDir, name) : join(rulesDir, name, 'SKILL.md')
    const text = read(path)
    if (text && on(`rules/${stem}`)) rules.push(body(text))
  }

  const skills: Record<string, string> = {}
  const skillsDir = join(root, 'registry', 'skills')
  for (const name of folders(skillsDir)) {
    const stem = name.replace(/\.md$/, '')
    let path = join(skillsDir, name)
    try {
      if (statSync(path).isDirectory()) path = join(path, 'SKILL.md')
    } catch {
      continue
    }
    const text = read(path)
    if (!text || !on(`skills/${stem}`)) continue
    const slug = skillName(stem)
    const parsed = frontmatter.parse(text)
    const description = typeof parsed?.front.description === 'string' && parsed.front.description.trim() ? parsed.front.description.trim() : `the ${slug} workflow applies`
    skills[`skills/${slug}/SKILL.md`] = `---\nname: ${slug}\ndescription: ${description.replace(/\n/g, ' ')}\n---\n${body(text)}\n`
  }

  const memory: string[] = []
  const blocks = blocksDir(root)
  if (blocks) {
    const user = read(join(blocks, 'shared', 'user.md'))
    if (user && body(user)) memory.push(`## About the person\n\n${body(user)}`)
    if (input.agentId && /^[A-Za-z0-9_-]+$/.test(input.agentId)) {
      for (const [file, title] of [['persona.md', 'Persona'], ['notes.md', 'Notes']] as const) {
        const text = read(join(blocks, 'agents', input.agentId, file))
        if (text && body(text)) memory.push(`## ${title}\n\n${body(text)}`)
      }
    }
  }
  return { rules, skills, memory }
}

/**
 * Builds a valid seed variant. Rules become guardrails, blocks become memory, and every skill gets a
 * trigger line. When the always-on text would be over the cap, memory is shortened first, then
 * guardrails; nothing else is dropped.
 */
export function seedVariant(root: string, input: SeedInput): Variant {
  const pieces = legacyPieces(root, input)
  const variant: Variant = {
    [SYSTEM_PROMPT]: (input.instructions ?? '').trim() ? `${input.instructions!.trim()}\n` : '',
    [GUARDRAILS]: pieces.rules.length ? `${pieces.rules.join('\n\n')}\n` : '',
    [MEMORY]: pieces.memory.length ? `${pieces.memory.join('\n\n')}\n` : '',
    [TOOL_GUIDANCE]: '',
    ...pieces.skills
  }
  const cap = PI_SURFACE.alwaysOnMax - 2_000
  for (const rel of [MEMORY, GUARDRAILS, SYSTEM_PROMPT]) {
    const over = alwaysOnText(PI_SURFACE, variant).length - cap
    if (over > 0) variant[rel] = `${variant[rel]!.slice(0, Math.max(0, variant[rel]!.length - over - 40)).trimEnd()}\n\n(Shortened when this harness was created.)\n`
  }
  autotrigger(PI_SURFACE, variant)
  validate(PI_SURFACE, variant, { compileScripts: false })
  return variant
}
