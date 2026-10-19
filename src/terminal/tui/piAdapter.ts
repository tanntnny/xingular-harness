// Pi 1.2.0 omits CLI builtins, rich builtin renderers, clipboard reads and the global theme setter
// from its public exports. Keep those version-sensitive presentation hooks here; session/runtime
// work uses public APIs. Clipboard helpers are only called for an explicit user paste.
import type { InlineExtension, Theme, ToolRenderers } from '@earendil-works/pi-coding-agent'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { loadPi, PINNED_PI_VERSION } from '../../pi/runtime'

export interface PiAdapter {
  builtins: InlineExtension[]
  setTheme(theme: Theme): void
  withBuiltInRenderers(toolName: string, definition: ToolRenderers | undefined): ToolRenderers | undefined
  readClipboardText(): Promise<string | null>
  readClipboardFilePaths(): Promise<string[] | null>
  readClipboardImage(): Promise<{ bytes: Uint8Array; mimeType: string } | null>
  extensionForImageMimeType(mimeType: string): string | null
}

let adapter: PiAdapter | undefined
let loading: Promise<PiAdapter> | undefined

export function assertPiAdapterVersion(version: string): void {
  if (version !== PINNED_PI_VERSION) throw new Error(`The Harness terminal adapter requires Pi ${PINNED_PI_VERSION}; found ${version}. Install the Harness package's pinned dependencies.`)
}

export function loadPiAdapter(): Promise<PiAdapter> {
  loading ??= (async () => {
    const pi = await loadPi()
    assertPiAdapterVersion(pi.VERSION)
    const root = pi.getPackageDir()
    const [extensions, theme, renderers, clipboard, images] = await Promise.all([
      import(pathToFileURL(join(root, 'dist/extensions/index.js')).href),
      import(pathToFileURL(join(root, 'dist/modes/interactive/theme/theme.js')).href),
      import(pathToFileURL(join(root, 'dist/core/tools/renderers/index.js')).href),
      import(pathToFileURL(join(root, 'dist/utils/clipboard.js')).href),
      import(pathToFileURL(join(root, 'dist/utils/clipboard-image.js')).href)
    ])
    if (!Array.isArray(extensions.builtInExtensions) || typeof theme.setThemeInstance !== 'function' || typeof renderers.withBuiltInRenderers !== 'function' || typeof clipboard.readClipboardText !== 'function' || typeof clipboard.readClipboardFilePaths !== 'function' || typeof images.readClipboardImage !== 'function' || typeof images.extensionForImageMimeType !== 'function') {
      throw new Error('The pinned Pi terminal adapter no longer exposes its required builtin or theme hooks.')
    }
    adapter = {
      builtins: extensions.builtInExtensions as InlineExtension[],
      setTheme: theme.setThemeInstance,
      withBuiltInRenderers: renderers.withBuiltInRenderers,
      readClipboardText: clipboard.readClipboardText,
      readClipboardFilePaths: clipboard.readClipboardFilePaths,
      readClipboardImage: images.readClipboardImage,
      extensionForImageMimeType: images.extensionForImageMimeType
    }
    return adapter
  })()
  return loading
}

/** Initialize once with loadPiAdapter() before rendering native rich tool components. */
export function setPiTheme(theme: Theme): void {
  if (!adapter) throw new Error('Initialize the Pi terminal adapter before setting its theme.')
  adapter.setTheme(theme)
}

export function withBuiltInRenderers(toolName: string, definition: ToolRenderers | undefined): ToolRenderers | undefined {
  if (!adapter) throw new Error('Initialize the Pi terminal adapter before resolving builtin renderers.')
  return adapter.withBuiltInRenderers(toolName, definition)
}
