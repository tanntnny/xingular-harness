/**
 * One selection palette for every terminal surface. A selected row is a muted blue field with
 * explicit near-white text, so the accent colour never sits on the selection background.
 */
export const SELECTION_COLORS = {
  dark: {
    background: '#1b314d',
    text: '#f4f8ff',
    muted: '#c4d3e6'
  },
  light: {
    background: '#dbe8fa',
    text: '#10233a',
    muted: '#455a72'
  }
} as const
