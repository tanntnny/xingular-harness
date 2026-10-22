import { describe, expect, it, vi } from 'vitest'

import { sessionNameTool } from './sessionName'
import { planModeTools, planRefusal } from '../sessions/planMode'

describe('session naming', () => {
  it('normalizes a six-word sentence, revises manual names and avoids duplicate writes', async () => {
    const session = { sessionName: 'My manually assigned name', setSessionName: vi.fn((name: string) => { session.sessionName = name }) }
    const tool = sessionNameTool(() => session)
    const name = 'Add web browser integrations for agents'
    await expect(tool.execute({ name: '  Add  web\nbrowser integrations for agents  ' })).resolves.toBe(`Session name: ${name}`)
    await tool.execute({ name })
    expect(session.sessionName).toBe(name)
    expect(session.setSessionName).toHaveBeenCalledExactlyOnceWith(name)
  })

  it.each([undefined, 42, '', '   ', 'Add web browser integrations for all agents', '\u001b[31mUnsafe name', 'Unsafe\u0000name', 'Unsafe\u009bname'])('rejects invalid names without changing history: %j', async name => {
    const session = { setSessionName: vi.fn() }
    await expect(sessionNameTool(() => session).execute({ name })).rejects.toThrow()
    expect(session.setSessionName).not.toHaveBeenCalled()
  })

  it('reports an unavailable native session', async () => {
    await expect(sessionNameTool(() => undefined).execute({ name: 'Inspect browser tools' })).rejects.toThrow('native session is unavailable')
  })

  it('keeps naming available in plan mode without permitting file writes', () => {
    expect(planModeTools(['read', 'session_name', 'write'])).toEqual(['read', 'session_name'])
    expect(planRefusal('session_name', new Set())).toBeNull()
    expect(planRefusal('write', new Set())).toContain('research-only')
  })
})
