import { describe, expect, it } from 'vitest'

import { leadingSlashCommandRange, splitUserMessageText } from './slashCommandHighlight'

describe('slash command highlighting', () => {
  const names = ['help', 'side', 'plugin:notes', 'review', 'skill:diagnose']

  it('recognizes a registered leading token after whitespace and excludes its arguments', () => {
    expect(leadingSlashCommandRange('  /plugin:notes inspect this', names)).toEqual({
      start: 2, end: 15, name: 'plugin:notes'
    })
  })

  it('keeps unknown, partial and non-leading slash tokens unrecognized', () => {
    expect(leadingSlashCommandRange('/helpful argument', names)).toBeUndefined()
    expect(leadingSlashCommandRange('hello /help', names)).toBeUndefined()
    expect(leadingSlashCommandRange('/unknown argument', names)).toBeUndefined()
  })

  it('splits user messages into command, ordinary text and attachment spans', () => {
    expect(splitUserMessageText('/review inspect [Image #2]', names)).toEqual([
      { kind: 'command', text: '/review' },
      { kind: 'text', text: ' inspect ' },
      { kind: 'attachment', text: '[Image #2]' }
    ])
  })

  it('leaves unknown command-like text and image-label styling independent', () => {
    expect(splitUserMessageText('/typo [Image #1]', names)).toEqual([
      { kind: 'text', text: '/typo ' },
      { kind: 'attachment', text: '[Image #1]' }
    ])
    expect(splitUserMessageText('/skill:diagnose trace', names)[0]).toEqual({
      kind: 'command', text: '/skill:diagnose'
    })
  })
})
