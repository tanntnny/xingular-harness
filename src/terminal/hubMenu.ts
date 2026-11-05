import type { HubOverview, HubReceipt } from '../hub/schema'
import type { MenuCall, MenuUi } from './pluginMenu'

type HubEntry = HubOverview['entries'][number]

export function marketplaceType(entry: HubEntry): string {
  if (entry.delivery.kind === 'pi-package') return 'Plugins'
  if (entry.delivery.kind === 'registry') return entry.delivery.registryKind === 'skills' ? 'Skills' : entry.delivery.registryKind === 'prompts' ? 'Prompts' : 'Rules'
  return entry.category === 'connector' ? 'MCP definitions' : 'Documents'
}

export function marketplaceInstallGuidance(entry: HubEntry): string {
  if (entry.delivery.kind === 'pi-package') return 'Installed switched off and untrusted. Use /plugins to review trust and switch it on, then restart the session.'
  if (entry.delivery.kind === 'registry') {
    if (entry.delivery.registryKind === 'skills') return 'Saved to the library. Use /skills to inspect it and add it to a writable variant for future sessions.'
    if (entry.delivery.registryKind === 'rules') return 'Saved to the library. Use /components to inspect it and add it to a writable variant for future sessions.'
    return 'Prompt saved to the library. Use /components to inspect it; prompts cannot be added to a variant here.'
  }
  return entry.category === 'connector'
    ? 'MCP definition saved. Open /mcp, find it under Installed, and set up a connection; then test, sign in if needed, and enable it.'
    : 'Document saved to the library for a compatible application. Nothing was enabled.'
}

/** What the person is told before installing: the entry, who published it, and what installing does. */
export function hubSummary(entry: HubEntry): string {
  return `${entry.description}\n\nPublisher: ${entry.publisher}\nLicense: ${entry.license}\nSource: ${entry.sourceUrl}\n\n${entry.delivery.kind === 'document' ? 'Saved as data. No connection is created or enabled.' : entry.delivery.kind === 'registry' ? 'Saved to the library. It is not added to a variant.' : 'Installed switched off. Code remains untrusted and approvals remain unchanged.'}`
}

/** Asks, then installs exactly this version. A refusal or a failure is reported and changes nothing. */
export async function installHubEntry(ui: MenuUi, call: MenuCall, entry: HubEntry): Promise<void> {
  if (!await ui.confirm(`Install ${entry.title} ${entry.version}?`, hubSummary(entry))) return
  try {
    await call<HubReceipt>('hub.install', { id: entry.id, version: entry.version })
    ui.notify(marketplaceInstallGuidance(entry), 'info')
  } catch (error) { ui.notify(error instanceof Error ? error.message : String(error), 'error') }
}

/** The terminal's catalog uses the same exact-version installer as embedding applications. */
export async function runHubMenu(ui: MenuUi, call: MenuCall): Promise<void> {
  for (;;) {
    const catalog = await call<HubOverview>('hub.list')
    const labels = catalog.entries.map((entry) => `${entry.title} · ${entry.category} · ${entry.id}@${entry.version}`)
    const picked = await ui.select('Marketplace', [...labels, 'Refresh catalog', 'Done'])
    if (picked === 'Refresh catalog') {
      const refreshed = await call<HubOverview>('hub.list', { refresh: true })
      if (refreshed.error) ui.notify(`${refreshed.error} Using ${refreshed.origin} content.`, 'warning')
      continue
    }
    const entry = catalog.entries[labels.indexOf(picked ?? '')]
    if (!entry) return
    await installHubEntry(ui, call, entry)
  }
}
