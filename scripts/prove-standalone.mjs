#!/usr/bin/env node
// Shows that the harness runs with no application around it: starts `xingular-harness serve`
// on a throwaway data root and drives it over newline-delimited JSON, the way a host written
// in any language would. No model request is made: the scripted session has no credentials,
// so the proof is that it is recorded and fails cleanly.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'harness-proof-'))
const child = spawn(process.execPath, [join(here, '..', 'dist', 'cli.js'), 'serve', '--state', join(scratch, 'state'), '--data', join(scratch, 'data'), '--name', 'Proof Host'], { stdio: ['pipe', 'pipe', 'inherit'] })

const waiting = new Map()
const events = []
const notices = []
let ready
const isReady = new Promise((resolve) => (ready = resolve))
createInterface({ input: child.stdout }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.event) events.push(message.event)
  else if (message.notice) {
    notices.push(message.notice)
    if (message.notice.type === 'ready') ready()
  } else if (waiting.has(message.id)) {
    const { resolve, reject } = waiting.get(message.id)
    waiting.delete(message.id)
    if (message.error) reject(Object.assign(new Error(message.error.message), message.error))
    else resolve(message.result)
  }
})
let next = 0
const request = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = `p${++next}`
    waiting.set(id, { resolve, reject })
    child.stdin.write(`${JSON.stringify({ v: 1, id, method, params })}\n`)
  })

const checks = []
const check = (name, passed, detail = '') => {
  checks.push(passed)
  console.log(`${passed ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

try {
  await isReady
  const status = await request('harness.status')
  check('serves a data root with no application present', status.productName === 'Proof Host' && status.dataRoot === join(scratch, 'data'))

  const { accounts } = await request('accounts.create', { label: 'First', authKind: 'apiKey' })
  await request('accounts.create', { label: 'Second', authKind: 'apiKey' })
  const overview = await request('accounts.list')
  check('keeps several isolated Pi accounts', overview.accounts.length === 2 && overview.accounts[0].provider === 'pi', overview.accounts.map((account) => account.label).join(', '))

  const caller = { agentId: 'proof-agent', agentName: 'Prover', actor: 'Chat' }
  await request('blocks.list', { agentIds: ['proof-agent'] })
  await request('memory.call', { context: caller, call: 'memory.append', params: { block: 'notes', text: 'The proof ran.' } })
  // A fact with no evidence the harness can find is parked for a person, never saved.
  await request('memory.call', { context: caller, call: 'wiki.propose', params: { kind: 'memory', title: 'Unsupported claim', body: 'Nothing backs this.', type: 'fact', sourceRefs: [{ kind: 'user', ref: 'proof script' }] } })
  const inbox = await request('wiki.inbox')
  await request('facts.save', { input: { title: 'Proof fact', kind: 'fact', body: 'The harness runs on its own.' } })
  const found = await request('wiki.find', { query: 'harness runs', options: {} })
  check('runs the memory lifecycle: blocks, facts, search, and an evidence gate', found.length > 0 && inbox.length === 1, `${found.length} hit; ${inbox.length} proposal parked in the Inbox`)

  await request('skills.create', { kind: 'skills', name: 'Proof skill' })
  const skills = await request('skills.setEnabled', { projectId: null, ids: ['skills/proof-skill'] })
  check('holds skills and their enablement', skills.items.some((item) => item.id === 'skills/proof-skill'))

  const compiled = await request('context.compile', { context: caller, launch: { sections: [{ id: 'identity', title: 'Identity', body: 'You are the Prover.', budget: 1000, order: 10 }] }, render: true })
  check('compiles a prompt from the host\'s sections and its own', compiled.text.includes('You are the Prover.') && compiled.text.includes('The proof ran.') && compiled.text.includes('proof-skill'), `${compiled.pack.sections.map((section) => section.id).join(', ')}`)

  const connections = await request('connections.list')
  check('lists connected apps', Array.isArray(connections), `${connections.length} configured`)

  await request('sessions.run', { run: { id: 'proof-run', sessionId: 'proof-agent' }, accountId: accounts[0].id, cwd: scratch, sessionDir: join(scratch, 'data', 'sessions', 'proof-agent'), text: 'Say hello.', caller, tools: { allow: ['read'] } })
  const deadline = Date.now() + 20_000
  let run
  while (Date.now() < deadline) {
    run = (await request('runs.load', { runId: 'proof-run' })).run
    if (!['queued', 'running'].includes(run.status)) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  check('records a scripted session as a run with events (no credentials, so it fails cleanly)', run.status === 'failed' && events.some((event) => event.runId === 'proof-run'), `status ${run.status}; ${events.length} events relayed`)
  check('tells the host when state changes', ['accounts.changed', 'wiki.changed'].every((type) => notices.some((notice) => notice.type === type)))

  await request('harness.shutdown')
} catch (error) {
  check('the proof ran to the end', false, error.message)
} finally {
  child.stdin.end()
  await new Promise((resolve) => child.once('exit', resolve))
  rmSync(scratch, { recursive: true, force: true })
}
process.exit(checks.every(Boolean) ? 0 : 1)
