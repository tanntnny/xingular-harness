import { z } from 'zod'

export const HUB_CATALOG_URL = 'https://raw.githubusercontent.com/tanntnny/xingular-hub/main/catalog.json'
export const HUB_MAX_BYTES = 16 * 1024 * 1024
export const HUB_PREVIEW_PAGE_BYTES = 16 * 1024

const httpsUrl = z.string().max(2000).url().refine((value) => {
  const url = new URL(value)
  return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && !url.port
}, 'Use a public HTTPS URL without credentials, queries, or fragments.')
const payload = {
  url: httpsUrl,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bundled: z.string().max(HUB_MAX_BYTES).optional()
}

export const hubDeliverySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('registry'), registryKind: z.enum(['skills', 'prompts', 'rules']), ...payload }).strict(),
  z.object({ kind: z.literal('document'), ...payload }).strict(),
  z.object({ kind: z.literal('pi-package'), source: z.string().max(2000).refine((source) =>
    /^npm:(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+@\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(source)
    || /^git:https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(?:\.git)?@[a-f0-9]{40}$/.test(source),
  'Packages must use an exact npm version or a GitHub commit.') }).strict()
])

export const hubEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,64}\/[a-z0-9-]{1,64}$/),
  title: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  publisher: z.string().min(1).max(100),
  license: z.string().min(1).max(100),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/),
  category: z.string().regex(/^[a-z][a-z-]{0,40}$/),
  channel: z.enum(['official', 'community']),
  tags: z.array(z.string().max(60)).max(20),
  requires: z.record(z.string(), z.string().regex(/^\d+\.\d+\.\d+$/)),
  sourceUrl: httpsUrl,
  delivery: hubDeliverySchema
}).strict()

export const hubCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  entries: z.array(hubEntrySchema).max(2000)
}).strict().superRefine((catalog, ctx) => {
  const keys = new Set<string>()
  catalog.entries.forEach((entry, index) => {
    const key = `${entry.id}@${entry.version}`
    if (keys.has(key)) ctx.addIssue({ code: 'custom', path: ['entries', index, 'id'], message: 'Duplicate catalog item version.' })
    keys.add(key)
  })
})

export const hubReceiptSchema = z.object({
  entry: hubEntrySchema,
  installedAt: z.string(),
  resourceIds: z.array(z.string()),
  document: z.string().nullable(),
  state: z.enum(['installed', 'changed', 'incomplete']).optional()
}).strict()

export const hubPreviewPageSchema = z.object({
  entry: hubEntrySchema,
  content: z.string(),
  offset: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  done: z.boolean()
}).strict()

export const hubOverviewSchema = z.object({
  entries: z.array(hubEntrySchema),
  installed: z.array(hubReceiptSchema),
  origin: z.enum(['bundled', 'cached', 'remote']),
  refreshedAt: z.string().nullable(),
  error: z.string().nullable(),
  dataRoot: z.string().nullable(),
  stateDir: z.string()
})

export type HubEntry = z.infer<typeof hubEntrySchema>
export type HubCatalog = z.infer<typeof hubCatalogSchema>
export type HubReceipt = z.infer<typeof hubReceiptSchema>
export type HubPreviewPage = z.infer<typeof hubPreviewPageSchema>
export type HubOverview = z.infer<typeof hubOverviewSchema>

export function meetsMinimum(actual: string, minimum: string): boolean {
  const left = actual.split(/[.-]/).slice(0, 3).map(Number)
  const right = minimum.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index]
  }
  return true
}
