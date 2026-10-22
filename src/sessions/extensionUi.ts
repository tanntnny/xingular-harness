// What a Pi extension can show and ask in a session that has no terminal. Pi's own terminal
// draws an extension's dialogs and status lines; here they become the run's question events and
// notices, the same subset Pi's RPC mode supports. Anything that needs a real terminal (custom
// components, key handlers, themes) does nothing, as it does there.
import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent'

import type { QuestionAnswer, QuestionInput } from './registry'

/** A status line, a notification, or an error from an extension. */
export interface ExtensionNotice {
  kind: 'notify' | 'status' | 'widget' | 'title' | 'error'
  /** `notify` only. */
  level?: 'info' | 'warning' | 'error'
  /** The extension's own name for a status entry or a widget, so a later one replaces it. */
  key?: string
  /** The text. Empty clears a status entry or a widget. */
  text: string
  /** The file of the extension, for an error. */
  extension?: string
}

export interface ExtensionHost {
  ask(input: QuestionInput): Promise<QuestionAnswer>
  notice(notice: ExtensionNotice): void
}

const MAX_TEXT = 4_000
const clip = (text: string): string => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text)

/** A dialog that Pi can dismiss on its own: by a signal, or after a time. */
function dismissable<T>(answer: Promise<T>, fallback: T, options?: { signal?: AbortSignal; timeout?: number }): Promise<T> {
  if (!options?.signal && !options?.timeout) return answer
  return new Promise<T>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = (value: T): void => {
      if (timer) clearTimeout(timer)
      resolve(value)
    }
    if (options.signal?.aborted) return done(fallback)
    options.signal?.addEventListener('abort', () => done(fallback), { once: true })
    if (options.timeout) timer = setTimeout(() => done(fallback), options.timeout)
    void answer.then(done, () => done(fallback))
  })
}

// Text styling has no meaning without a terminal: every style returns the text it was given.
const plainTheme = new Proxy({}, { get: () => (...args: unknown[]) => String(args[args.length - 1] ?? '') })

export function extensionUi(host: ExtensionHost): ExtensionUIContext {
  const context = {
    select: (title: string, options: string[], opts?: { signal?: AbortSignal; timeout?: number }) =>
      dismissable(
        options.length
          ? host.ask({ question: clip(title), options: options.map((label, index) => ({ label, ...(index === 0 ? { recommended: true } : {}) })), multiSelect: false, allowText: false }).then((answer) => answer.selected[0])
          : Promise.resolve(undefined),
        undefined,
        opts
      ),
    confirm: (title: string, message: string, opts?: { signal?: AbortSignal; timeout?: number }) =>
      dismissable(
        host.ask({ question: clip(message ? `${title}\n\n${message}` : title), options: [{ label: 'Yes' }, { label: 'No', recommended: true }], multiSelect: false, allowText: false }).then((answer) => answer.selected[0] === 'Yes'),
        false,
        opts
      ),
    input: (title: string, placeholder?: string, opts?: { signal?: AbortSignal; timeout?: number }) =>
      dismissable(
        host.ask({ question: clip(placeholder ? `${title} (${placeholder})` : title), options: [{ label: 'Type your response', recommended: true }], multiSelect: false, allowText: true }).then((answer) => answer.text || undefined),
        undefined,
        opts
      ),
    editor: (title: string, prefill?: string) =>
      host.ask({ question: clip(prefill ? `${title}\n\n${prefill}` : title), options: [{ label: 'Type your response', recommended: true }], multiSelect: false, allowText: true }).then((answer) => answer.text || undefined),
    notify: (message: string, level?: 'info' | 'warning' | 'error') => host.notice({ kind: 'notify', level: level ?? 'info', text: clip(message) }),
    setStatus: (key: string, text: string | undefined) => host.notice({ kind: 'status', key, text: clip(text ?? '') }),
    setWidget: (key: string, content: unknown) => {
      // Only lines of text can be shown; a component needs a terminal.
      if (content === undefined || Array.isArray(content)) host.notice({ kind: 'widget', key, text: clip(((content as string[] | undefined) ?? []).join('\n')) })
    },
    setTitle: (title: string) => host.notice({ kind: 'title', text: clip(title) }),
    onTerminalInput: () => () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setFooter: () => {},
    setHeader: () => {},
    custom: async () => undefined,
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => '',
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    get theme() {
      return plainTheme
    },
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: 'There is no terminal to theme in this session.' }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {}
  }
  return context as unknown as ExtensionUIContext
}
