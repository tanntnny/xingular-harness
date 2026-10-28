import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { terminalKeybindings } from './keybindings'

it('steps thinking effort on shift arrows', () => {
  const manager = terminalKeybindings('/unused/isolated-account')
  expect(manager.matches('\x1b[1;2A', 'app.thinking.increase')).toBe(true)
  expect(manager.matches('\x1b[1;2B', 'app.thinking.decrease')).toBe(true)
  expect(manager.matches('\x1b[Z', 'app.thinking.cycle')).toBe(false)
})

it('steers on Cmd, Ctrl or Alt+Enter and leaves plain Enter to queue', () => {
  const manager = terminalKeybindings('/unused/isolated-account')
  expect(manager.matches('\x1b[13;9u', 'app.message.steer')).toBe(true)
  expect(manager.matches('\x1b[13;5u', 'app.message.steer')).toBe(true)
  expect(manager.matches('\x1b[13;3u', 'app.message.steer')).toBe(true)
  expect(manager.matches('\r', 'app.message.steer')).toBe(false)
})

it('reloads edited isolated keybindings on the existing public manager', () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-keybindings-'))
  try {
    const file = join(root, 'keybindings.json')
    writeFileSync(file, JSON.stringify({ 'app.model.select': 'ctrl+k' }))
    const manager = terminalKeybindings(root)
    expect(manager.matches('\x0b', 'app.model.select')).toBe(true)
    writeFileSync(file, JSON.stringify({ 'app.model.select': 'ctrl+y' }))
    manager.reload()
    expect(manager.matches('\x0b', 'app.model.select')).toBe(false)
    expect(manager.matches('\x19', 'app.model.select')).toBe(true)
    writeFileSync(file, '{}')
    manager.reload()
    expect(manager.matches('\x0c', 'app.model.select')).toBe(true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
