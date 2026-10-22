import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'

import { workingLineParts, workingLineText, workingVerbShimmerProfile } from './workingLine'

describe('working line display', () => {
  it('shows the active verb with run duration and latest response speed', () => {
    expect(workingLineText({
      active: true,
      frame: '✢',
      label: 'Brewing',
      elapsedMs: 65_900,
      tokensPerSecond: 28.6
    })).toBe('✢ Brewing (1m 5s, 29 tok/s)')
  })

  it('appends a name after metrics for active and completed work', () => {
    const state = { active: true, frame: '✢', label: 'Working', elapsedMs: 120_000, tokensPerSecond: 50, sessionName: 'Add web browser integrations' }
    expect(workingLineText(state)).toBe('✢ Working (2m, 50 tok/s) – Add web browser integrations')
    expect(workingLineParts(state).label).toBe('Working')
    expect(workingVerbShimmerProfile(state)).toHaveLength('Working'.length)
    expect(workingLineText({ ...state, active: false, frame: '', label: '✻ Cooked' })).toBe('✻ Cooked (2m, 50 tok/s) – Add web browser integrations')
    expect(workingLineText({ ...state, sessionName: '  ' })).toBe('✢ Working (2m, 50 tok/s)')
    expect(workingLineText({ ...state, label: '', frame: '', active: false })).toBe('')
  })

  it('truncates the trailing name while preserving metrics in narrow terminals', () => {
    const state = { active: true, frame: '✢', label: 'Working', elapsedMs: 120_000, tokensPerSecond: 50, sessionName: 'Add web browser integrations' }
    const fitted = workingLineText(state, 36)
    expect(fitted).toMatch(/^✢ Working \(2m, 50 tok\/s\) – Add/)
    expect(fitted.endsWith('…')).toBe(true)
    expect(visibleWidth(fitted)).toBeLessThanOrEqual(36)
    expect(workingLineText({ ...state, sessionName: '調査する ブラウザ 機能' }, 36)).toContain('tok/s) – ')
    expect(visibleWidth(workingLineText({ ...state, sessionName: '調査する ブラウザ 機能' }, 36))).toBeLessThanOrEqual(36)
    expect(workingLineText(state, 0)).toBe('')
    expect(visibleWidth(workingLineText(state, 8))).toBeLessThanOrEqual(8)
  })

  it('sanitizes legacy manual names before terminal rendering', () => {
    expect(workingLineText({ active: true, frame: '', label: 'Working', elapsedMs: null, tokensPerSecond: null, sessionName: '\u001b[31mAdd\n browser' })).toBe('Working – Add browser')
  })

  it('splits the active spinner, verb and metrics for separate rendering', () => {
    expect(workingLineParts({
      active: true,
      frame: '✢',
      label: 'Brewing',
      elapsedMs: 65_900,
      tokensPerSecond: 28.6
    })).toEqual({
      prefix: '✢ ',
      label: 'Brewing',
      suffix: ' (1m 5s, 29 tok/s)'
    })
  })

  it('feathers a warm shimmer across the verb without reversing at its ends', () => {
    const state = {
      active: true,
      frame: '✢',
      label: 'Brewing',
      elapsedMs: 0,
      tokensPerSecond: null
    }
    expect(workingVerbShimmerProfile(state)).toEqual([0, 0, 0, 0, 0, 0, 0])

    const entering = workingVerbShimmerProfile({ ...state, elapsedMs: 120 })
    expect(entering[0]).toBeGreaterThan(0)
    expect(entering[0]).toBeLessThan(1)

    const atStart = workingVerbShimmerProfile({ ...state, elapsedMs: 360 })
    expect(atStart[0]).toBe(1)
    expect(atStart[1]).toBeCloseTo(0.74)
    expect(workingVerbShimmerProfile({ ...state, elapsedMs: 480 })[1]).toBe(1)
    expect(workingVerbShimmerProfile({ ...state, elapsedMs: 1440 })).toEqual([0, 0, 0, 0, 0, 0, 0])
    expect(workingVerbShimmerProfile({ ...state, elapsedMs: 1560 })).toEqual([0, 0, 0, 0, 0, 0, 0])
  })

  it('does not shimmer completed statuses or an empty active label', () => {
    expect(workingVerbShimmerProfile({
      active: false,
      frame: '',
      label: '✻ Cooked',
      elapsedMs: 5000,
      tokensPerSecond: null
    })).toEqual([])
    expect(workingVerbShimmerProfile({
      active: true,
      frame: '✢',
      label: '',
      elapsedMs: 5000,
      tokensPerSecond: null
    })).toEqual([])
  })

  it('shows the completed run duration and a placeholder before response usage arrives', () => {
    expect(workingLineText({
      active: false,
      frame: '',
      label: '✻ Cooked',
      elapsedMs: 5000,
      tokensPerSecond: null
    })).toBe('✻ Cooked (5s, — tok/s)')
  })

  it('omits run metrics for a status without a run', () => {
    expect(workingLineText({
      active: false,
      frame: '',
      label: 'Starting session…',
      elapsedMs: null,
      tokensPerSecond: null
    })).toBe('Starting session…')
  })

  it('omits idle effort and tool details when there is no status', () => {
    expect(workingLineText({
      active: false,
      frame: '',
      label: '',
      elapsedMs: null,
      tokensPerSecond: null
    })).toBe('')
  })
})
