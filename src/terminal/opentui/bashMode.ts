export interface BashDraft {
  /** The command without its `!` prefix, which the composer marker carries instead. */
  body: string
  bashMode: boolean
}

/** Enter Bash mode from a draft that starts with `!`, as the Pi composer does. */
export function splitBashDraft(value: string): BashDraft {
  const bang = /^\s*!/u.exec(value)
  return bang
    ? { body: value.slice(bang[0].length), bashMode: true }
    : { body: value, bashMode: false }
}
