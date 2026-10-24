import { describe, expect, it } from 'vitest'

import { homeBrand } from './homeBrand'

describe('welcome product branding', () => {
  it('renders the default product as X and letter-spaced AGENT', () => {
    expect(homeBrand('Xingular Agent')).toEqual({ mark: 'X', subline: 'A G E N T' })
  })

  it('keeps host-provided product names generic', () => {
    expect(homeBrand('Example Workspace')).toEqual({ mark: 'E', subline: 'W O R K S P A C E' })
  })

  it('uses a single-word product name as the mark', () => {
    expect(homeBrand('Harness')).toEqual({ mark: 'HARNESS', subline: '' })
  })
})
