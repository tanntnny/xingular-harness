import { describe, expect, it } from 'vitest'

import { toastLayout } from './toastLayout'

describe('toastLayout', () => {
  it('anchors the full copy message at the top-right with room for padding', () => {
    expect(toastLayout('Copied to clipboard', 40)).toEqual({
      message: 'Copied to clipboard', top: 0, right: 1, width: 21
    })
  })

  it('uses a compact readable message on narrow terminals', () => {
    expect(toastLayout('Copied to clipboard', 20)).toEqual({
      message: 'Copied', top: 0, right: 1, width: 8
    })
  })

  it('omits the toast when there is not enough room to render it', () => {
    expect(toastLayout('Copied to clipboard', 9)).toBeUndefined()
  })
})
