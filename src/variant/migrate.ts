// Moves state written before the foundation/variant naming (PROP-0009) to its new names. Every
// step renames and never overwrites, so running it again, or beside new data, changes nothing.
import { existsSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'

function move(from: string, to: string, moved: string[]): void {
  if (!existsSync(from) || existsSync(to)) return
  renameSync(from, to)
  moved.push(to)
}

function folders(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
}

/** `harnesses/<scope>/versions/<fp>/tree/` and `library/<scope>/<area>/harnesses/<task>/harness/`. */
export function migrateVariantLayout(root: string): string[] {
  const moved: string[] = []
  move(join(root, 'harnesses'), join(root, 'variants'), moved)
  for (const scope of folders(join(root, 'variants'))) {
    const versions = join(root, 'variants', scope, 'versions')
    for (const fingerprint of folders(versions)) move(join(versions, fingerprint, 'tree'), join(versions, fingerprint, 'variant'), moved)
  }
  for (const scope of folders(join(root, 'library'))) {
    for (const area of folders(join(root, 'library', scope))) {
      const base = join(root, 'library', scope, area)
      move(join(base, 'harnesses'), join(base, 'variants'), moved)
      for (const task of folders(join(base, 'variants'))) move(join(base, 'variants', task, 'harness'), join(base, 'variants', task, 'variant'), moved)
    }
  }
  return moved
}

/** The device-local file of trusted plugin code. */
export function migrateTrustFile(stateDir: string): void {
  move(join(stateDir, 'tree-plugin-trust.json'), join(stateDir, 'variant-plugin-trust.json'), [])
}
