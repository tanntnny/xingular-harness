import type { HubOverview, HubReceipt } from '../hub/schema'
import type { MenuCall, MenuUi } from './pluginMenu'

type HubEntry = HubOverview['entries'][number]

/** What the person is told before installing: the entry, who published it, and what installing does. */
export function hubSummary(entry: HubEntry): string {
  return `${entry.description}\n\nPublisher: ${entry.publisher}\nLicense: ${entry.license}\nSource: ${entry.sourceUrl}\n\n${entry.delivery.kind === 'document' ? 'Saved as data for a compatible application. Nothing is created or enabled.' : 'Installed switched off. Code remains untrusted and approvals remain unchanged.'}`
}

/** Asks, then installs exactly this version. A refusal or a failure is reported and changes nothing. */
export async function installHubEntry(ui: MenuUi, call: MenuCall, entry: HubEntry): Promise<void> {
  if (!await ui.confirm(`Install ${entry.title} ${entry.version}?`, hubSummary(entry))) return
  try {
    const receipt = await call<HubReceipt>('hub.install', { id: entry.id, version: entry.version })
    ui.notify(receipt.document ? 'Saved in this library for a compatible application.' : 'Installed, switched off. Use /plugins to review and attach it. Changes apply after restarting the session.', 'info')
  } catch (error) { ui.notify(error instanceof Error ? error.message : String(error), 'error') }
}

/** The terminal's catalog uses the same exact-version installer as embedding applications. */
export async function runHubMenu(ui: MenuUi, call: MenuCall): Promise<void> {
  for (;;) {
    const catalog = await call<HubOverview>('hub.list')
    const labels = catalog.entries.map((entry) => `${entry.title} · ${entry.category} · ${entry.id}@${entry.version}`)
    const picked = await ui.select('Hub', [...labels, 'Refresh catalog', 'Done'])
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
