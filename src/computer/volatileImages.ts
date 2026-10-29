import type { SessionManager } from '@earendil-works/pi-coding-agent'

type StoredMessage = Parameters<SessionManager['appendMessage']>[0]
type Block = { type: string; [key: string]: unknown }
type Message = { role?: string; toolName?: string; toolCallId?: string; content?: unknown; [key: string]: unknown }

/** Keeps approved-window image bytes out of Pi's session manager. The owner must apply `restore`
 * only to a model-request context and call `clear` on run termination. This does not protect host
 * logs, provider retention, event listeners or other capture tools. */
export function volatileComputerImages(manager: SessionManager) {
  const images = new Map<string, Block[]>()
  const append = manager.appendMessage.bind(manager)
  const original = manager.appendMessage
  const replacement: SessionManager['appendMessage'] = (value) => {
    const message = value as unknown as Message
    if (message.role !== 'toolResult' || message.toolName !== 'computer_screenshot' || typeof message.toolCallId !== 'string' || !Array.isArray(message.content)) return append(value)
    const content = message.content as Block[]
    const captured = content.filter(block => block?.type === 'image')
    images.delete(message.toolCallId)
    if (captured.length) {
      images.set(message.toolCallId, captured.map(block => ({ ...block })))
      while (images.size > 6) images.delete(images.keys().next().value!)
    }
    const clean = {
      role: 'toolResult',
      toolName: 'computer_screenshot',
      toolCallId: message.toolCallId,
      content: [{ type: 'text', text: '[Window capture omitted from saved history.]' }],
      isError: message.isError === true,
      timestamp: typeof message.timestamp === 'number' ? message.timestamp : Date.now()
    }
    return append(clean as StoredMessage)
  }
  manager.appendMessage = replacement
  return {
    restore<T>(messages: readonly T[]): T[] {
      return messages.map(value => {
        const message = value as Message
        if (message.role !== 'toolResult' || message.toolName !== 'computer_screenshot' || typeof message.toolCallId !== 'string') return value
        const captured = images.get(message.toolCallId)
        if (!captured || !Array.isArray(message.content)) return value
        return { ...message, content: [...message.content, ...captured.map(block => ({ ...block }))] } as T
      })
    },
    clear(): void { images.clear() },
    dispose(): void {
      images.clear()
      if (manager.appendMessage === replacement) manager.appendMessage = original
    }
  }
}
