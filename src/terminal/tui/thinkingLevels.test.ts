import { describe, expect, it } from 'vitest'

import { clampLevel, supportedLevels } from './thinkingLevels'

describe('the effort levels a model offers', () => {
  it('offers only off to a model that does not reason', () => {
    expect(supportedLevels({ reasoning: false })).toEqual(['off'])
    expect(supportedLevels(undefined)).toEqual(['off'])
  })

  it('stops at high unless the model maps xhigh or max', () => {
    expect(supportedLevels({ reasoning: true })).toEqual(['off', 'minimal', 'low', 'medium', 'high'])
    expect(supportedLevels({ reasoning: true, thinkingLevelMap: { xhigh: 'xhigh' } })).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh'])
    expect(supportedLevels({ reasoning: true, thinkingLevelMap: { xhigh: 'xhigh', max: 'max' } })).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('removes a level the model maps to null', () => {
    expect(supportedLevels({ reasoning: true, thinkingLevelMap: { off: null, minimal: null } })).toEqual(['low', 'medium', 'high'])
  })

  it('clamps an unsupported level to the nearest above, else the nearest below', () => {
    const noOff = { reasoning: true, thinkingLevelMap: { off: null, minimal: null } }
    expect(clampLevel(noOff, 'off')).toBe('low')
    expect(clampLevel({ reasoning: true }, 'max')).toBe('high')
    expect(clampLevel({ reasoning: true }, 'medium')).toBe('medium')
    expect(clampLevel({ reasoning: false }, 'high')).toBe('off')
  })
})
