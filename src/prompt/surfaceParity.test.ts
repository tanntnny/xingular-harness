// The terminal and a host compile one session to the same words (PROP-0039, INV-PAR-1): the
// same role, working folder, tool paragraphs and connections text, whichever front end runs it.
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { dataRoot } from '../../tests/helpers'
import type { CallerContext } from '../core/caller'
import { createEnv } from '../core/env'
import { writeJson } from '../core/fs'
import { closeIndex } from '../core/index'
import { DEFAULT_TOOL_NAMES } from '../tools/definitions'
import { compile, render, type Launch } from './compile'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(closeIndex))

function env() {
  const root = dataRoot()
  roots.push(root)
  writeJson(join(root, 'projects.json'), [{ id: 'p1', name: 'Site', rootPath: '/src/site', autoMaintenance: true, createdAt: 't', slug: 'site' }])
  return createEnv(root)
}

// What each front end switches on for a person's own session: the harness's tools, the broker's,
// the world tools and the annotations tools.
const TOOLS = ['todo_write', 'session_name', ...DEFAULT_TOOL_NAMES, 'mcp_list_tools', 'mcp_call_tool', 'web_search', 'web_fetch', 'page_notes_list', 'page_notes_read', 'spawn_subagent', 'wait_subagents']

test('a terminal session and a host session compile to the same prompt', () => {
  const harness = env()
  const launch: Launch = { standard: { cwd: '/src/site' }, tools: TOOLS }
  const terminal: CallerContext = { sessionId: 's1', projectId: 'p1', actor: 'Code', surface: 'cli' }
  const host: CallerContext = { sessionId: 's1', agentId: 'solo', projectId: 'p1', actor: 'Chat' }
  const fromTerminal = compile(harness, terminal, launch)
  // A structured run narrows `connectionTools` to its capability set, which may leave it empty.
  const fromHost = compile(harness, host, { ...launch, connectionTools: [] })
  expect(render(harness, fromHost)).toBe(render(harness, fromTerminal))
  expect(fromHost.toolGroups).toEqual(fromTerminal.toolGroups)
  const text = render(harness, fromTerminal)
  expect(text).toContain('## Role')
  expect(text).toContain('Working project: Site.')
  expect(text).toContain('Annotations: web annotations')
  expect(text).toContain('App tools and connected apps: Connected apps are available')
  expect(text).not.toContain('xagent-wiki')
})

test('a host add-on group joins the prompt without changing the shared part', () => {
  const harness = env()
  const caller: CallerContext = { sessionId: 's1', agentId: 'solo', actor: 'Chat' }
  const base = render(harness, compile(harness, caller, { standard: { cwd: '/w' }, tools: TOOLS }))
  const withAddOn = render(harness, compile(harness, caller, {
    standard: { cwd: '/w' },
    tools: [...TOOLS, 'files_list'],
    toolGroups: [{ group: 'Files', tools: ['files_list'], guidance: 'Saved files (files_list): an add-on of this host.', order: 80 }]
  }))
  const added = 'Saved files (files_list): an add-on of this host.\n\n'
  expect(withAddOn.replace(added, '')).toBe(base)
})
