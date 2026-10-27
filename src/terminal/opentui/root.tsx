import {
  ErrorBoundary, For, Show, createEffect, createMemo, createSignal, on, onCleanup
} from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'
import {
  RGBA, SyntaxStyle, TextAttributes, type KeyBinding, type KeyEvent, type MouseEvent, type OptimizedBuffer, type ScrollBoxRenderable, type TextareaRenderable
} from '@opentui/core'
import { useKeyboard, usePaste, useRenderer, useSelectionHandler, useTerminalDimensions, type SpanProps } from '@opentui/solid'

import { DEFAULT_PRODUCT_NAME } from '../../core/env'
import { centeredRect } from '../tui/dialogGeometry'
import { formatTerminalCommandLabel } from '../commandHelp'
import type { FileCompletionView, OpenTuiApplication, OpenTuiView, PaletteView } from './app'
import type { PlanChoiceView } from './planChoice'
import { QuestionDock } from './questionDock'
import type { QuestionDockView } from './questionDockState'
import { type AnsiLine, type AnsiStyle } from './ansi'
import { addHeadingOneSpacing, markdownSyntaxStyles } from './markdown'
import type { TodoEntry, CommandHelpItem, CompactionItem, ToolItem, TranscriptItem } from './model'
import { commandHelpColumnWidth } from './commandHelpLayout'
import { terminalSelectionText } from './terminalSelection'
import { paletteCommandColumnWidth, paletteTextLines } from './palette'
import { syncAttachmentMarks, syncSkillInvocationMark, syncSlashCommandMark } from './composerMarks'
import { splitUserMessageText } from './slashCommandHighlight'
import { blendHexColor, composerRuleColor, opentuiTheme, noticeColor, profileColor, toolColor, type OpenTuiTheme } from './theme'
import type { SubagentRosterView, SubagentRowView } from './subagentsWidget'
import { statusBarText } from './statusBar'
import { workingLineParts, workingLineText, workingVerbShimmerProfile } from './workingLine'
import { toastLayout, type ToastLayout } from './toastLayout'
import { homeBrand } from './homeBrand'
import { pendingMessageLines, type PendingMessage } from './pendingMessages'

const theme = opentuiTheme
const scrollbarColor = RGBA.fromHex(theme.dim)
const transparent = RGBA.fromValues(0, 0, 0, 0)

function drawTranscriptScrollbar(buffer: OptimizedBuffer, scroll: ScrollBoxRenderable | undefined): void {
  if (!scroll) return
  const trackHeight = Math.floor(scroll.viewport.height)
  const contentHeight = scroll.scrollHeight
  const scrollRange = contentHeight - trackHeight
  if (trackHeight < 1 || scrollRange <= 0) return

  const thumbHeight = Math.max(1, Math.min(trackHeight, Math.round(trackHeight * trackHeight / contentHeight)))
  const thumbTop = Math.round((scroll.scrollTop / scrollRange) * (trackHeight - thumbHeight))
  const x = Math.round(scroll.x + scroll.width - 1)
  for (let row = 0; row < thumbHeight; row++) {
    buffer.drawText('▕', x, Math.round(scroll.y + thumbTop + row), scrollbarColor, transparent)
  }
}

/** The host names the product it embeds; this package's own default stays the fallback. */
const productName = () => (process.env.XINGULAR_HARNESS_NAME ?? '')
  .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim() || DEFAULT_PRODUCT_NAME
const productMark = () => homeBrand(productName()).mark
const productSubline = () => homeBrand(productName()).subline

const promptKeyBindings: KeyBinding[] = [
  { name: 'return', action: 'submit' },
  { name: 'kpenter', action: 'submit' },
  { name: 'linefeed', action: 'submit' },
  { name: 'return', shift: true, action: 'newline' },
  { name: 'return', meta: true, action: 'newline' },
  { name: 'kpenter', meta: true, action: 'newline' }
]

function attrs(style: AnsiStyle): number {
  return (style.bold ? TextAttributes.BOLD : 0)
    | (style.dim ? TextAttributes.DIM : 0)
    | (style.italic ? TextAttributes.ITALIC : 0)
    | (style.underline ? TextAttributes.UNDERLINE : 0)
}

function foreground(style: AnsiStyle, fallback: string): string | undefined {
  if (style.inverse) return style.bg ?? theme.background
  return style.fg ?? fallback
}

function background(style: AnsiStyle): string | undefined {
  if (style.inverse) return style.fg ?? theme.text
  return style.bg
}

/**
 * Solid's span props omit TextNodeOptions, and its reconciler only applies a span's
 * `style` (not `fg`, `bg` or `attributes`).
 */
function Span(props: { fg?: string; bg?: string; attributes?: number; children?: unknown }) {
  const style = () => {
    const attributes = props.attributes ?? 0
    return {
      fg: props.fg,
      bg: props.bg,
      bold: (attributes & TextAttributes.BOLD) !== 0,
      dim: (attributes & TextAttributes.DIM) !== 0,
      italic: (attributes & TextAttributes.ITALIC) !== 0,
      underline: (attributes & TextAttributes.UNDERLINE) !== 0
    }
  }
  return <span style={style()}>{props.children as SpanProps['children']}</span>
}

function AnsiView(props: { lines: readonly AnsiLine[]; fg?: string }) {
  return (
    <box flexDirection='column' flexShrink={0}>
      <For each={props.lines}>
        {line => (
          <text fg={props.fg ?? theme.text} wrapMode='none'>
            {line.spans.length
              ? <For each={line.spans}>{span => (
                <Span fg={foreground(span.style, props.fg ?? theme.text)} bg={background(span.style)} attributes={attrs(span.style)}>{span.text}</Span>
              )}</For>
              : ' '}
          </text>
        )}
      </For>
    </box>
  )
}

function duration(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ''
  if (value < 1000) return `${Math.max(1, Math.round(value))}ms`
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`
}

function capLines(text: string, limit: number): string {
  const lines = text.split('\n')
  return lines.length > limit ? `${lines.slice(0, limit).join('\n')}\n…` : text
}

function thinkingText(text: string, expanded: boolean): string {
  return expanded ? text : capLines(text, 8)
}

function toolStatusIcon(status: ToolItem['status']): string {
  if (status === 'running') return '●'
  if (status === 'error') return '✕'
  if (status === 'pending') return '○'
  return '✓'
}

export function todoMark(status: TodoEntry['status']): string {
  if (status === 'completed') return '✓'
  if (status === 'in_progress') return '●'
  return '○'
}

function todoMarkColor(t: OpenTuiTheme, status: TodoEntry['status']): string {
  if (status === 'completed') return t.success
  if (status === 'in_progress') return t.warning
  return t.dim
}

export function todoProgress(done: number, total: number): string {
  return total ? `${done} of ${total} done` : 'empty'
}

/** A full-width rule with a centred label: `──── label ────`. */
export function labelledRule(label: string, width: number): string {
  const text = ` ${label} `
  const room = Math.max(0, Math.floor(width) - Array.from(text).length)
  const left = Math.floor(room / 2)
  return `${'─'.repeat(left)}${text}${'─'.repeat(room - left)}`
}

function CompactionTranscriptItem(props: { item: CompactionItem; expanded: boolean; syntax: SyntaxStyle; width: number }) {
  // Shown by default; a click hides or shows this card, and Ctrl+O shows every card again.
  const [hidden, setHidden] = createSignal(false)
  createEffect(on(() => props.expanded, () => setHidden(false), { defer: true }))
  // The click still reaches the chat, which gives the composer its focus back.
  const toggle = (event: MouseEvent) => {
    if (event.button !== 0 || event.isDragging) return
    setHidden(!hidden())
  }
  const ruleWidth = () => Math.max(10, props.width - 2)
  // The longest label that fits: hint and token count go first on a narrow screen.
  const title = () => {
    const tokens = typeof props.item.tokensBefore === 'number' ? ` · ${props.item.tokensBefore.toLocaleString('en-US')} tokens` : ''
    const choices = [`Context compacted${tokens} · ${hidden() ? 'click to show' : 'click to hide'}`, `Context compacted${tokens}`, 'Context compacted']
    return choices.find(choice => Array.from(choice).length + 6 <= ruleWidth()) ?? choices.at(-1)!
  }

  return (
    <box width='100%' flexDirection='column' rowGap={1} flexShrink={0}>
      <box flexShrink={0} onMouseUp={toggle}>
        <text fg={theme.accent} wrapMode='none' truncate={true} selectable={false}>{labelledRule(title(), ruleWidth())}</text>
      </box>
      <Show when={!hidden()}>
        <box flexDirection='column' paddingLeft={1} flexShrink={0}>
          <markdown content={addHeadingOneSpacing(props.item.summary)} syntaxStyle={props.syntax} fg={theme.text} bg='transparent' conceal={true} tableOptions={{ borderColor: theme.dim, cellPaddingX: 1 }} />
        </box>
        <box flexShrink={0} onMouseUp={toggle}>
          <text fg={theme.accent} wrapMode='none' truncate={true} selectable={false}>{labelledRule('End of summary', ruleWidth())}</text>
        </box>
      </Show>
    </box>
  )
}

function CommandHelpTranscriptItem(props: { item: CommandHelpItem; width: number }) {
  const commandWidth = () => commandHelpColumnWidth(props.item.groups, props.width)
  return (
    <box width='100%' flexDirection='column' flexShrink={0}>
      <For each={props.item.groups}>
        {group => (
          <box width='100%' flexDirection='column' flexShrink={0}>
            <text fg={theme.accent} attributes={TextAttributes.BOLD} wrapMode='word'>{group.name}</text>
            <For each={group.commands}>
              {command => (
                <box width='100%' flexDirection='row' flexShrink={0}>
                  <box width={commandWidth()} minWidth={commandWidth()} flexShrink={0}>
                    <text width='100%' fg={theme.text} attributes={TextAttributes.BOLD} wrapMode='char'>/{formatTerminalCommandLabel(command.name, command.aliases)}</text>
                  </box>
                  <box width={2} minWidth={2} flexShrink={0} />
                  <box flexGrow={1} minWidth={0} flexShrink={1}>
                    <Show when={command.description}>
                      <text width='100%' fg={theme.muted} wrapMode='word'>{command.description}</text>
                    </Show>
                  </box>
                </box>
              )}
            </For>
          </box>
        )}
      </For>
    </box>
  )
}

function TranscriptItemView(props: { item: TranscriptItem; expanded: boolean; syntax: SyntaxStyle; width: number; commandNames: readonly string[] }) {
  const item = props.item
  const t: OpenTuiTheme = theme
  if (item.kind === 'user') {
    return (
      <box border={['left']} borderColor={t.primary} backgroundColor={t.panel} paddingLeft={1} paddingRight={1} paddingTop={1} paddingBottom={1} flexShrink={0}>
        <text wrapMode='word'>
          <For each={splitUserMessageText(item.text ?? '', props.commandNames)}>
            {part => part.kind === 'attachment'
              ? <Span fg={t.attachment} attributes={TextAttributes.BOLD}>{part.text}</Span>
              : part.kind === 'command'
                ? <Span fg={t.accent}>{part.text}</Span>
                : <Span fg={t.text}>{part.text}</Span>}
          </For>
          <Show when={item.images > 0 && !/\[Image #\d+\]/u.test(item.text ?? '')}>
            <Span fg={t.muted}>  [{item.images} image{item.images === 1 ? '' : 's'}]</Span>
          </Show>
        </text>
      </box>
    )
  }
  if (item.kind === 'assistant') {
    return (
      <box flexDirection='column' paddingLeft={1} flexShrink={0}>
        <markdown content={addHeadingOneSpacing(item.text)} streaming={item.streaming} syntaxStyle={props.syntax} fg={t.text} bg='transparent' conceal={true} tableOptions={{ borderColor: t.dim, cellPaddingX: 1 }} />
      </box>
    )
  }
  if (item.kind === 'compaction') {
    return <CompactionTranscriptItem item={item} expanded={props.expanded} syntax={props.syntax} width={props.width} />
  }
  if (item.kind === 'command-help') {
    return <CommandHelpTranscriptItem item={item} width={props.width} />
  }
  if (item.kind === 'plan') {
    return (
      <box border={['left']} borderColor={t.planMode} backgroundColor={t.panel} flexDirection='column' paddingLeft={1} paddingRight={1} paddingTop={1} paddingBottom={1} flexShrink={0}>
        <text fg={t.planMode} attributes={TextAttributes.BOLD} wrapMode='word'>
          Plan · {item.title}
          <Show when={item.streaming}><Span fg={t.dim} attributes={0}> · streaming…</Span></Show>
        </text>
        <markdown content={addHeadingOneSpacing(item.body)} streaming={item.streaming} syntaxStyle={props.syntax} fg={t.text} bg='transparent' conceal={true} tableOptions={{ borderColor: t.dim, cellPaddingX: 1 }} />
      </box>
    )
  }
  if (item.kind === 'todo') {
    // A store record updated in place: read its fields inside functions.
    const done = () => item.items.filter(entry => entry.status === 'completed').length
    return (
      <box flexDirection='column' paddingLeft={1} flexShrink={0}>
        <text wrapMode='none'>
          <Show when={item.origin === 'tool' && item.status}>
            <Span fg={toolColor(t, item.status!)}>{toolStatusIcon(item.status!)}</Span>
          </Show>
          <Span fg={t.text} attributes={TextAttributes.BOLD}> todo</Span>
          <Span fg={t.muted}> · {todoProgress(done(), item.items.length)}</Span>
        </text>
        <box flexDirection='column' paddingLeft={2} flexShrink={0}>
          <For each={item.items}>
            {entry => (
              <box width='100%' flexDirection='row' flexShrink={0}>
                <box width={1} minWidth={1} flexShrink={0}>
                  <text wrapMode='none'>
                    <Span fg={todoMarkColor(t, entry.status)}>{todoMark(entry.status)}</Span>
                  </text>
                </box>
                <box width={1} minWidth={1} flexShrink={0} />
                <text flexGrow={1} minWidth={0} wrapMode='word'>
                  <Span fg={entry.status === 'in_progress' ? t.text : t.muted} attributes={entry.status === 'in_progress' ? TextAttributes.BOLD : 0}>{entry.text}</Span>
                </text>
              </box>
            )}
          </For>
        </box>
      </box>
    )
  }
  if (item.kind === 'thinking') {
    return (
      <box paddingLeft={2} flexShrink={0}>
        <text fg={t.muted} wrapMode='word'>
          {thinkingText(item.text, props.expanded)}
          <Show when={item.streaming}><Span fg={t.muted}> …</Span></Show>
        </text>
      </box>
    )
  }
  if (item.kind === 'image-result') {
    return (
      <box border={['left']} borderColor={t.accent} backgroundColor={t.panel} flexDirection='column' paddingLeft={1} paddingRight={1} flexShrink={0}>
        <text fg={t.accent} attributes={TextAttributes.BOLD}>
          Image result · {item.imageCount} image{item.imageCount === 1 ? '' : 's'}
        </text>
        <Show when={item.text}>
          <markdown content={addHeadingOneSpacing(item.text)} syntaxStyle={props.syntax} fg={t.text} bg='transparent' conceal={true} tableOptions={{ borderColor: t.dim, cellPaddingX: 1 }} />
        </Show>
        <For each={item.images}>
          {image => <image source={Buffer.from(image.data, 'base64')} width='100%' height={12} fit='fit' />}
        </For>
        <Show when={item.imageCount > item.images.length}>
          <text fg={t.muted} wrapMode='word'>
            {item.showImages ? 'Some image output could not be displayed.' : 'Image output hidden. Enable Show images in /settings.'}
          </text>
        </Show>
      </box>
    )
  }
  if (item.kind === 'tool') {
    // The item is a store record updated in place, so values derived from it stay functions.
    const color = () => toolColor(t, item.status)
    const outputLimit = () => props.expanded ? 30 : item.status === 'error' ? 6 : 2
    return (
      <box flexDirection='column' paddingLeft={1} flexShrink={0}>
        <text wrapMode='none'>
          <Span fg={color()}>{toolStatusIcon(item.status)}</Span>
          <Span fg={t.text} attributes={TextAttributes.BOLD}> {item.name}</Span>
          <Show when={item.summary}><Span fg={t.muted}> {item.summary}</Span></Show>
          <Show when={duration(item.durationMs)}><Span fg={t.dim}> · {duration(item.durationMs)}</Span></Show>
        </text>
        <Show when={item.output && (props.expanded || item.status === 'error')} fallback={<box height={0} flexShrink={0} />}>
          <box paddingLeft={2} flexShrink={0}>
            <text fg={item.status === 'error' ? t.error : t.muted} wrapMode='none'>
              {capLines(item.output, outputLimit())}
            </text>
          </box>
        </Show>
      </box>
    )
  }
  if (item.kind === 'notice') {
    return (
      <box width='100%' paddingLeft={1} flexShrink={0}>
        <text fg={noticeColor(t, item.level)} wrapMode='none' truncate={true}>
          {item.level === 'error' || item.level === 'warning' ? '! ' : '· '}{item.text}
        </text>
      </box>
    )
  }
  if (item.kind === 'bash') {
    return (
      <box flexDirection='column' paddingLeft={1} paddingTop={1} paddingBottom={1} flexShrink={0}>
        <text fg={t.success} wrapMode='word'>
          ! {item.command}<Show when={item.running}><Span fg={t.warning}> · running · Esc to stop</Span></Show>
        </text>
        <Show when={item.output} fallback={<box height={0} flexShrink={0} />}>
          <box paddingLeft={2}>
            <text fg={item.cancelled || (item.exitCode !== undefined && item.exitCode !== 0) ? t.error : t.muted} wrapMode='char'>
              {capLines(item.output, props.expanded ? 30 : 6)}
            </text>
          </box>
        </Show>
      </box>
    )
  }
  if (item.kind === 'custom') {
    return (
      <box flexDirection='column' paddingLeft={1} flexShrink={0}>
        <text fg={t.purple}>{item.label}</text>
        <text fg={t.text} wrapMode='word'>{item.text}</text>
      </box>
    )
  }
  return (
    <box flexDirection='column' paddingLeft={1} flexShrink={0}>
      <text fg={t.accent}>◇ {item.label}</text>
      <text fg={t.muted} wrapMode='word'>{capLines(item.text, props.expanded ? 30 : 6)}</text>
    </box>
  )
}

function TranscriptItems(props: { items: readonly TranscriptItem[]; expanded: boolean; syntax: SyntaxStyle; width: number; commandNames: readonly string[] }) {
  return (
    <box flexDirection='column' flexShrink={0} paddingX={1} rowGap={1}>
      <For each={props.items}>
        {item => (
          // Item ids are positions in Pi's message list, so after compaction (or any rebuilt list)
          // one record can change kind. TranscriptItemView picks its layout once, so a new kind
          // needs a new component; the boundary keeps one bad item from stopping every update.
          <Show when={item.kind} keyed>
            {() => (
              <ErrorBoundary fallback={<text fg={theme.muted}>· This item could not be drawn.</text>}>
                <TranscriptItemView item={item} expanded={props.expanded} syntax={props.syntax} width={props.width} commandNames={props.commandNames} />
              </ErrorBoundary>
            )}
          </Show>
        )}
      </For>
    </box>
  )
}

function Palette(props: { app: OpenTuiApplication; palette: PaletteView; width: number }) {
  const commandWidth = () => paletteCommandColumnWidth(props.palette.items, props.width)
  const dimensions = useTerminalDimensions()
  const descriptionWidth = () => Math.max(1, props.width - 9 - commandWidth())
  const rows = createMemo(() => props.palette.items.map(item => {
    const label = paletteTextLines(`${item.prefix ?? '/'}${formatTerminalCommandLabel(item.name, item.aliases)}`, commandWidth())
    const description = item.description ? paletteTextLines(item.description, descriptionWidth()) : []
    return { label, description, height: Math.max(label.length, description.length) }
  }))
  const menuHeight = () => Math.min(16, rows().reduce((total, row) => total + row.height, 0), Math.max(1, dimensions().height - 7))
  let scroll: ScrollBoxRenderable | undefined
  createEffect(on(() => props.palette.index, index => {
    const timer = setTimeout(() => scroll?.scrollChildIntoView(`palette-item-${index}`), 0)
    onCleanup(() => clearTimeout(timer))
  }))
  return (
    <box
      width='100%'
      flexDirection='column'
      backgroundColor={theme.panel}
      borderColor={theme.dim}
      border={['top']}
      paddingX={1}
      marginTop={0}
      flexShrink={0}
    >
      <scrollbox ref={value => { scroll = value }} height={menuHeight()} scrollY={true}>
      <For each={props.palette.items}>
        {(_item, index) => {
          const selected = () => index() === props.palette.index
          return (
            <box
              id={`palette-item-${index()}`}
              width='100%'
              flexDirection='row'
              paddingX={1}
              backgroundColor={selected() ? theme.selectionBg : undefined}
              onMouseOver={() => props.app.selectPaletteItem(index())}
              onMouseUp={event => {
                if (event.button !== 0) return
                event.stopPropagation()
                props.app.activatePaletteItem(index())
              }}
            >
              <box width={commandWidth()} minWidth={commandWidth()} flexShrink={0} flexDirection='column'>
                <For each={rows()[index()]?.label ?? []}>
                  {line => <text fg={selected() ? theme.selectionText : theme.text} attributes={selected() ? TextAttributes.BOLD : 0} wrapMode='none'>{line}</text>}
                </For>
              </box>
              <box width={2} minWidth={2} flexShrink={0} />
              <box flexDirection='column' flexGrow={1} minWidth={0}>
                <For each={rows()[index()]?.description ?? []}>
                  {line => <text fg={selected() ? theme.selectionMuted : theme.muted} wrapMode='none'>{line}</text>}
                </For>
              </box>
            </box>
          )
        }}
      </For>
      </scrollbox>
    </box>
  )
}

function FileCompletionList(props: { app: OpenTuiApplication; completion: FileCompletionView }) {
  return (
    <box
      flexDirection='column'
      backgroundColor={theme.panel}
      borderColor={theme.dim}
      border={['top']}
      paddingX={1}
      marginTop={0}
      flexShrink={0}
    >
      <For each={props.completion.items}>
        {(item, index) => {
          const selected = () => index() === props.completion.index
          return (
            <box
              flexDirection='row'
              paddingX={1}
              backgroundColor={selected() ? theme.selectionBg : undefined}
              onMouseOver={() => props.app.selectFileCompletion(index())}
              onMouseUp={event => {
                if (event.button !== 0) return
                event.stopPropagation()
                props.app.activateFileCompletion(index())
              }}
            >
              <text fg={selected() ? theme.selectionText : theme.text} attributes={selected() ? TextAttributes.BOLD : 0} wrapMode='none' truncate={true}>
                {item.path}
              </text>
            </box>
          )
        }}
      </For>
    </box>
  )
}

function PlanChoiceBlock(props: { app: OpenTuiApplication; choice: PlanChoiceView }) {
  const rows = () => [`Implement "${props.choice.title}"`, 'Edit the plan']
  return (
    <box
      flexDirection='column'
      backgroundColor={theme.panel}
      borderColor={theme.dim}
      border={['top']}
      paddingX={1}
      marginTop={0}
      flexShrink={0}
    >
      <text fg={theme.planMode} attributes={TextAttributes.BOLD} wrapMode='none' truncate={true}>Plan ready</text>
      <box height={1} flexShrink={0} />
      <For each={rows()}>
        {(label, index) => {
          const selected = () => index() === props.choice.index
          return (
            <box
              flexDirection='row'
              paddingX={1}
              backgroundColor={selected() ? theme.selectionBg : undefined}
              onMouseOver={() => props.app.selectPlanChoice(index())}
              onMouseUp={event => {
                if (event.button !== 0) return
                event.stopPropagation()
                props.app.activatePlanChoice(index())
              }}
            >
              <text fg={selected() ? theme.selectionText : theme.text} attributes={selected() ? TextAttributes.BOLD : 0} wrapMode='none' truncate={true}>
                {label}
              </text>
            </box>
          )
        }}
      </For>
      <box height={1} flexShrink={0} />
      <text fg={theme.dim} wrapMode='none' truncate={true}>↑↓ choose · Enter confirm · Esc dismiss</text>
    </box>
  )
}

function StatusBar(props: { view: OpenTuiView }) {
  return (
    <box paddingX={1} flexShrink={0}>
      <text fg={theme.muted} wrapMode='word'>
        {statusBarText(props.view)}
      </text>
    </box>
  )
}

function PendingMessages(props: { messages: readonly PendingMessage[]; width: number; height: number }) {
  const lines = () => pendingMessageLines(props.messages, props.width, Math.min(4, Math.max(0, props.height - 8)))
  return (
    <Show when={lines().length > 0}>
      <box width='100%' paddingX={1} flexDirection='column' flexShrink={0}>
        <For each={lines()}>{line => <text fg={theme.muted} wrapMode='none' truncate={true}>{line}</text>}</For>
      </box>
    </Show>
  )
}

function WorkingLine(props: { view: OpenTuiView; width: number }) {
  const view = () => props.view
  const statusColor = () => view().working.active ? theme.primary : theme.muted
  const statusText = () => workingLineText(view().working)
  const parts = () => workingLineParts(view().working, props.width)
  const shimmerProfile = createMemo(() => workingVerbShimmerProfile(view().working))
  const characterColor = (index: number) => blendHexColor(
    statusColor(),
    theme.warning,
    shimmerProfile()[index] ?? 0
  )
  return (
    <Show when={statusText()} fallback={<box height={0} flexShrink={0} />}>
      <box width='100%' paddingX={1} marginTop={1} flexShrink={0}>
        <text fg={statusColor()} wrapMode='none' truncate={true}>
          <Span fg={statusColor()}>{parts().prefix}</Span>
          <For each={Array.from(parts().label)}>
            {(character, index) => <Span fg={characterColor(index())}>{character}</Span>}
          </For>
          <Span fg={statusColor()}>{parts().suffix}</Span>
        </text>
      </box>
    </Show>
  )
}

const ATTACHMENT_MARK = 'attachment'
const SLASH_COMMAND_MARK = 'slash-command'
const SKILL_INVOCATION_MARK = 'skill-invocation'

/** Strips terminal escapes and normalises newlines in a bracketed paste. */
function pastedText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\r\n?/gu, '\n')
}

/** Colours and protects the draft's attachment labels; returns true when it edited the text. */
function syncMarks(area: TextareaRenderable | undefined, view: OpenTuiView, syntax: SyntaxStyle): boolean {
  if (!area || area.isDestroyed) return false
  let changed = false
  const attachmentStyleId = syntax.getStyleId(ATTACHMENT_MARK)
  if (attachmentStyleId !== null) {
    const typeId = area.extmarks.getTypeId(ATTACHMENT_MARK) ?? area.extmarks.registerType(ATTACHMENT_MARK)
    changed = syncAttachmentMarks(area, view.attachments, typeId, attachmentStyleId)
  }
  const commandStyleId = syntax.getStyleId(SLASH_COMMAND_MARK)
  if (commandStyleId !== null) {
    const typeId = area.extmarks.getTypeId(SLASH_COMMAND_MARK) ?? area.extmarks.registerType(SLASH_COMMAND_MARK)
    syncSlashCommandMark(area, view.bashMode ? [] : view.slashCommandNames, typeId, commandStyleId)
  }
  const skillStyleId = syntax.getStyleId(SKILL_INVOCATION_MARK)
  if (skillStyleId !== null) {
    const typeId = area.extmarks.getTypeId(SKILL_INVOCATION_MARK) ?? area.extmarks.registerType(SKILL_INVOCATION_MARK)
    syncSkillInvocationMark(area, view.bashMode ? [] : view.skillNames, typeId, skillStyleId)
  }
  return changed
}

function subagentToneColor(t: OpenTuiTheme, tone: SubagentRowView['tone']): string {
  if (tone === 'success') return t.success
  if (tone === 'warning') return t.warning
  if (tone === 'error') return t.error
  if (tone === 'accent') return t.accent
  return t.muted
}

/** Live subagents under the status line, one blank line below it (PROP-0029). */
function SubagentRoster(props: { roster: SubagentRosterView }) {
  const t: OpenTuiTheme = theme
  return (
    <box flexDirection='column' marginTop={1} paddingX={1} flexShrink={0}>
      <For each={props.roster.rows}>
        {row => (
          <text wrapMode='none' truncate={true}>
            {/* A running child's frame takes its profile colour; a copy of the parent has none and keeps the warning colour. */}
            <Span fg={row.tone === 'warning' && row.color ? profileColor(t, row.color) : subagentToneColor(t, row.tone)}>{row.mark}</Span>
            <Span fg={row.color ? profileColor(t, row.color) : t.muted} attributes={row.color ? TextAttributes.BOLD : 0}>{` ${row.profile}`}</Span>
            <Span fg={t.text}>{`  ${row.title}`}</Span>
            <Show when={row.tasks}><Span fg={t.muted}>{`  ${row.tasks}`}</Span></Show>
          </text>
        )}
      </For>
      <Show when={props.roster.overflow}>
        <text fg={t.muted} wrapMode='none' truncate={true}>{props.roster.overflow}</text>
      </Show>
    </box>
  )
}

function Prompt(props: { app: OpenTuiApplication; view: OpenTuiView; syntax: SyntaxStyle; promptRef: (value: TextareaRenderable | undefined) => void }) {
  const view = () => props.view
  const dimensions = useTerminalDimensions()
  let area: TextareaRenderable | undefined
  let syncing = false
  const reportDraft = () => {
    if (!area || syncing) return
    syncing = true
    try { syncMarks(area, view(), props.syntax) }
    finally { syncing = false }
    props.app.setDraft(area.plainText)
  }
  createEffect(() => {
    view().attachments
    view().slashCommandNames
    view().skillNames
    view().bashMode
    if (syncing) return
    syncing = true
    try { if (syncMarks(area, view(), props.syntax) && area) props.app.setDraft(area.plainText) }
    finally { syncing = false }
  })
  let insertionEpoch = 0
  createEffect(() => {
    const insertion = view().insertion
    if (!insertion || insertion.epoch <= insertionEpoch || !area) return
    insertionEpoch = insertion.epoch
    area.insertText(insertion.text)
    reportDraft()
  })
  const [visualLines, setVisualLines] = createSignal(1)
  const measure = () => {
    if (area) setVisualLines(Math.max(1, area.lineInfo.lineWidthCols.length))
  }
  createEffect(() => {
    view().draft
    dimensions().width
    measure()
  })
  const inputHeight = () => Math.min(8, Math.max(1, visualLines()))
  const bash = () => view().bashMode
  const plan = () => view().planMode
  const composerFocused = () => {
    const current = view()
    return !current.overlay && !current.customEditor && !current.planChoice
  }
  const composerColor = () => composerRuleColor(theme, { bash: bash(), plan: plan(), overlay: Boolean(view().overlay) })
  return (
    <box flexDirection='column' flexShrink={0}>
      <Show
        when={view().customEditor}
        fallback={(
          <box
            flexDirection='column'
            border={['bottom']}
            borderStyle='single'
            borderColor={composerColor()}
            backgroundColor='transparent'
            flexShrink={0}
          >
            <box flexDirection='row' width='100%' height={1} flexShrink={0}>
              <box flexGrow={1} minWidth={0} height={1} border={['top']} borderStyle='single' borderColor={composerColor()} backgroundColor='transparent' />
              <Show when={plan()}>
                <text fg={composerColor()} attributes={TextAttributes.BOLD} wrapMode='none'> plan mode </text>
                <box width={1} minWidth={1} height={1} border={['top']} borderStyle='single' borderColor={composerColor()} backgroundColor='transparent' />
              </Show>
            </box>
            <box flexDirection='row' paddingX={1} alignItems='stretch'>
              <box width={2} minWidth={2} height={inputHeight()} flexDirection='column' flexShrink={0}>
                <For each={Array.from({ length: inputHeight() }, (_, index) => index)}>
                  {(_, index) => <text fg={composerColor()} attributes={TextAttributes.BOLD} wrapMode='none'>{index() === 0 ? (bash() ? '! ' : '❯ ') : '  '}</text>}
                </For>
              </box>
              <textarea
                ref={value => {
                  area = value
                  if (value) value.syntaxStyle = props.syntax
                  props.promptRef(value)
                }}
                flexGrow={1}
                height={inputHeight()}
                minHeight={1}
                maxHeight={8}
                wrapMode='word'
                backgroundColor='transparent'
                focusedBackgroundColor='transparent'
                textColor={theme.text}
                focusedTextColor={theme.text}
                placeholder={bash() ? 'Run a shell command…' : view().questionDock ? 'Or reply directly to this question…' : plan() ? 'Describe a plan…' : view().home ? 'Ask anything…' : 'Reply…'}
                placeholderColor={theme.dim}
                focused={composerFocused()}
                keyBindings={promptKeyBindings}
                onPaste={event => {
                  event.preventDefault()
                  props.app.paste(pastedText(event.bytes))
                }}
                onSubmit={() => { reportDraft(); props.app.submitPrompt() }}
                onContentChange={() => { measure(); reportDraft() }}
                onSizeChange={() => measure()}
              />
            </box>
          </box>
        )}
      >
        {(lines: () => readonly AnsiLine[]) => (
          <box flexDirection='column' flexShrink={0}>
            <AnsiView lines={lines()} fg={theme.text} />
          </box>
        )}
      </Show>
      <StatusBar view={view()} />
    </box>
  )
}

function cut(text: string, limit: number): string {
  if (limit <= 0) return ''
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text
}

function Footer(props: { view: OpenTuiView; width: number }) {
  const view = () => props.view
  const stats = () => view().statuses.join(' · ')
  const right = () => cut(stats(), Math.max(0, props.width - 2))
  return (
    <Show
      when={view().footer || stats()}
      fallback={<box height={0} flexShrink={0} />}
    >
      <Show
        when={view().footer}
        fallback={(
          <box flexDirection='row' justifyContent='flex-end' flexShrink={0} paddingX={1} height={1}>
            <text fg={theme.dim} wrapMode='none'>{right()}</text>
          </box>
        )}
      >
        {(lines: () => readonly AnsiLine[]) => (
          <box flexDirection='column' flexShrink={0} paddingX={1}>
            <AnsiView lines={lines()} fg={theme.muted} />
            <text fg={theme.dim} wrapMode='none'>{right()}</text>
          </box>
        )}
      </Show>
    </Show>
  )
}

function JumpToLatestBadge(props: { activate(): void }) {
  const [hovered, setHovered] = createSignal(false)
  return (
    <box
      position='absolute'
      right={1}
      bottom={1}
      zIndex={2}
      backgroundColor={hovered() ? theme.selectionBg : theme.panel}
      paddingX={1}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseDown={event => {
        if (event.button !== 0 || event.isDragging) return
        event.stopPropagation()
        props.activate()
      }}
    >
      <text fg={hovered() ? theme.selectionText : theme.accent} attributes={TextAttributes.BOLD} wrapMode='none'>↓ Jump to latest</text>
    </box>
  )
}

function Toast(props: { message: string | null; width: number }) {
  const layout = () => props.message ? toastLayout(props.message, props.width) : undefined
  return (
    <Show when={layout()}>
      {(value: () => ToastLayout) => (
        <box
          position='absolute'
          top={value().top}
          right={value().right}
          width={value().width}
          height={1}
          zIndex={200}
          backgroundColor={theme.selectionBg}
          paddingX={1}
        >
          <text fg={theme.selectionText} wrapMode='none' truncate={true}>{value().message}</text>
        </box>
      )}
    </Show>
  )
}

function Home(props: { view: OpenTuiView }) {
  return (
    <box flexGrow={1} flexDirection='column' alignItems='center' justifyContent='center' minHeight={0}>
      {/* Leave a row after the six-row font so its bottom strokes cannot overlap the label. */}
      <box height={7} minHeight={7} flexShrink={0}>
        <ascii_font text={productMark()} font='block' color={theme.primary} backgroundColor='transparent' selectable={false} />
      </box>
      <Show when={productSubline()} fallback={<box height={0} flexShrink={0} />}>
        <text fg={theme.accent} attributes={TextAttributes.BOLD} wrapMode='none' truncate={true}>{productSubline()}</text>
      </Show>
      <box height={1} />
      <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode='none' truncate={true}>Welcome.</text>
      <text fg={theme.muted} wrapMode='none' truncate={true}>One run, done well.</text>
      <text fg={theme.muted} wrapMode='none' truncate={true}>Ask anything, or{' '}<Span fg={theme.accent}>/help</Span> for commands</text>
      <Show when={props.view.model} fallback={<box height={0} flexShrink={0} />}>
        <text fg={theme.dim} wrapMode='none' truncate={true}>{props.view.model!.name} · {props.view.thinking === 'off' ? 'thinking off' : `thinking ${props.view.thinking}`}</text>
      </Show>
    </box>
  )
}

function PageDialog(props: { value: () => NonNullable<OpenTuiView['overlay']>; width: number; height: number; routeMouse(event: MouseEvent): void }) {
  const rect = () => centeredRect(
    props.width,
    props.height,
    props.value().width,
    Math.min(props.value().lines.length, Math.max(1, props.height - 2))
  )
  return (
    <box
      position='absolute'
      top={rect().top}
      left={rect().left}
      width={rect().width}
      height={rect().height}
      zIndex={100}
      backgroundColor={theme.panel}
      flexDirection='column'
      overflow='hidden'
      onMouseMove={props.routeMouse}
      onMouseUp={props.routeMouse}
      onMouseScroll={props.routeMouse}
    >
      <AnsiView lines={props.value().lines} fg={theme.text} />
    </box>
  )
}

function OverlayView(props: { app: OpenTuiApplication; view: OpenTuiView; width: number; height: number }) {
  const overlay = () => props.view.overlay
  const routeMouse = (event: MouseEvent) => {
    if (!overlay()) return
    props.app.handleMouse({
      type: event.type === 'scroll' ? 'scroll' : event.type === 'up' ? 'up' : 'move',
      x: event.x,
      y: event.y,
      button: event.button,
      modifiers: event.modifiers,
      ...(event.scroll ? { scroll: event.scroll } : {})
    })
    event.stopPropagation()
  }
  return (
    <Show when={overlay()} fallback={<box height={0} flexShrink={0} />}>
      {(value: () => NonNullable<OpenTuiView['overlay']>) => (
        <Show
          when={value().dialog}
          fallback={(
            <Show
              when={value().fullscreen}
              fallback={(
                <box
                  position='absolute'
                  top={value().bounds.row}
                  left={value().bounds.col}
                  width={value().bounds.width}
                  height={value().bounds.height}
                  zIndex={100}
                  backgroundColor={theme.panel}
                  border
                  borderStyle='rounded'
                  borderColor={theme.borderFocus}
                  padding={1}
                  flexDirection='column'
                  overflow='hidden'
                  onMouseMove={routeMouse}
                  onMouseUp={routeMouse}
                  onMouseScroll={routeMouse}
                >
                  <AnsiView lines={value().lines} fg={theme.text} />
                </box>
              )}
            >
              <box
                position='absolute'
                top={0}
                left={0}
                width='100%'
                height='100%'
                zIndex={100}
                backgroundColor={theme.background}
                flexDirection='column'
                onMouseMove={routeMouse}
                onMouseUp={routeMouse}
                onMouseScroll={routeMouse}
              >
                <AnsiView lines={value().lines} fg={theme.text} />
              </box>
            </Show>
          )}
        >
          <box
            position='absolute'
            top={0}
            left={0}
            width='100%'
            height='100%'
            zIndex={99}
            backgroundColor={theme.scrim}
            onMouseMove={routeMouse}
            onMouseUp={routeMouse}
            onMouseScroll={routeMouse}
          />
          <PageDialog value={value} width={props.width} height={props.height} routeMouse={routeMouse} />
        </Show>
      )}
    </Show>
  )
}

export function OpenTuiRoot(props: { app: OpenTuiApplication }) {
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  let prompt: TextareaRenderable | undefined
  let scroll: ScrollBoxRenderable | undefined
  let suppressComposerFocus = false
  let suppressComposerFocusTimer: ReturnType<typeof setTimeout> | undefined
  const syntax = SyntaxStyle.fromStyles(markdownSyntaxStyles(theme), renderer.nativeScene)
  const composerSyntax = SyntaxStyle.fromStyles({
    [ATTACHMENT_MARK]: { fg: theme.attachment, bold: true },
    [SLASH_COMMAND_MARK]: { fg: theme.accent },
    [SKILL_INVOCATION_MARK]: { fg: theme.accent }
  }, renderer.nativeScene)
  onCleanup(() => { syntax.destroy(); composerSyntax.destroy() })

  // The view lives in a store and each change is reconciled into it, keyed by item id. Only the
  // fields that changed notify, so a streamed delta updates one markdown block in place and a
  // keystroke does not redraw the transcript.
  const [state, setState] = createStore<OpenTuiView>(props.app.view())
  const off = props.app.subscribe(() => setState(reconcile(props.app.view())))
  onCleanup(off)

  useSelectionHandler(selection => {
    const selectedText = terminalSelectionText(selection)
    if (selectedText !== undefined) props.app.copySelection(selectedText)
  })

  const view = () => state
  const [showJumpToLatest, setShowJumpToLatest] = createSignal(false)
  let scrollStateTimer: ReturnType<typeof setTimeout> | undefined
  const refreshTranscriptScrollState = () => {
    if (!scroll) {
      setShowJumpToLatest(false)
      return
    }
    const latestScrollTop = Math.max(0, scroll.scrollHeight - scroll.viewport.height)
    setShowJumpToLatest(scroll.scrollTop < latestScrollTop)
  }
  const scheduleTranscriptScrollState = () => {
    if (scrollStateTimer) clearTimeout(scrollStateTimer)
    scrollStateTimer = setTimeout(() => {
      scrollStateTimer = undefined
      refreshTranscriptScrollState()
    }, 16)
  }
  const jumpToLatest = () => {
    if (!scroll) return
    scroll.scrollTo({ x: 0, y: scroll.scrollHeight })
    refreshTranscriptScrollState()
  }
  const activateJumpToLatest = () => {
    suppressComposerFocus = true
    if (suppressComposerFocusTimer) clearTimeout(suppressComposerFocusTimer)
    suppressComposerFocusTimer = setTimeout(() => {
      suppressComposerFocus = false
      suppressComposerFocusTimer = undefined
    }, 500)
    jumpToLatest()
  }
  const handleRootMouseUp = (event: MouseEvent) => {
    if (suppressComposerFocus) {
      suppressComposerFocus = false
      if (suppressComposerFocusTimer) clearTimeout(suppressComposerFocusTimer)
      suppressComposerFocusTimer = undefined
      event.stopPropagation()
      return
    }
    focusComposerFromChat(event)
  }
  onCleanup(() => {
    if (scrollStateTimer) clearTimeout(scrollStateTimer)
    if (suppressComposerFocusTimer) clearTimeout(suppressComposerFocusTimer)
  })
  createEffect(() => {
    const current = view()
    const last = current.items.at(-1)
    current.home
    current.items.length
    current.toolsExpanded
    if (last && 'text' in last) last.text
    if (last && 'output' in last) last.output
    if (last && 'streaming' in last) last.streaming
    const size = dimensions()
    size.width
    size.height
    scheduleTranscriptScrollState()
  })

  const focusComposerFromChat = (event: MouseEvent) => {
    if (event.button !== 0 || event.isDragging) return
    // A click on a link opens it and still leaves the person where they were typing.
    if (props.app.activateLinkAt(event.x, event.y, event.modifiers)) event.stopPropagation()
    const current = view()
    if (current.overlay || current.customEditor || current.questionDock) return
    // Let transcript selection finish before changing focus.
    queueMicrotask(() => {
      const latest = view()
      if (latest.overlay || latest.customEditor || latest.questionDock) return
      prompt?.focus()
    })
  }

  createEffect(() => {
    const size = dimensions()
    props.app.resize(size.width, size.height)
  })

  // The epoch changes whenever the application sets the draft (send, history, clear), so the
  // composer follows even when the text ends where the store last saw it, as with keys and Enter
  // that arrive together.
  createEffect(() => {
    view().draftEpoch
    const draft = view().draft
    const cursorOffset = view().draftCursorOffset
    if (prompt) {
      if (prompt.plainText !== draft) {
        prompt.setText(draft)
        syncMarks(prompt, view(), composerSyntax)
      }
      if (cursorOffset !== null) prompt.cursorOffset = cursorOffset
    }
  })

  const composerBlocked = createMemo(() => {
    const current = view()
    return Boolean(current.overlay || current.customEditor || current.questionDock || current.planChoice)
  })
  createEffect(on(composerBlocked, blocked => {
    if (!prompt) return
    if (blocked) prompt.blur()
    else prompt.focus()
  }))

  const input = (key: KeyEvent) => {
    const focusedPrompt = prompt?.focused ? prompt : undefined
    const cursorRow = focusedPrompt ? focusedPrompt.visualCursor.visualRow + focusedPrompt.scrollY : undefined
    const lastVisualRow = focusedPrompt ? focusedPrompt.virtualLineCount - 1 : undefined
    return {
      name: key.name,
      sequence: key.sequence,
      ctrl: key.ctrl,
      meta: key.meta,
      shift: key.shift,
      option: key.option,
      super: key.super,
      repeated: key.repeated,
      cursorOffset: focusedPrompt?.cursorOffset,
      atFirstVisualLine: cursorRow === 0,
      atLastVisualLine: cursorRow !== undefined && lastVisualRow !== undefined && cursorRow >= lastVisualRow
    }
  }

  usePaste(event => {
    if (!view().overlay) return
    event.preventDefault()
    event.stopPropagation()
    props.app.paste(pastedText(event.bytes))
  })

  useKeyboard(key => {
    if (key.eventType !== 'press' || !key.sequence) return
    // The composer reports its text in a microtask, after every key of an input chunk has been
    // handled. Read it now, so Enter or a palette key sees what was typed in the same chunk.
    if (prompt?.focused) props.app.setDraft(prompt.plainText)
    const current = view()
    const page = Math.max(1, Math.floor((dimensions().height - 8) / 2))
    if (!current.overlay && !current.questionDock && (key.name === 'pageup' || key.name === 'pagedown' || (key.ctrl && (key.name === 'home' || key.name === 'end')))) {
      if (key.name === 'pageup') scroll?.scrollBy({ x: 0, y: -page })
      else if (key.name === 'pagedown') scroll?.scrollBy({ x: 0, y: page })
      else if (key.name === 'home') scroll?.scrollTo({ x: 0, y: 0 })
      else jumpToLatest()
      refreshTranscriptScrollState()
      key.preventDefault()
      key.stopPropagation()
      return
    }
    if (props.app.handleKey(input(key))) {
      key.preventDefault()
      key.stopPropagation()
    }
  })

  return (
    <box
      position='relative'
      flexDirection='column'
      width='100%'
      height='100%'
      backgroundColor='transparent'
      onMouseMove={event => props.app.updateLinkHover(event.x, event.y)}
      onMouseUp={handleRootMouseUp}
    >
      <box flexDirection='column' flexGrow={1} minHeight={0} paddingX={1}>
        <Show when={view().header} fallback={<box height={0} flexShrink={0} />}>
          {(lines: () => readonly AnsiLine[]) => <AnsiView lines={lines()} fg={theme.muted} />}
        </Show>
        <Show
          when={!view().home}
          fallback={(
            <box flexGrow={1} minHeight={0} flexDirection='column'>
              <Home view={view()} />
              <TranscriptItems items={view().items} expanded={view().toolsExpanded} syntax={syntax} width={Math.max(1, dimensions().width - 4)} commandNames={view().slashCommandNames} />
            </box>
          )}
        >
          <box position='relative' flexDirection='column' flexGrow={1} minHeight={0}>
            <scrollbox
              ref={value => { scroll = value }}
              flexGrow={1}
              minHeight={0}
              stickyScroll={true}
              stickyStart='bottom'
              scrollY={true}
              verticalScrollbarOptions={{ width: 1, trackOptions: { backgroundColor: 'transparent', foregroundColor: 'transparent' } }}
              renderAfter={buffer => drawTranscriptScrollbar(buffer, scroll)}
              backgroundColor='transparent'
              paddingBottom={1}
              onMouseScroll={scheduleTranscriptScrollState}
              onMouseDrag={scheduleTranscriptScrollState}
              onMouseUp={scheduleTranscriptScrollState}
            >
              <TranscriptItems items={view().items} expanded={view().toolsExpanded} syntax={syntax} width={Math.max(1, dimensions().width - 4)} commandNames={view().slashCommandNames} />
            </scrollbox>
            <Show when={showJumpToLatest()}>
              <JumpToLatestBadge activate={activateJumpToLatest} />
            </Show>
          </box>
        </Show>

        <PendingMessages messages={(view() as OpenTuiView & { pendingMessages?: readonly PendingMessage[] }).pendingMessages ?? []} width={Math.max(0, dimensions().width - 4)} height={dimensions().height} />
        <WorkingLine view={view()} width={Math.max(0, dimensions().width - 4)} />
        <For each={view().widgets.above}>
          {lines => <AnsiView lines={lines} fg={theme.text} />}
        </For>
        <Show when={view().planChoice} fallback={<box height={0} flexShrink={0} />}>
          {(choice: () => PlanChoiceView) => <PlanChoiceBlock app={props.app} choice={choice()} />}
        </Show>
        <Show when={view().fileCompletion} fallback={<box height={0} flexShrink={0} />}>
          {(completion: () => FileCompletionView) => <FileCompletionList app={props.app} completion={completion()} />}
        </Show>
        <Show when={view().palette} fallback={<box height={0} flexShrink={0} />}>
          {(palette: () => PaletteView) => <Palette app={props.app} palette={palette()} width={dimensions().width} />}
        </Show>
        <Show when={view().questionDock} fallback={<box height={0} flexShrink={0} />}>
          {(question: () => QuestionDockView) => <QuestionDock app={props.app} view={question()} />}
        </Show>
        <Show when={!view().questionDock} fallback={<box height={0} flexShrink={0} />}>
          <Prompt app={props.app} view={view()} syntax={composerSyntax} promptRef={value => { prompt = value }} />
        </Show>
        <Show when={view().subagents} fallback={<box height={0} flexShrink={0} />}>
          {(roster: () => SubagentRosterView) => <SubagentRoster roster={roster()} />}
        </Show>
        <For each={view().widgets.below}>
          {lines => <AnsiView lines={lines} fg={theme.text} />}
        </For>
        <Footer view={view()} width={dimensions().width} />
      </box>
      <OverlayView app={props.app} view={view()} width={dimensions().width} height={dimensions().height} />
      <Toast message={view().toast} width={dimensions().width} />
    </box>
  )
}
