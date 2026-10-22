import { describe, expect, it } from 'vitest'

import { splitBashDraft } from './bashMode'

describe('Bash mode drafts', () => {
  it('takes a leading ! as the mode marker and keeps the command', () => {
    expect(splitBashDraft('!ls -la')).toEqual({ body: 'ls -la', bashMode: true })
    expect(splitBashDraft('  !pwd')).toEqual({ body: 'pwd', bashMode: true })
    expect(splitBashDraft('!')).toEqual({ body: '', bashMode: true })
  })

  it('leaves an ordinary draft alone and keeps a later ! as command text', () => {
    expect(splitBashDraft('explain this')).toEqual({ body: 'explain this', bashMode: false })
    expect(splitBashDraft('')).toEqual({ body: '', bashMode: false })
    expect(splitBashDraft('echo ok!')).toEqual({ body: 'echo ok!', bashMode: false })
  })

  it('lets the command itself start with ! after the mode marker', () => {
    expect(splitBashDraft('!!important')).toEqual({ body: '!important', bashMode: true })
  })
})
