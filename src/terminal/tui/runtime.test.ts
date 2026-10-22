import { mkdtempSync, mkdirSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionAPI, ExtensionUIContext } from '@earendil-works/pi-coding-agent'

const transport = vi.hoisted(() => ({ claim: vi.fn(async () => 'private-control'), call: vi.fn(async (_call: string) => ({})) }))
vi.mock('../control', () => ({ claimTerminalControl: transport.claim, controlCall: transport.call }))
vi.mock('../piExtension', () => ({ default: (pi: ExtensionAPI) => {
  pi.on('session_start', (_event, ctx) => { pi.appendEntry('bridge-start', { mode: ctx.mode }) })
} }))

import { sessionNameTool } from '../../tools/sessionName'
import { assertTerminalSessionScope, createTerminalRuntime, parseTerminalArguments, type TerminalRuntime } from './runtime'
import { assertPiAdapterVersion, loadPiAdapter, withBuiltInRenderers } from './piAdapter'

const folders: string[] = []
const runtimes: TerminalRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  transport.call.mockReset().mockResolvedValue({})
  transport.claim.mockClear()
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'harness-terminal-runtime-'))
  folders.push(root)
  const cwd = join(root, 'project')
  const account = join(root, 'account')
  const history = join(root, 'history')
  mkdirSync(cwd)
  mkdirSync(account)
  mkdirSync(history)
  vi.spyOn(process, 'cwd').mockReturnValue(cwd)
  vi.stubEnv('PI_CODING_AGENT_DIR', account)
  const plugin = join(root, 'fixture.mjs')
  writeFileSync(plugin, `export default function (pi) {
    pi.on('session_start', (_event, ctx) => pi.appendEntry('fixture-start', { mode: ctx.mode }))
    pi.registerCommand('marker', { description: 'A local fixture command', handler: async (args) => { pi.appendEntry('marker', { text: args }) } })
  }`)
  const args = ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--extension', plugin, '--extension', join(root, 'terminal-pi.js'), '--session-dir', history, '--append-system-prompt', 'Fixed Harness context.']
  const changed = vi.fn()
  const ui = { getEditorText: () => '', select: vi.fn(async () => undefined), notify: vi.fn() } as unknown as ExtensionUIContext
  return { root, cwd, account, history, plugin, args, host: { ui, changed, shutdown: vi.fn(), notify: vi.fn() } }
}

async function openFixture() {
  const f = fixture()
  const runtime = await createTerminalRuntime(f.args, f.host)
  runtimes.push(runtime)
  return { ...f, runtime }
}

describe('the persistent terminal SDK adapter', () => {
  it('parses only the prepared resource flags without discovering extra resources', () => {
    const parsed = parseTerminalArguments(['--no-extensions', '--extension', 'builtin:mcp', '--extension', '/bridge.js', '--skill', '/skill', '--prompt-template', '/prompt', '--theme', '/theme', '--session-dir', '/history', '--session', '/history/old.jsonl', '--model', 'provider/model', '--append-system-prompt', 'context'])
    expect(parsed).toEqual({ appendSystemPrompt: ['context'], extensions: ['builtin:mcp', '/bridge.js'], skills: ['/skill'], prompts: ['/prompt'], themes: ['/theme'], sessionDir: '/history', session: '/history/old.jsonl', model: 'provider/model' })
    expect(() => parseTerminalArguments(['--serve'])).toThrow('Unsupported')
    expect(() => parseTerminalArguments(['--session-dir'])).toThrow('needs a value')
    expect(() => parseTerminalArguments(['--session-dir', '/history'])).toThrow('bridge extension')
  })

  it('persists names across reopen, emits updates, and isolates new sessions', async () => {
    const { runtime, host } = await openFixture()
    const events: string[] = []
    runtime.subscribe(event => events.push(event.type))
    // A user message materializes the native history without requesting a model.
    runtime.session.sessionManager.appendMessage({ role: 'user', content: 'Inspect browser tools', timestamp: Date.now() })
    const file = runtime.session.sessionFile!
    await sessionNameTool(() => runtime.session).execute({ name: 'Inspect browser tools' })
    expect(runtime.snapshot().name).toBe('Inspect browser tools')
    expect(events).toContain('session_info_changed')
    expect(host.changed).toHaveBeenCalled()
    await runtime.newSession()
    expect(runtime.snapshot().name).toBeUndefined()
    await runtime.switchSession(file)
    expect(runtime.snapshot().name).toBe('Inspect browser tools')
    await sessionNameTool(() => runtime.session).execute({ name: 'Add browser integration tests' })
    await runtime.newSession()
    await runtime.switchSession(file)
    expect(runtime.snapshot().name).toBe('Add browser integration tests')
  })

  it('starts a conversation without a saved model the account cannot use', async () => {
    transport.call.mockImplementation(async (call: string) => (call === 'accounts.choices.get' ? { normal: { model: 'no-such-provider/unknown', effort: 'low', updatedAt: 'then' } } : {}))
    const { runtime } = await openFixture()
    expect(runtime.session.model?.provider).not.toBe('no-such-provider')
  })

  it('loads only explicit plugins and keeps events and commands alive across new, resume, fork and reload', async () => {
    const { runtime, args, root, cwd } = await openFixture()
    const first = runtime.session
    const firstFile = first.sessionFile!
    expect(first.systemPrompt).toContain('Fixed Harness context.')
    // Only the explicit plugin and the Harness's own inline extensions load: the bridge and the mode-choice recorder.
    expect(first.extensionRunner.getExtensionPaths()).toEqual([args[5], '<inline:harness-terminal-bridge>', '<inline:harness-mode-choices>'])
    expect(first.sessionManager.getEntries().filter((entry) => entry.type === 'custom').map((entry) => entry.data)).toEqual([{ mode: 'tui' }, { mode: 'tui' }])
    const events: string[] = []
    runtime.subscribe((event) => events.push(event.type))
    const replacements: string[] = []
    runtime.onSessionChange((session) => { replacements.push(session.sessionId) })
    const before = vi.fn()
    runtime.onBeforeSessionChange(before)
    await runtime.session.prompt('/marker first')
    // Native Pi keeps custom-entry-only sessions in memory until an assistant response. This
    // fixture persists its actual native entries without making a provider request.
    writeFileSync(firstFile, [first.sessionManager.getHeader(), ...first.sessionManager.getEntries()].map((entry) => JSON.stringify(entry)).join('\n') + '\n')
    expect(events).toContain('entry_appended')
    await runtime.newSession()
    expect(runtime.session).not.toBe(first)
    await runtime.session.prompt('/marker second')
    await runtime.switchSession(firstFile)
    expect(runtime.session.sessionFile).toBe(firstFile)
    const marker = runtime.session.sessionManager.getEntries().find((entry) => entry.type === 'custom' && entry.customType === 'marker')!
    await runtime.fork(marker.id, { position: 'at' })
    expect(runtime.session.sessionFile).not.toBe(firstFile)
    await runtime.reload()
    await runtime.session.prompt('/marker reloaded')
    expect(runtime.session.sessionManager.getEntries().some((entry) => entry.type === 'custom' && entry.customType === 'marker' && (entry.data as { text: string }).text === 'reloaded')).toBe(true)
    expect(replacements).toHaveLength(4)
    expect(before).toHaveBeenCalledTimes(4)
    expect(transport.claim).toHaveBeenCalledTimes(1)
    expect(transport.call.mock.calls.length).toBeGreaterThanOrEqual(6)
    // The account's saved model and effort are read when a conversation starts; nothing else is written here.
    expect(transport.call.mock.calls.every(([call]) => ['terminal.resources', 'terminal.interrupt', 'accounts.session', 'accounts.choices.get'].includes(call))).toBe(true)
    expect(readFileSync(firstFile, 'utf8')).toContain(cwd)
    expect(readdirSync(root)).not.toContain('.pi')
  })

  it('ignores retained plugin UI callbacks after new, reload and disposal', async () => {
    const { runtime, host } = await openFixture()
    const first = runtime.session.extensionRunner.createContext().ui
    const retainedNotify = first.notify
    first.notify('current')
    expect(host.ui.notify).toHaveBeenCalledWith('current')
    await runtime.newSession()
    retainedNotify('late from previous session')
    expect(host.ui.notify).toHaveBeenCalledTimes(1)
    expect(await first.select('Stale selector', ['One'])).toBeUndefined()
    const second = runtime.session.extensionRunner.createContext().ui
    second.notify('replacement')
    expect(host.ui.notify).toHaveBeenCalledTimes(2)
    await runtime.reload()
    second.notify('late from old resources')
    expect(host.ui.notify).toHaveBeenCalledTimes(2)
    const reloaded = runtime.session.extensionRunner.createContext().ui
    reloaded.notify('reloaded')
    expect(host.ui.notify).toHaveBeenCalledTimes(3)
    await runtime.dispose()
    reloaded.notify('late after exit')
    expect(host.ui.notify).toHaveBeenCalledTimes(3)
  })

  it('returns immutable presentation state and routes submissions through the persistent session', async () => {
    const { runtime } = await openFixture()
    const first = runtime.snapshot()
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.queue.steering)).toBe(true)
    expect(Object.isFrozen(first.context)).toBe(true)
    expect(first.account).toBeNull()
    await runtime.submit('   /marker from-runtime')
    runtime.session.setSessionName('Updated title')
    expect(first.name).toBeUndefined()
    expect(runtime.snapshot().name).toBe('Updated title')
    expect(runtime.session.sessionManager.getEntries().some(entry => entry.type === 'custom' && entry.customType === 'marker' && (entry.data as { text: string }).text === 'from-runtime')).toBe(true)
    await runtime.dispose()
    await expect(runtime.submit('late')).rejects.toThrow('closed')
  })

  it('sends attached images to the model in the same prompt', async () => {
    const { runtime } = await openFixture()
    const prompt = vi.spyOn(runtime.session, 'prompt').mockResolvedValue()
    const images = [{ type: 'image' as const, data: 'AAAA', mimeType: 'image/png' }]
    await runtime.submit('what is in [Image #1]?', false, images)
    expect(prompt).toHaveBeenCalledWith('what is in [Image #1]?', { images })
    await runtime.submit('plain')
    expect(prompt).toHaveBeenLastCalledWith('plain', {})
    await runtime.dispose()
  })

  it('aborts standalone Bash executions before settling the native session', async () => {
    const { runtime } = await openFixture()
    const session = runtime.session
    const abortBash = vi.spyOn(session, 'abortBash')
    const abort = vi.spyOn(session, 'abort')

    await runtime.interrupt()

    expect(abortBash).toHaveBeenCalledOnce()
    expect(abort).toHaveBeenCalledOnce()
  })

  it('refuses changed resource trust before invalidating the existing session or loading new code', async () => {
    const { runtime, plugin, root } = await openFixture()
    const existing = runtime.session
    const marker = join(root, 'untrusted-code-ran')
    writeFileSync(plugin, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'yes'); export default function () {}`)
    transport.call.mockRejectedValue(new Error('Plugin code changed; review and restart.'))
    await expect(runtime.reload()).rejects.toThrow('Plugin code changed')
    await expect(runtime.newSession()).rejects.toThrow('Plugin code changed')
    expect(runtime.session).toBe(existing)
    await runtime.session.prompt('/marker still-active')
    expect(readdirSync(root)).not.toContain('untrusted-code-ran')
    expect(runtime.session.extensionRunner.getCommand('marker')).toBeDefined()
    await expect(runtime.session.resourceLoader.reload()).rejects.toThrow('Plugin code changed')
    expect(readdirSync(root)).not.toContain('untrusted-code-ran')
  })

  it('rejects cross-project resume/import before copying files or replacing the pinned session', async () => {
    const { runtime, root, cwd, history } = await openFixture()
    const other = join(root, 'other-project')
    mkdirSync(other)
    const imported = join(history, 'other.jsonl')
    writeFileSync(imported, JSON.stringify({ type: 'session', version: 3, id: 'foreign', cwd: other, timestamp: new Date().toISOString() }) + '\n')
    const current = runtime.session
    const files = readdirSync(history)
    await expect(runtime.switchSession(imported)).rejects.toThrow('another working folder')
    await expect(runtime.importFromJsonl(imported, cwd)).rejects.toThrow('another working folder')
    expect(runtime.session).toBe(current)
    expect(readdirSync(history)).toEqual(files)
    expect(() => assertTerminalSessionScope(imported, cwd, other)).toThrow('own working folder')
  })

  it('rejects symlink escapes and same-project history outside the prepared history folder', async () => {
    const { runtime, root, cwd, history, args, host } = await openFixture()
    const external = join(root, 'external.jsonl')
    writeFileSync(external, JSON.stringify({ type: 'session', version: 3, id: 'external', cwd, timestamp: new Date().toISOString() }) + '\n')
    const symlink = join(history, 'escaped.jsonl')
    symlinkSync(external, symlink)
    const original = runtime.session
    await expect(runtime.switchSession(external)).rejects.toThrow('terminal history folder')
    await expect(runtime.switchSession(symlink)).rejects.toThrow('terminal history folder')
    await expect(createTerminalRuntime([...args, '--session', symlink], host)).rejects.toThrow('terminal history folder')
    expect(runtime.session).toBe(original)
    await runtime.importFromJsonl(external)
    expect(runtime.session.sessionManager.getHeader()?.id).toBe('external')
    expect(runtime.session.sessionFile).toBe(join(realpathSync(history), 'external.jsonl'))
  })

  it('starts a new conversation when the recorded history file was never written', async () => {
    // Pi writes a session file only after its first message, so a restart before that has nothing to resume.
    const f = fixture()
    const unwritten = join(f.history, 'not-written-yet.jsonl')
    const runtime = await createTerminalRuntime([...f.args, '--session', unwritten], f.host)
    runtimes.push(runtime)
    expect(runtime.session.sessionFile?.startsWith(realpathSync(f.history))).toBe(true)
    expect(runtime.session.sessionFile).not.toBe(unwritten)
  })

  it('requires the prepared isolated account and refuses malformed session headers', async () => {
    const f = fixture()
    vi.stubEnv('PI_CODING_AGENT_DIR', '')
    await expect(createTerminalRuntime(f.args, f.host)).rejects.toThrow('isolated account')
    const invalid = join(f.root, 'invalid.jsonl')
    writeFileSync(invalid, 'not a session\n')
    expect(() => assertTerminalSessionScope(invalid, f.cwd)).toThrow('readable native session header')
    writeFileSync(invalid, JSON.stringify({ type: 'session', cwd: 'relative' }))
    expect(() => assertTerminalSessionScope(invalid, f.cwd)).toThrow('absolute working folder')
  })

  it('loads the pinned rich renderers without opening a model or reading the clipboard', async () => {
    expect(() => assertPiAdapterVersion('1.3.0')).toThrow('requires Pi 1.2.0')
    const adapter = await loadPiAdapter()
    expect(adapter.builtins.map((item) => typeof item === 'function' ? '' : item.name)).toEqual(['llama.cpp', 'codemode', 'tool-search', 'mcp'])
    for (const name of ['read', 'bash', 'edit', 'write']) {
      const renderers = withBuiltInRenderers(name, undefined)
      expect(renderers?.renderCall).toBeTypeOf('function')
      expect(renderers?.renderResult).toBeTypeOf('function')
    }
    const custom = { renderCall: vi.fn() }
    expect(withBuiltInRenderers('read', custom)?.renderCall).toBe(custom.renderCall)
    expect(adapter.readClipboardText).toBeTypeOf('function')
    expect(adapter.readClipboardImage).toBeTypeOf('function')
  })
})
