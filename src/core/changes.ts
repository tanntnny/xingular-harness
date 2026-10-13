// A note that something in a Wiki was written: a fact, a memory block, or a page. The memory
// code calls `noteChange` after the file is in place; whoever wants to react listens. Listeners
// run inline and must only take the note down: a write never waits for, or fails with, a listener.
export interface Change {
  /** The Wiki folder the entry is in. */
  wiki: string
  id: string
  /** The file that was written. */
  path: string
  /** Its new contents, front matter included. */
  text: string
  actor: string
  reason: string
}

type Listener = (change: Change) => void

const listeners = new Set<Listener>()

export function noteChange(change: Change): void {
  for (const listener of listeners) {
    try {
      listener(change)
    } catch {
      // A listener must never break the write it is told about.
    }
  }
}

export function onChange(listener: Listener): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}
