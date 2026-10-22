import { describe, expect, it } from 'vitest'

import { PlanChoice } from './planChoice'

describe('PlanChoice', () => {
  it('offers nothing until a plan is shown, and clears on request', () => {
    const choice = new PlanChoice()
    expect(choice.view).toBeNull()
    expect(choice.handle({ name: 'return' }, true)).toBeNull()

    choice.show('Fix login')
    expect(choice.view).toEqual({ title: 'Fix login', index: 0 })
    choice.clear()
    expect(choice.view).toBeNull()
  })

  it('moves between the two rows and wraps around', () => {
    const choice = new PlanChoice()
    choice.show('Fix login')
    expect(choice.handle({ name: 'down' }, true)).toBe('moved')
    expect(choice.view?.index).toBe(1)
    choice.handle({ name: 'down' }, true)
    expect(choice.view?.index).toBe(0)
    choice.handle({ name: 'up' }, true)
    expect(choice.view?.index).toBe(1)
  })

  it('selects a plan row directly and rejects unavailable rows', () => {
    const choice = new PlanChoice()
    choice.show('Fix login')
    expect(choice.select(1)).toBe(true)
    expect(choice.view?.index).toBe(1)
    expect(choice.select(2)).toBe(false)
    expect(choice.view?.index).toBe(1)
  })

  it('confirms the selected row on Enter, only while the draft is empty', () => {
    const choice = new PlanChoice()
    choice.show('Fix login')
    expect(choice.handle({ name: 'return' }, true)).toBe('implement')
    expect(choice.handle({ name: 'enter' }, true)).toBe('implement')

    choice.handle({ name: 'down' }, true)
    expect(choice.handle({ name: 'return' }, true)).toBe('edit')

    expect(choice.handle({ name: 'return' }, false)).toBeNull()
    expect(choice.handle({ name: 'down' }, false)).toBeNull()
  })

  it('dismisses on Escape and passes every other key to the composer', () => {
    const choice = new PlanChoice()
    choice.show('Fix login')
    expect(choice.handle({ name: 'a' }, true)).toBeNull()
    expect(choice.handle({ name: 'escape' }, true)).toBe('dismiss')
  })
})
