import { mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type * as Pi from '@earendil-works/pi-coding-agent'

import { writeFile } from '../../tests/helpers'
import type { Found } from './discover'
import type { Loading, Registered } from './plugins'
import { observeResources } from './runtime'

it('expands theme directories, filters individual files and replaces each handler observation', async () => {
  const pi = await import('@earendil-works/pi-coding-agent')
  const base = mkdtempSync(join(tmpdir(), 'resource-observation-'))
  const path = join(base, 'extension.ts')
  writeFile(path, 'export default function() {}')
  const first = join(base, 'themes/first.json')
  const second = join(base, 'themes/second.json')
  writeFile(first, '{}')
  writeFile(second, '{}')
  symlinkSync(join(base, 'absent.json'), join(base, 'themes/broken.json'))
  writeFile(join(base, 'review.md'), '---\nname: runtime-review\ndescription: Review.\n---\nReview text.')
  let active = true
  const handlers = new Map([['resources_discover', [async () => active ? { themePaths: ['./themes'] } : undefined, async () => ({ promptPaths: ['./review.md'] })]]])
  const extension = { path, resolvedPath: path, handlers }
  const loader = { getExtensions: () => ({ extensions: [extension] }) } as unknown as Pi.DefaultResourceLoader
  const owner: Found = { kind: 'extension', path, origin: 'shared', project: false, packageRoot: null, source: null, enabled: true }
  const loading: Loading = { extensionPaths: [path], skillPaths: [], promptPaths: [], themePaths: [], builtins: [], hooks: [], found: [owner], detached: [], projectCode: null, packageCode: {}, resourceAllowed: (item) => item.path !== first }
  const records: Registered[] = [{ path, tools: [], commands: [], hooks: ['resources_discover'], flags: [], shortcuts: [] }]
  let published = 0
  observeResources(pi, loader, loading, records, () => { published++ })
  const wrapped = extension.handlers.get('resources_discover')! as unknown as Array<(event: unknown, context: unknown) => Promise<Pi.ResourcesDiscoverResult | undefined>>
  expect(await wrapped[0]({}, {})).toMatchObject({ themePaths: [second] })
  await wrapped[1]({}, {})
  expect(records[0].resources?.map((resource) => resource.name)).toEqual(['first.json', 'second.json', 'runtime-review'])
  active = false
  await wrapped[0]({}, {})
  expect(records[0].resources?.map((resource) => resource.name)).toEqual(['runtime-review'])
  expect(published).toBe(3)
})
