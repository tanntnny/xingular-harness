import { describe, expect, it } from 'vitest'

import { prependSearchPath } from './path'

describe('search paths', () => {
  it('uses Windows separators and keeps the inherited PATH key casing', () => {
    expect(prependSearchPath('C:\\Harness\\bin', 'C:\\Windows\\System32;C:\\Node', { Path: 'C:\\Windows\\System32;C:\\Node' }, 'win32'))
      .toEqual({ Path: 'C:\\Harness\\bin;C:\\Windows\\System32;C:\\Node' })
  })

  it('uses the platform default key when the environment has no PATH entry', () => {
    expect(prependSearchPath('/harness/bin', '/usr/bin', {}, 'linux')).toEqual({ PATH: '/harness/bin:/usr/bin' })
  })
})
