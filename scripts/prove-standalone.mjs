#!/usr/bin/env node
// Shows that the harness runs with no application around it: starts `xagent serve`
// on a throwaway data root and drives it over newline-delimited JSON, the way a host written
// in any language would. No model request is made: the scripted session has no credentials,
// so the proof is that it is recorded and fails cleanly.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'harness-proof-'))
const cli = join(here, '..', 'dist', 'cli.js')
const child = spawn(process.execPath, [cli, 'serve', '--state', join(scratch, 'state'), '--data', join(scratch, 'data'), '--name', 'Proof Host'], { stdio: ['pipe', 'pipe', 'inherit'] })

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
  const hub = await request('hub.list')
  const document = hub.entries.find((entry) => entry.delivery.kind === 'document')
  await request('hub.install', { id: document.id, version: document.version })
  const savedDocument = await request('hub.readDocument', { id: document.id, version: document.version })
  check('installs a reviewed hub document as inert data', !!JSON.parse(savedDocument.content) && (await request('hub.list')).installed.length === 1)

  const { accounts } = await request('accounts.create', { label: 'First', authKind: 'apiKey' })
  await request('accounts.create', { label: 'Second', authKind: 'apiKey' })
  const overview = await request('accounts.list')
  check('keeps several isolated Pi accounts', overview.accounts.length === 2 && overview.accounts[0].provider === 'pi', overview.accounts.map((account) => account.label).join(', '))

  const caller = { agentId: 'proof-agent', agentName: 'Prover', actor: 'Chat' }
  // The agent's harness: a versioned variant of the eight components.
  const seeded = await request('variants.seed', { scope: 'proof-agent', variant: { 'systemprompt.md': 'You prove the harness runs on its own.\n', 'guardrails.md': '- When asked for a proof, load the `proof` skill.\n', 'memory.md': 'The proof ran.\n', 'tool_guidance.md': '', 'skills/proof/SKILL.md': '---\nname: proof\ndescription: asked for a proof\n---\nList each check.\n' } })
  const edited = await request('variants.save', { scope: 'proof-agent', edit: { 'tool_guidance.md': 'Read before you write.\n' }, note: 'proof edit' })
  let refused = ''
  try {
    await request('variants.save', { scope: 'proof-agent', edit: { 'skills/orphan/SKILL.md': '---\nname: orphan\ndescription: never named\n---\nx\n' } })
  } catch (error) {
    refused = error.message
  }
  const lineage = await request('variants.lineage', { scope: 'proof-agent' })
  check('keeps a versioned variant and refuses an invalid one', lineage.length === 2 && edited.parent === seeded.fingerprint && refused.includes('never named in the always-on text'), `${lineage.length} versions`)

  await request('wiki.write', { path: 'library/proof', text: '# Proof\n\nThe harness runs on its own. See [[home]].\n' })
  const found = await request('wiki.search', { query: 'harness runs' })
  const graph = await request('wiki.graph')
  check('keeps linked project notes in the Wiki', found.length > 0 && graph.edges.some((edge) => edge.from === 'library/proof' && edge.to === 'home'), `${found.length} hit; ${graph.edges.length} link`)

  const compiled = await request('context.compile', { context: caller, variant: { scope: 'proof-agent' }, launch: { sections: [{ id: 'identity', title: 'Identity', body: 'You are the Prover.', budget: 1000, order: 10 }] }, render: true })
  check('compiles a prompt from the host\'s sections and the variant', compiled.text.includes('You are the Prover.') && compiled.text.includes('The proof ran.') && compiled.text.includes('Read before you write.'), `${compiled.pack.sections.map((section) => section.id).join(', ')}`)

  const connections = await request('connections.list')
  check('lists connected apps', Array.isArray(connections), `${connections.length} configured`)

  const repo = join(scratch, 'repo')
  mkdirSync(repo)
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@p', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@p' }
  for (const args of [['init', '-q'], ['commit', '-q', '--allow-empty', '-m', 'proof']]) spawnSync('git', args, { cwd: repo, env: gitEnv })
  writeFileSync(join(repo, 'work.txt'), 'unsaved\n')
  const made = await request('worktrees.create', { repo })
  const listed = await request('worktrees.list', { repo })
  const carried = existsSync(join(made.worktree.path, 'work.txt'))
  const removed = await request('worktrees.remove', { id: made.worktree.id, force: true })
  const pageNote = await request('annotations.create', { source: { url: 'https://example.com/proof', title: 'Proof' }, target: { kind: 'text', exact: 'proof text', prefix: '', suffix: '', start: 0, end: 10 }, body: 'Remember the proof.' })
  const sharedNote = await request('annotations.share', { id: pageNote.id, principal: { sessionId: 'proof-agent' } })
  const helper = await request('annotations.pageScript')
  // A host's session gets the queued notes as one instruction, starts the run itself, and reports it.
  const acted = await request('annotations.createAndAct', { note: { source: { url: 'http://localhost:5173/', title: 'Dev' }, target: { kind: 'page' }, body: 'Fix the header.' }, action: 'send', sessionId: 'proof-host', trusted: true })
  const composed = await request('annotations.compose', { sessionId: 'proof-host' })
  const delivered = await request('annotations.delivered', { ids: composed.ids, sessionId: 'proof-host', runId: 'proof-host-run' })
  check('queues a page note for a host session and records the run it was sent in', acted.send?.state === 'host' && composed.text.includes('Fix the header.') && delivered.notes[0]?.delivery?.state === 'sent', `${composed.ids.length} note`)
  check('keeps a private page note, shares it with one session, and serves the page helper', pageNote.grants.length === 0 && sharedNote.grants[0]?.principal.sessionId === 'proof-agent' && helper.script.includes('__ARGS__'), `version ${sharedNote.version}`)
  check('makes, lists and removes a managed worktree, keeping unsaved work as a snapshot', listed.length === 1 && carried && Boolean(removed.snapshot) && !existsSync(made.worktree.path), `${made.worktree.name}; snapshot ${removed.snapshot ? 'kept' : 'missing'}`)

  await request('sessions.run', { run: { id: 'proof-run', sessionId: 'proof-agent' }, accountId: accounts[0].id, cwd: scratch, sessionDir: join(scratch, 'data', 'sessions', 'proof-agent'), text: 'Say hello.', caller, tools: { allow: ['read'] } })
  const deadline = Date.now() + 20_000
  let run
  while (Date.now() < deadline) {
    run = (await request('runs.load', { runId: 'proof-run' })).run
    if (!['queued', 'running'].includes(run.status)) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  check('records a scripted session as a run with events (no credentials, so it fails cleanly)', run.status === 'failed' && events.some((event) => event.runId === 'proof-run'), `status ${run.status}; ${events.length} events relayed`)
  check('tells the host when state changes', ['accounts.changed', 'wiki.changed', 'variants.changed'].every((type) => notices.some((notice) => notice.type === type)))

  // Usage is derived from the run's own recorded events; reading limits is a stored report unless
  // a caller explicitly asks for a refresh, so this path never contacts a provider.
  const usageSummary = await request('usage.summary', { scope: 'account', accountId: accounts[0].id, period: '7d' })
  check('answers usage analytics from the derived ledger', usageSummary && usageSummary.totals.requests === 0 && Array.isArray(usageSummary.byModel) && usageSummary.scope === 'account', `scope ${usageSummary?.scope}; requests ${usageSummary?.totals?.requests}`)
  const usageLimits = await request('usage.limits', { accountId: accounts[0].id })
  check('reports provider limits as stored data unless a refresh is asked for', usageLimits && usageLimits.accounts.length === 1 && usageLimits.accounts.every((account) => Array.isArray(account.providers)), `${usageLimits?.accounts?.length} accounts`)

  // A plugin that extends the Wiki with a hook: installed from a folder, it hears nothing until it
  // is switched on and trusted, then every saved note; changed code is read again once trusted.
  const pluginDir = join(scratch, 'mirror')
  const heard = join(scratch, 'heard.log')
  const hooksFile = (label) => `import { appendFileSync } from 'node:fs'\nexport default function (harness) { harness.on('wiki.page.saved', (event) => appendFileSync(${JSON.stringify(heard)}, '${label}:' + event.title + '\\n')) }\n`
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({ name: 'mirror', version: '1.0.0', description: 'Copies each saved note.', harness: { extends: ['wiki'], hooks: './hooks.mjs' } }))
  writeFileSync(join(pluginDir, 'hooks.mjs'), hooksFile('v1'))
  const toldSoFar = () => (existsSync(heard) ? readFileSync(heard, 'utf8').trim().split('\n').filter(Boolean) : [])
  const settle = () => new Promise((resolve) => setTimeout(resolve, 400))
  const mirror = (plugins) => plugins.find((plugin) => plugin.id === 'package:mirror')
  const installed = mirror(await request('plugins.install', { source: pluginDir }))
  await request('wiki.write', { path: 'library/before', text: '---\ntitle: Before\n---\n\nNot heard.\n' })
  await settle()
  const quiet = toldSoFar().length === 0
  await request('plugins.attach', { id: 'package:mirror' })
  await request('plugins.trust', { hash: installed.code.hash })
  await settle()
  await request('wiki.write', { path: 'library/first', text: '---\ntitle: First\n---\n\nHeard by version one.\n' })
  await settle()
  writeFileSync(join(pluginDir, 'hooks.mjs'), hooksFile('v2'))
  await request('wiki.write', { path: 'library/while-changed', text: '---\ntitle: While changed\n---\n\nChanged code is not trusted.\n' })
  await settle()
  await request('plugins.trust', { hash: mirror(await request('plugins.list')).code.hash })
  await settle()
  await request('wiki.write', { path: 'library/second', text: '---\ntitle: Second\n---\n\nHeard by version two.\n' })
  await settle()
  check('runs a plugin hook after a note is saved, only while it is switched on and its code is trusted', quiet && installed.extends.join() === 'wiki' && toldSoFar().join() === 'v1:First,v2:Second', toldSoFar().join(', ') || 'nothing heard')

  const demo = spawnSync(process.execPath, [cli, 'refine', 'demo', '--k', '2', '--out', join(scratch, 'demo')], { encoding: 'utf8' })
  check('refines a harness end to end: Propose–Probe–Compose, blind selection, and a library entry', demo.status === 0 && (demo.stdout.match(/R=8\/8 executions, P=6\/6 improver sessions/g) ?? []).length === 2 && demo.stdout.includes('library: ledger-1, ledger-2'), demo.stdout.split('\n')[0] || demo.stderr)

  const matrixRoot = join(scratch, 'matrix')
  const matrix = spawnSync(process.execPath, [cli, 'refine', 'matrix', '--demo', '--data', matrixRoot, '--out', join(matrixRoot, 'summary.json')], { encoding: 'utf8' })
  const matrixSummary = matrix.status === 0 ? JSON.parse(readFileSync(join(matrixRoot, 'summary.json'), 'utf8')) : null
  check('evaluates a harness matrix with no model: per-version deliverability with comparability keys', matrixSummary !== null && matrixSummary.status === 'ok' && matrixSummary.rows.length === 2 && matrixSummary.rows[0].packageVersion === JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version && matrixSummary.rows[0].executor === 'DemoExecutor', matrix.stdout.split('\n')[0] || matrix.stderr)

  await request('harness.shutdown')
} catch (error) {
  check('the proof ran to the end', false, error.message)
} finally {
  child.stdin.end()
  await new Promise((resolve) => child.once('exit', resolve))
  rmSync(scratch, { recursive: true, force: true })
}
process.exit(checks.every(Boolean) ? 0 : 1)
