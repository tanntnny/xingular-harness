import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionManager } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'

import { clone, exportJsonl, fork, lastReply, navigate, rename, tree } from './control'

const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() }) as never
const assistant = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }], api: 'x', provider: 'p', model: 'm', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() }) as never

function conversation() {
  const root = mkdtempSync(join(tmpdir(), 'xh-control-'))
  const sessionDir = join(root, 'pi')
  const manager = SessionManager.create(root, sessionDir)
  const first = manager.appendMessage(user('first question'))
  manager.appendMessage(assistant('first answer'))
  const second = manager.appendMessage(user('second question'))
  manager.appendMessage(assistant('second answer'))
  return { root, sessionDir, file: manager.getSessionFile()!, first, second }
}

describe('session control', () => {
  it('lists the tree and the points a fork may start from', () => {
    const { sessionDir, first, second } = conversation()
    const result = tree({ sessionDir })
    expect(result.entries.map((entry) => entry.text)).toEqual(['first question', 'first answer', 'second question', 'second answer'])
    expect(result.forkPoints.map((point) => point.entryId)).toEqual([first, second])
  })

  it('navigates to before a message, keeps the move, and gives its text back', () => {
    const { sessionDir, second } = conversation()
    const moved = navigate({ sessionDir, entryId: second })
    expect(moved.editorText).toBe('second question')
    expect(lastReply({ sessionDir }).text).toBe('first answer')
  })

  it('forks and clones into another folder', () => {
    const { root, sessionDir, second } = conversation()
    const forked = fork({ sessionDir, entryId: second, targetDir: join(root, 'fork') })
    expect(forked.editorText).toBe('second question')
    expect(lastReply({ sessionDir: join(root, 'fork') }).text).toBe('first answer')
    const cloned = clone({ sessionDir, targetDir: join(root, 'clone') })
    expect(readdirSync(join(root, 'clone'))).toHaveLength(1)
    expect(lastReply({ sessionDir: join(root, 'clone'), sessionFile: cloned.sessionFile }).text).toBe('second answer')
  })

  it('names a session and exports its branch', () => {
    const { root, sessionDir } = conversation()
    rename({ sessionDir, name: 'Review' })
    expect(tree({ sessionDir }).entries.some((entry) => entry.type === 'session_info' && entry.text === 'Review')).toBe(true)
    const path = join(root, 'out.jsonl')
    exportJsonl({ sessionDir, path })
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(6)
  })

  it('refuses a history outside the session folder', () => {
    const { sessionDir } = conversation()
    const other = conversation()
    expect(() => tree({ sessionDir, sessionFile: other.file })).toThrow(/session folder/)
  })
})
