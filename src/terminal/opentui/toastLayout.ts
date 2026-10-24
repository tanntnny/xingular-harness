export interface ToastLayout {
  message: string
  top: 0
  right: 1
  width: number
}

export function toastLayout(message: string, terminalWidth: number): ToastLayout | undefined {
  if (!message || !Number.isFinite(terminalWidth) || terminalWidth < 10) return undefined

  const visibleMessage = terminalWidth < message.length + 4 ? 'Copied' : message
  return {
    message: visibleMessage,
    top: 0,
    right: 1,
    width: Math.min(visibleMessage.length + 2, terminalWidth - 2)
  }
}
