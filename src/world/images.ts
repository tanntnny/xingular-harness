// Screenshots are the most expensive thing a run sends. Only the most recent ones stay in what
// the model sees; older ones become a line of text. The cut moves in steps of four, so the
// earlier messages, and the provider's cache of them, change only every fourth screenshot.

/** Images kept before pruning starts. */
export const KEEP_IMAGES = 6
/** How far the cut moves at a time. */
export const PRUNE_STEP = 4

interface Block { type: string; [key: string]: unknown }
interface Message { role?: string; content?: unknown; [key: string]: unknown }

/** Index of the first tool image that stays, of `count` in the transcript. */
export function firstKept(count: number): number {
  if (count <= KEEP_IMAGES) return 0
  return Math.floor((count - 3) / PRUNE_STEP) * PRUNE_STEP
}

/** The messages with older tool-result images replaced by a placeholder. Returns the input unchanged when nothing is pruned. */
export function pruneToolImages<T extends Message>(messages: readonly T[]): T[] {
  let count = 0
  for (const message of messages) if (message.role === 'toolResult' && Array.isArray(message.content)) count += (message.content as Block[]).filter((block) => block?.type === 'image').length
  const keepFrom = firstKept(count)
  if (!keepFrom) return messages as T[]
  let index = 0
  return messages.map((message) => {
    if (message.role !== 'toolResult' || !Array.isArray(message.content)) return message
    let changed = false
    const content = (message.content as Block[]).map((block) => {
      if (block?.type !== 'image') return block
      const position = index++
      if (position >= keepFrom) return block
      changed = true
      return { type: 'text', text: `[screenshot ${position + 1} omitted: only the latest are kept]` }
    })
    return changed ? { ...message, content } : message
  })
}

/** A Pi extension factory that prunes before every model request. */
export function imagePruning(): (pi: { on(event: 'context', handler: (event: { messages: Message[] }) => unknown): void }) => void {
  return (pi) => {
    pi.on('context', (event) => {
      const messages = pruneToolImages(event.messages)
      return messages === event.messages ? undefined : { messages }
    })
  }
}
