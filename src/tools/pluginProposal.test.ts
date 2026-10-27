import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import { createEnv } from '../core/env'
import { list } from '../plugins/proposals'
import { harnessTools } from './harnessTools'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('offers a write-classified tool that only creates a pending proposal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-tool-'))
  roots.push(root)
  const tool = harnessTools(createEnv(root), {}).find((item) => item.name === 'plugin_propose')!
  expect(tool.readOnly).toBe(false)
  const result = await tool.execute({ name: 'tui-design', description: 'Audit terminal design', files: { 'skills/tui-design/SKILL.md': '---\nname: tui-design\ndescription: Audit terminal design\n---\nInspect the terminal.\n' } })
  expect(result).toContain('not installed or enabled')
  expect(list(root)).toMatchObject([{ name: 'tui-design', status: 'pending' }])
})
