import { describe, expect, it } from 'vitest'

import { blendHexColor, composerRuleColor, opentuiTheme } from './theme'

describe('theme color blending', () => {
  it('blends the warm primary and warning colors smoothly', () => {
    expect(blendHexColor(opentuiTheme.primary, opentuiTheme.warning, 0.5)).toBe('#f4c391')
  })

  it('clamps the blend amount and keeps invalid colors unchanged', () => {
    expect(blendHexColor(opentuiTheme.primary, opentuiTheme.warning, 2)).toBe(opentuiTheme.warning)
    expect(blendHexColor('red', opentuiTheme.warning, 1)).toBe('red')
  })
})

describe('question colors', () => {
  it('uses a subtle dark-green selected row and a filled green primary action', () => {
    expect(opentuiTheme.questionSelectedBg).toBe('#193322')
    expect(opentuiTheme.questionActionBg).toBe('#35754a')
    expect(opentuiTheme.questionActionText).toBe('#f7fff8')
  })
})

describe('composer rule color', () => {
  it('uses the matching mode color for Bash and plan mode', () => {
    expect(composerRuleColor(opentuiTheme, { bash: true, plan: false, overlay: false })).toBe(opentuiTheme.bashMode)
    expect(composerRuleColor(opentuiTheme, { bash: false, plan: true, overlay: false })).toBe(opentuiTheme.planMode)
  })

  it('matches the normal divider color, including while an overlay is open', () => {
    expect(composerRuleColor(opentuiTheme, { bash: false, plan: false, overlay: false })).toBe(opentuiTheme.dim)
    expect(composerRuleColor(opentuiTheme, { bash: false, plan: false, overlay: true })).toBe(opentuiTheme.border)
  })
})
