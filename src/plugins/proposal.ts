// A plugin an agent wrote for a person to consider. Nothing here installs anything on its own:
// the proposal waits in the Inbox; accepting it writes a package beside the person's data,
// switched off and (when it brings code) untrusted. The person then reads it, switches it on,
// and trusts it. No agent has a tool for either of those.
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'

import { invalid } from '../core/errors'
import { now, safeRelative, writeJson } from '../core/fs'
import { slugify } from '../core/projects'
import { inbox } from '../memory/operations'
import { looksSecret } from '../memory/secrets'
import * as store from '../memory/store'
import * as attachments from './attachments'

/** The parts a plugin can say it extends. */
export const EXTENDABLE = ['memory', 'wiki', 'history'] as const

const MAX_FILES = 40
const MAX_BYTES = 256 * 1024
const HOOKS_FILES = ['hooks.mjs', 'hooks.js']

export const pluginProposalSchema = z.object({
  name: z.string(),
  description: z.string().default(''),
  extends: z.array(z.string()).default([]),
  reason: z.string().default(''),
  files: z.array(z.object({ path: z.string(), content: z.string() }))
})
export type PluginProposal = z.infer<typeof pluginProposalSchema>

interface Checked {
  slug: string
  extends: string[]
  hooks: string | null
  runsCode: boolean
  files: { path: string; content: string }[]
}

/** The proposal with its paths made safe, or the reason it cannot be a plugin. */
export function checkPluginProposal(proposal: PluginProposal): Checked {
  const name = proposal.name.trim()
  const slug = slugify(name)
  if (!name || slug.startsWith('page-') || name.length > 64) throw invalid('Give the plugin a short name of letters and numbers.')
  if (!proposal.description.trim()) throw invalid('Say in one line what the plugin does; that line is what the user sees first.')
  const unknown = proposal.extends.find((part) => !(EXTENDABLE as readonly string[]).includes(part))
  if (unknown !== undefined) throw invalid(`A plugin can extend ${EXTENDABLE.join(', ')}; "${unknown}" is none of them.`)
  if (!proposal.files.length || proposal.files.length > MAX_FILES) throw invalid(`A plugin needs between 1 and ${MAX_FILES} files.`)
  const files: Checked['files'] = []
  let bytes = 0
  for (const file of proposal.files) {
    let path: string
    try {
      path = safeRelative(file.path.replace(/^\.\//, ''))
    } catch {
      throw invalid(`"${file.path}" is not a path inside the plugin.`)
    }
    const parts = path.split('/')
    if (parts.some((part) => part.startsWith('.') || part.includes(':') || part === 'node_modules')) throw invalid(`"${file.path}" cannot be part of a plugin.`)
    if (path === 'package.json') throw invalid('Leave package.json out; it is written from the name and description you gave.')
    if (files.some((existing) => existing.path.toLowerCase() === path.toLowerCase())) throw invalid(`"${file.path}" is listed twice.`)
    bytes += Buffer.byteLength(file.content, 'utf8')
    if (bytes > MAX_BYTES) throw invalid('The plugin is larger than 256 KiB.')
    if (looksSecret(file.content)) throw invalid(`"${file.path}" contains text that looks like a credential. A plugin reaches outside through a connected app, never with a key of its own.`)
    files.push({ path, content: file.content })
  }
  const hooks = files.find((file) => HOOKS_FILES.includes(file.path))?.path ?? null
  return { slug, extends: [...new Set(proposal.extends)], hooks, runsCode: hooks !== null || files.some((file) => file.path.startsWith('extensions/')), files }
}

/** Puts a proposed plugin in the Inbox, for a person to read before anything is written. */
export function parkPluginProposal(wiki: string, from: string, proposal: PluginProposal): string {
  const checked = checkPluginProposal(proposal)
  const listed = checked.files.map((file) => `- ${file.path} (${file.content.length} characters)`).join('\n')
  const code = checked.runsCode ? '\n\nIt brings code. Accepting only saves the files: the code runs after you also switch the plugin on and trust it.' : ''
  inbox(
    wiki,
    'proposed',
    `Proposed plugin "${proposal.name.trim()}"`,
    `${proposal.description.trim()}\n\n${proposal.reason.trim() || 'Review it before it is saved.'}${checked.extends.length ? `\n\nExtends: ${checked.extends.join(', ')}.` : ''}\n\nFiles:\n${listed}${code}\n\nFrom ${from}.`,
    [],
    null,
    { kind: 'plugin', proposal: { ...proposal, files: checked.files }, trigger: from }
  )
  store.log(wiki, `- ${now()} · ${from} · proposed plugin \`${checked.slug}\` · waiting in Inbox`)
  return checked.slug
}

/** Writes an accepted proposal as a package beside the person's data, switched off everywhere. */
export function acceptPluginProposal(root: string, proposal: PluginProposal): string {
  const checked = checkPluginProposal(proposal)
  const directory = join(root, 'plugins')
  const target = join(directory, checked.slug)
  if (existsSync(target)) throw invalid(`There is already a plugin folder called "${checked.slug}". Remove it or rename the proposal.`)
  mkdirSync(directory, { recursive: true })
  // Written beside its place and moved in whole, so a half-written plugin is never found.
  const staging = mkdtempSync(join(directory, '.accepting-'))
  try {
    writeJson(join(staging, 'package.json'), {
      name: checked.slug,
      version: '0.1.0',
      description: proposal.description.trim(),
      keywords: ['pi-package'],
      ...(checked.extends.length || checked.hooks ? { harness: { ...(checked.extends.length ? { extends: checked.extends } : {}), ...(checked.hooks ? { hooks: `./${checked.hooks}` } : {}) } } : {})
    })
    for (const file of checked.files) {
      const path = join(staging, ...file.path.split('/'))
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, file.content, { flag: 'wx' })
    }
    renameSync(staging, target)
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
  const choices = attachments.load(root)
  attachments.set(choices, [`package:${checked.slug}`], {}, false, true)
  attachments.save(root, choices)
  return `Saved the plugin "${checked.slug}", switched off.${checked.runsCode ? ' Its code does not run until you switch it on and trust it.' : ' Switch it on to use it.'}`
}
