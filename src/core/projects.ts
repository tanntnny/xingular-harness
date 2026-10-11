// Projects: named working folders, each with a Wiki namespace (`/projects/<slug>`). The harness
// reads `<data root>/projects.json`; the embedding application adds, renames, and removes them.
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { notFound } from './errors'
import { readJson } from './fs'
import { newId } from './fs'

interface ProjectRecord {
  id: string
  name: string
  rootPath: string
  autoMaintenance: boolean
  createdAt: string
  /** Stable Wiki namespace segment; kept when the project is renamed. */
  slug?: string
}

export interface Project {
  id: string
  name: string
  rootPath: string
  isGitRepository: boolean
  autoMaintenance: boolean
  createdAt: string
  slug: string
  /** `/projects/<slug>`: where this project's pages live in the Wiki. */
  wikiNamespace: string
}

/** Same rule as the Wiki's page slugs, kept here so `core` does not depend on `memory`. */
export function slugify(text: string): string {
  let value = ''
  for (const character of text.toLowerCase()) {
    if (/^[a-z0-9]$/.test(character)) value += character
    else if (value && !value.endsWith('-')) value += '-'
  }
  value = value.replace(/^-+|-+$/g, '').slice(0, 60)
  return value || `page-${newId().slice(0, 8)}`
}

export function uniqueSlug(name: string, taken: readonly string[]): string {
  const slug = slugify(name)
  const base = slug.startsWith('page-') ? 'project' : slug
  let candidate = base
  for (let counter = 2; taken.includes(candidate); counter += 1) candidate = `${base}-${counter}`
  return candidate
}

function load(root: string): ProjectRecord[] {
  const records = readJson<ProjectRecord[]>(join(root, 'projects.json')) ?? []
  // Records without a slug get a unique one derived from the name, in list order, so the result
  // is the same on every read until the application persists it.
  const taken = records.map((record) => record.slug ?? '').filter(Boolean)
  for (const record of records) {
    if (record.slug) continue
    record.slug = uniqueSlug(record.name, taken)
    taken.push(record.slug)
  }
  return records
}

export function listProjects(root: string): Project[] {
  return load(root).map((record) => ({
    id: record.id,
    name: record.name,
    rootPath: record.rootPath,
    isGitRepository: existsSync(join(record.rootPath, '.git')),
    autoMaintenance: record.autoMaintenance,
    createdAt: record.createdAt,
    slug: record.slug!,
    wikiNamespace: `/projects/${record.slug}`
  }))
}

/** `listProjects` for callers that treat an unreadable registry like an empty one. */
export function projectsOrNone(root: string): Project[] {
  try {
    return listProjects(root)
  } catch {
    return []
  }
}

export function findProject(root: string, projectId: string): Project {
  const project = listProjects(root).find((entry) => entry.id === projectId)
  if (!project) throw notFound('Project')
  return project
}
