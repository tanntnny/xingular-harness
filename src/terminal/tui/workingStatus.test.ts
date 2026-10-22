import { describe, expect, it } from 'vitest'

import {
  chooseCompletionVerb,
  chooseWorkingVerb,
  COMPLETION_VERBS,
  createCompletionStatus,
  formatWorkingDuration,
  getWorkingSpinnerFrames,
  SPINNER_INTERVAL_MS,
  spinnerFrameAt,
  WORKING_VERBS
} from './workingStatus'

describe('Claude-style working status', () => {
  it('keeps the full default verb set and selects a stable value from one random sample', () => {
    expect(WORKING_VERBS).toHaveLength(188)
    expect(WORKING_VERBS).toContain('Thundering')
    expect(WORKING_VERBS).toContain('Wandering')
    expect(chooseWorkingVerb(() => 0)).toBe('Accomplishing')
    expect(chooseWorkingVerb(() => 1)).toBe('Zigzagging')
  })

  it('animates the same glyph sequence, with the Ghostty-compatible ending', () => {
    expect(getWorkingSpinnerFrames()).toEqual(['·', '✢', '✳', '✶', '✻', '✽', '✽', '✻', '✶', '✳', '✢', '·'])
    expect(getWorkingSpinnerFrames('xterm-ghostty')).toEqual(['·', '✢', '✳', '✶', '✻', '✻', '✻', '✻', '✶', '✳', '✢', '·'])
    expect(getWorkingSpinnerFrames('xterm-kitty')).toEqual(['·', '✢', '✳', '✶', '✻', '✽', '✽', '✻', '✶', '✳', '✢', '·'])
    const frames = getWorkingSpinnerFrames()
    expect(SPINNER_INTERVAL_MS).toBe(80)
    expect(spinnerFrameAt(0, frames)).toBe('·')
    expect(spinnerFrameAt(80, frames)).toBe('✢')
    expect(spinnerFrameAt(12 * SPINNER_INTERVAL_MS, frames)).toBe('·')
    expect(spinnerFrameAt(-1, frames)).toBe('·')
    expect(spinnerFrameAt(0, [])).toBe('')
  })

  it('keeps the completion verb deterministic and formats elapsed time', () => {
    const turnId = 'turn-uuid'
    expect(COMPLETION_VERBS).toHaveLength(8)
    expect(chooseCompletionVerb(turnId)).toBe(chooseCompletionVerb(turnId))
    expect(formatWorkingDuration(65_900)).toBe('1m 5s')
    expect(formatWorkingDuration(120_000)).toBe('2m')
    expect(formatWorkingDuration(-100)).toBe('0s')
    expect(createCompletionStatus(turnId, 65_900)).toBe('✻ ' + chooseCompletionVerb(turnId) + ' for 1m 5s')
  })
})
