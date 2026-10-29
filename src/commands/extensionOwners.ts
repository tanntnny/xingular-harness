import { resolve, sep } from 'node:path'
import type * as Pi from '@earendil-works/pi-coding-agent'
import type { Found } from '../plugins/discover'

/** Restore package identity lost when Harness passes individually selected paths to Pi. */
export function applyExtensionOwners(loader: Pi.DefaultResourceLoader, found: readonly Found[]): void {
  for (const extension of loader.getExtensions().extensions) {
    if (extension.hidden) continue
    const path = resolve(extension.resolvedPath || extension.path)
    const owner = found.filter(item => item.kind === 'extension' && item.packageRoot && (path === resolve(item.path) || path.startsWith(`${resolve(item.path)}${sep}`)))
      .sort((a, b) => b.path.length - a.path.length)[0]
    if (!owner?.packageRoot) continue
    const sourceInfo = { ...extension.sourceInfo, origin: 'package' as const, baseDir: owner.packageRoot, source: owner.source ?? owner.packageRoot }
    extension.sourceInfo = sourceInfo
    for (const command of extension.commands.values()) command.sourceInfo = sourceInfo
  }
}
