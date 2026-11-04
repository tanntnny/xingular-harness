import { inspect } from 'node:util'

import { createCliRenderer, RGBA } from '@opentui/core'
import { render, RendererContext } from '@opentui/solid'

import { DEFAULT_PRODUCT_NAME } from '../../core/env'
import { OpenTuiApplication } from './app'
import { hoveredLinkCells, paintLinkCells } from './linkHover'
import { OpenTuiRoot } from './root'
import { opentuiTheme } from './theme'

const app = new OpenTuiApplication(process.argv.slice(2))
const productName = (process.env.XINGULAR_HARNESS_NAME ?? '')
  .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim() || DEFAULT_PRODUCT_NAME
// The terminal belongs to the renderer. A library that calls `console.warn` or `console.error` while
// it draws prints over the screen and leaves it garbled, so hold that output and show it after exit.
const printError = console.error.bind(console)
const heldConsole: string[] = []
const holdConsole = (...args: unknown[]) => {
  if (heldConsole.length < 50) heldConsole.push(args.map(arg => arg instanceof Error ? (arg.stack ?? arg.message) : typeof arg === 'string' ? arg : inspect(arg)).join(' '))
}
console.log = console.info = console.debug = console.warn = console.error = holdConsole
const renderer = await createCliRenderer({
  screenMode: 'alternate-screen',
  exitOnCtrlC: false,
  exitSignals: [],
  useMouse: true,
  enableMouseMovement: true,
  targetFps: 60,
  maxFps: 120,
  autoFocus: true,
  clearOnShutdown: true,
  consoleMode: 'disabled',
  openConsoleOnError: false,
  backgroundColor: 'transparent'
})
// The Harness handles link clicks itself, so Markdown should conceal destinations even when the
// terminal does not advertise OSC 8 support. OSC 8 metadata is still emitted where available.
const enableMarkdownHyperlinks = (capabilities: NonNullable<typeof renderer.capabilities>) => {
  capabilities.hyperlinks = true
}
if (renderer.capabilities) enableMarkdownHyperlinks(renderer.capabilities)
renderer.on('capabilities', enableMarkdownHyperlinks)
app.attachRenderer({
  suspend: () => renderer.suspend(),
  resume: () => renderer.resume(),
  setTitle: title => renderer.setTerminalTitle(title),
  setMousePointer: style => renderer.setMousePointer(style),
  getLinkAt: (x, y) => renderer.getLinkAt(x, y),
  getLinkIdAt: (x, y) => renderer.getLinkIdAt(x, y),
  requestRender: () => renderer.requestRender(),
  destroy: () => renderer.destroy()
})
app.setStopHandler(() => renderer.destroy())
// A link under the pointer is repainted in the hover colour once the frame is composed.
const linkHoverColor = RGBA.fromHex(opentuiTheme.linkHover)
renderer.addPostProcessFn(buffer => {
  const highlight = app.linkHighlight
  if (!highlight) return
  const cells = hoveredLinkCells((x, y) => renderer.getLinkIdAt(x, y), highlight.id, highlight, buffer.width, buffer.height)
  paintLinkCells(buffer, cells, linkHoverColor)
})
// Solid loses the renderer context when a reactive branch creates a renderable. A default
// keeps one renderer reachable for every branch in this single-renderer application.
RendererContext.defaultValue = renderer

try {
  await render(() => <OpenTuiRoot app={app} />, renderer)
  // Render on demand. `renderer.start()` would repaint on a fixed timer, so every key would wait
  // for the next tick and an idle screen would keep repainting.
  await app.start()
} catch {
  if (!app.hasFailure) await app.shutdown()
}
await app.done
renderer.destroy()
await renderer.closed

for (const line of heldConsole) printError(line)
if (app.failureText) {
  printError(`${productName}: ${app.failureText}`)
  process.exitCode = 1
}
