import { createCliRenderer } from '@opentui/core'
import { render, RendererContext } from '@opentui/solid'

import { OpenTuiApplication } from './app'
import { OpenTuiRoot } from './root'

const app = new OpenTuiApplication(process.argv.slice(2))
const productName = (process.env.XINGULAR_HARNESS_NAME ?? '')
  .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim() || 'Xingular Harness'
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
  destroy: () => renderer.destroy()
})
app.setStopHandler(() => renderer.destroy())
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

if (app.failureText) {
  console.error(`${productName}: ${app.failureText}`)
  process.exitCode = 1
}
