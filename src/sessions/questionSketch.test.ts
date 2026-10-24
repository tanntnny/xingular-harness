import { describe, expect, it } from 'vitest'

import { QUESTION_SKETCH_MAX_LENGTH, questionSketchSchema, questionSketchError } from './contracts'

describe('contextual ASCII sketch contract', () => {
  it('accepts the exact 80 by 24 boundary and preserves literal whitespace', () => {
    const sketch = Array(24).fill('x'.repeat(80)).join('\n')
    expect(QUESTION_SKETCH_MAX_LENGTH).toBe(1943)
    expect(questionSketchSchema.parse(sketch)).toBe(sketch)
    const old = '+---+\n| A | \n\n+---+'
    expect(questionSketchSchema.parse(old)).toBe(old)
  })

  it.each(['x'.repeat(81), Array(25).fill('x').join('\n'), '', ' \n  ', '\t', 'x\r\ny', '\x1b[31mx', '\x00', 'café'])('rejects invalid content %j', sketch => {
    expect(questionSketchSchema.safeParse(sketch).success).toBe(false)
  })

  it('keeps all-or-none sketch metadata validation', () => {
    expect(questionSketchError(true, [{ sketch: 'panel' }, {}])).toContain('every choice')
    expect(questionSketchError(undefined, [{ sketch: 'panel' }])).toContain('uiSketch: true')
    expect(questionSketchError(true, [{ sketch: 'panel' }])).toBeUndefined()
    expect(questionSketchError(undefined, [{}])).toBeUndefined()
  })
})
