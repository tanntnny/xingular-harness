import { describe, expect, it } from 'vitest'

import { createEnv, DEFAULT_PRODUCT_NAME } from './env'

describe('Harness environment', () => {
  it('uses Xingular Agent as the default product identity', () => {
    expect(DEFAULT_PRODUCT_NAME).toBe('Xingular Agent')
    expect(createEnv('/data').productName).toBe('Xingular Agent')
  })

  it('keeps an explicitly supplied product identity', () => {
    expect(createEnv('/data', { productName: 'Example Product' }).productName).toBe('Example Product')
  })
})
