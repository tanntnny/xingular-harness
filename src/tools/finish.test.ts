import { describe, expect, it } from 'vitest'

import { checkFinish, finishTool, openItems } from './finish'
import { createStopGateState } from '../sessions/stopGate'
import type { TodoItem } from '../sessions/contracts'

const todo: TodoItem[] = [{ text: 'Write the migration', status: 'completed' }, { text: 'Apply it locally', status: 'in_progress' }]

describe('finish', () => {
  it('refuses done while any todo item is open, naming the items', () => {
    const checked = checkFinish({ status: 'done' }, todo)
    expect(checked).toMatchObject({ ok: false })
    if (!checked.ok) expect(checked.error).toContain('1 todo item is still open — Apply it locally')
    expect(checkFinish({ status: 'done' }, [{ text: 'Apply it locally', status: 'completed' }])).toEqual({ ok: true, value: { status: 'done', reason: '', needs: '' } })
    expect(checkFinish({ status: 'done' }, [])).toMatchObject({ ok: true })
  })

  it('needs a reason to stop with work open, and bounds it', () => {
    expect(checkFinish({ status: 'blocked' }, todo)).toMatchObject({ ok: false })
    expect(checkFinish({ status: 'needs_decision', reason: '   ' }, todo)).toMatchObject({ ok: false })
    expect(checkFinish({ status: 'blocked', reason: 'x'.repeat(501) }, todo)).toMatchObject({ ok: false })
    expect(checkFinish({ status: 'paused', reason: 'later' }, todo)).toMatchObject({ ok: false })
    expect(checkFinish(null, todo)).toMatchObject({ ok: false })
    expect(checkFinish({ status: 'blocked', reason: ' No database access. ', needs: ' Grant read access. ' }, todo))
      .toEqual({ ok: true, value: { status: 'blocked', reason: 'No database access.', needs: 'Grant read access.' } })
  })

  it('records an accepted declaration in the gate state, and nothing for a refused one', async () => {
    const state = createStopGateState(todo)
    const tool = finishTool(state)
    expect(tool.readOnly).toBe(true)
    expect(tool.planModeSafe?.({})).toBe(true)
    expect(await tool.execute({ status: 'done' })).toContain('Not finished')
    expect(state.finish).toBeNull()
    expect(await tool.execute({ status: 'blocked', reason: 'The staging API is down.' })).toContain('Recorded: blocked — The staging API is down.')
    expect(state.finish).toEqual({ status: 'blocked', reason: 'The staging API is down.', needs: '' })
  })

  it('treats only completed items as finished', () => {
    expect(openItems(todo).map((item) => item.text)).toEqual(['Apply it locally'])
    expect(openItems([{ text: 'a', status: 'pending' }])).toHaveLength(1)
  })

  it('tells the model it is no pause button', () => {
    const description = finishTool(createStopGateState()).description
    expect(description).toContain('Never call it to pause work you can still do')
    expect(description).toContain('status done is refused while any todo item is open')
  })
})
