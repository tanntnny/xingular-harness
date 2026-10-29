import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from 'solid-js'
import { RGBA, TextAttributes, type OptimizedBuffer, type BoxRenderable, type KeyBinding, type MouseEvent, type ScrollBoxRenderable, type TextareaRenderable } from '@opentui/core'
import { useKeyboard, useTerminalDimensions } from '@opentui/solid'

import { questionDockAnswerWidth, questionDockBodyHeight, questionDockColumns, questionDockPreviewRevealDelta, sketchBorder, sketchViewportHeight } from './questionDockLayout'
import { layoutSketchPanel } from './sketchPanel'

import type { OpenTuiApplication } from './app'
import { opentuiTheme } from './theme'
import type { QuestionDockView } from './questionDockState'

const theme = opentuiTheme

const answerKeyBindings: KeyBinding[] = [
  { name: 'return', action: 'submit' },
  { name: 'kpenter', action: 'submit' },
  { name: 'linefeed', action: 'submit' }
]

function WrappedQuestionInput(props: {
  value: string
  placeholder: string
  focused: boolean
  width?: number
  onMouseDown?: (event: MouseEvent) => void
  onChange(value: string): void
  onSubmit(): void
}) {
  const [rows, setRows] = createSignal(1)
  let area: TextareaRenderable | undefined
  const measure = () => setRows(Math.min(4, Math.max(1, area?.lineInfo.lineWidthCols.length ?? 1)))

  createEffect(() => {
    const value = props.value
    if (area && area.plainText !== value) area.setText(value)
    measure()
  })

  return (
    <textarea
      ref={value => {
        area = value
        if (value && value.plainText !== props.value) value.setText(props.value)
        measure()
      }}
      width={props.width}
      flexGrow={props.width === undefined ? 1 : 0}
      minWidth={0}
      height={rows()}
      minHeight={1}
      maxHeight={4}
      wrapMode='word'
      backgroundColor='transparent'
      focusedBackgroundColor='transparent'
      textColor={theme.text}
      focusedTextColor={theme.text}
      placeholder={props.placeholder}
      placeholderColor={theme.dim}
      focused={props.focused}
      onMouseDown={props.onMouseDown}
      keyBindings={answerKeyBindings}
      onContentChange={() => { measure(); props.onChange(area?.plainText ?? '') }}
      onSizeChange={measure}
      onSubmit={() => { props.onChange(area?.plainText ?? ''); props.onSubmit() }}
    />
  )
}

export function QuestionDock(props: { app: OpenTuiApplication; view: QuestionDockView }) {
  const primaryAction = () => props.view.actionLabel.startsWith('Continue')
  const dimensions = useTerminalDimensions()
  const [contentWidth, setContentWidth] = createSignal(Math.max(0, dimensions().width - 4))
  const [bodyHeight, setBodyHeight] = createSignal(1)
  let dock: BoxRenderable | undefined
  let body: ScrollBoxRenderable | undefined
  let preview: ScrollBoxRenderable | undefined
  let previewFrame: BoxRenderable | undefined
  let bodyMeasureTimer: ReturnType<typeof setTimeout> | undefined
  const maxDockHeight = () => Math.max(1, Math.floor(dimensions().height * 2 / 3))
  const tabRows = () => {
    const width = Math.max(1, contentWidth())
    let rows = 1
    let used = 0
    for (const tab of props.view.tabs) {
      const tabWidth = Array.from(tab.label).length + 2
      if (used > 0 && used + tabWidth > width) { rows += 1; used = 0 }
      const labelRows = Math.max(1, Math.ceil(tabWidth / width))
      if (used === 0) rows += labelRows - 1
      used += tabWidth
    }
    return rows
  }
  const answerRows = () => {
    const width = questionDockAnswerWidth(contentWidth(), props.view.options.length, props.view.actionLabel)
    const lines = props.view.text.split('\n')
    const rows = lines.reduce((total, line) => total + Math.max(1, Math.ceil(Array.from(line).length / width)), 0)
    return Math.min(4, Math.max(1, rows))
  }
  const chromeHeight = () => 3 + tabRows() + answerRows() + (contentWidth() < 60 ? 1 : 2) + (props.view.error ? 2 : 0)
  const scheduleBodyMeasure = () => {
    if (bodyMeasureTimer) clearTimeout(bodyMeasureTimer)
    const activeIndex = props.view.activeIndex
    bodyMeasureTimer = setTimeout(() => {
      bodyMeasureTimer = undefined
      if (!body || props.view.activeIndex !== activeIndex) return
      const availableHeight = Math.max(1, maxDockHeight() - chromeHeight())
      setBodyHeight(questionDockBodyHeight(body.content.y, body.getChildren(), availableHeight))
    }, 0)
  }
  const measure = () => {
    if (!dock) return
    setContentWidth(Math.max(0, dock.width - 2))
    scheduleBodyMeasure()
  }
  createEffect(() => {
    const view = props.view
    view.question
    view.tabs.forEach(tab => tab.label)
    view.options.forEach(option => {
      option.label
      option.description
      option.recommended
      option.note
      option.noteOpen
    })
    view.sketchPreview?.sketch
    view.text
    view.allowText
    view.error
    view.submitting
    dimensions().width
    dimensions().height
    scheduleBodyMeasure()
  })
  createEffect(on(() => props.view.activeIndex, () => {
    // The new question must not inherit the previous tab's viewport as its content height.
    setBodyHeight(1)
    body?.scrollTo({ x: 0, y: 0 })
    scheduleBodyMeasure()
  }, { defer: true }))
  onCleanup(() => { if (bodyMeasureTimer) clearTimeout(bodyMeasureTimer) })
  const columns = () => questionDockColumns(Math.max(0, contentWidth() - 2))
  const sketchLines = () => (props.view.sketchPreview?.sketch ?? '').split('\n')
  const sketchPanel = createMemo(() => layoutSketchPanel(props.view.sketchPreview?.sketch ?? '', Math.max(1, contentWidth() - 2)))
  // Both content bounds must be explicit: a Solid-created scrollbox retains a 100% max-width.
  const sketchWidth = () => sketchPanel().width
  const previewHeight = () => sketchViewportHeight(props.view.sketchPreview?.sketch ?? '', dimensions().height)
  const revealPreview = (direction: -1 | 1) => {
    if (!body || !previewFrame) return
    const delta = questionDockPreviewRevealDelta(body.viewport.y, body.viewport.height, previewFrame.y, previewFrame.height, direction)
    if (delta) body.scrollBy({ x: 0, y: delta })
  }

  const drawDividerJunctions = (buffer: OptimizedBuffer) => {
    if (!preview || !previewFrame) return
    const color = RGBA.fromHex(theme.dim)
    const transparent = RGBA.fromValues(0, 0, 0, 0)
    for (const row of sketchPanel().dividers) {
      const visibleRow = row - preview.scrollTop
      if (visibleRow < 0 || visibleRow >= preview.viewport.height) continue
      const y = Math.round(preview.viewport.y + visibleRow)
      buffer.drawText('├', Math.round(previewFrame.x), y, color, transparent)
      buffer.drawText('┤', Math.round(previewFrame.x + previewFrame.width - 1), y, color, transparent)
    }
  }

  createEffect(on([() => props.view.optionIndex, () => props.view.activeIndex, () => props.view.focus], ([index, question, focus]) => {
    // Wait for Yoga to lay out wrapped rows before bringing the focused cell into view.
    const timer = setTimeout(() => {
      if (focus === 'options' || focus === 'note') body?.scrollChildIntoView(`question-${question}-option-${index}`)
      if (focus === 'options' && index === 0) body?.scrollTo({ x: 0, y: 0 })
    }, 0)
    onCleanup(() => clearTimeout(timer))
  }))
  createEffect(on(() => props.view.sketchPreview?.sketch, () => {
    preview?.scrollTo({ x: 0, y: 0 })
  }))

  useKeyboard(key => {
    if (key.eventType !== 'press') return
    let handled = true
    if (key.shift && ['up', 'down', 'left', 'right'].includes(key.name) && props.view.sketchPreview && preview) {
      preview.scrollBy({ x: key.name === 'left' ? -4 : key.name === 'right' ? 4 : 0, y: key.name === 'up' ? -1 : key.name === 'down' ? 1 : 0 })
      if (key.name === 'up') revealPreview(-1)
      else if (key.name === 'down') revealPreview(1)
    } else if (key.name === 'pageup' || key.name === 'pagedown') {
      body?.scrollBy({ x: 0, y: (key.name === 'pageup' ? -1 : 1) * Math.max(1, (body?.viewport.height ?? 2) - 1) })
    } else if (key.ctrl && (key.name === 'home' || key.name === 'end')) {
      body?.scrollTo({ x: 0, y: key.name === 'home' ? 0 : body.scrollHeight })
    } else handled = false
    if (handled) { key.preventDefault(); key.stopPropagation() }
  })

  return (
    <box
      ref={value => { dock = value; measure() }}
      onSizeChange={measure}
      maxHeight={maxDockHeight()}
      width='100%'
      flexDirection='column'
      border={['top']}
      borderStyle='single'
      borderColor={theme.dim}
      backgroundColor={theme.panel}
      paddingX={1}
      marginTop={0}
      flexShrink={0}
    >
      <box flexDirection='row' flexWrap='wrap' width='100%' flexShrink={0}>
        <For each={props.view.tabs}>
          {tab => (
            <box
              paddingX={1}
              backgroundColor={tab.active ? theme.selectionBg : undefined}
              flexShrink={0}
              onMouseUp={event => {
                if (event.button !== 0) return
                event.stopPropagation()
                props.app.selectQuestionTab(tab.index)
              }}
            >
              <text
                fg={tab.active ? theme.selectionText : theme.muted}
                attributes={tab.active ? TextAttributes.BOLD : 0}
                wrapMode='word'
              >
                {tab.label}
              </text>
            </box>
          )}
        </For>
      </box>
      <scrollbox
        ref={value => { body = value; scheduleBodyMeasure() }}
        onSizeChange={scheduleBodyMeasure}
        height={bodyHeight()}
        minHeight={1}
        flexGrow={0}
        flexShrink={1}
        scrollY={true}
        scrollX={false}
        verticalScrollbarOptions={{ visible: false }}
        contentOptions={{ flexDirection: 'column', flexShrink: 0 }}
      >
      <box marginTop={1} flexShrink={0}>
        <text fg={theme.text} wrapMode='word'>{props.view.question}</text>
      </box>
      <box flexDirection='column' marginTop={1} flexShrink={0}>
        <For each={props.view.options}>
          {(option, index) => (
            <box id={`question-${props.view.activeIndex}-option-${index()}`} flexDirection='column' flexShrink={0}>
              <box
                flexDirection='row'
                width='100%'
                paddingX={1}
                backgroundColor={option.selected ? theme.questionSelectedBg : option.focused ? theme.selectionBg : undefined}
                flexShrink={0}
                onMouseOver={() => props.app.focusQuestionOption(index())}
                onMouseUp={event => {
                  if (event.button !== 0) return
                  event.stopPropagation()
                  props.app.activateQuestionOption(index())
                }}
              >
                <text
                  fg={option.selected ? theme.success : option.focused ? theme.selectionText : theme.muted}
                  attributes={option.focused || option.selected ? TextAttributes.BOLD : 0}
                  width={columns().marker}
                  minWidth={columns().marker}
                  flexShrink={0}
                  wrapMode='none'
                >
                  {props.view.multiSelect
                    ? option.selected ? '✓ ' : '○ '
                    : `${index() + 1} `}
                </text>
                <box flexDirection='row' minWidth={0} flexShrink={0}>
                  <box width={columns().label} minWidth={columns().label} flexDirection='column' flexShrink={0}>
                    <text width='100%' fg={option.focused ? theme.selectionText : theme.text} wrapMode='word'>
                      <span style={{ bold: option.focused || option.selected }}>{option.label}</span>
                      <Show when={option.recommended}>
                        <span style={{ fg: theme.warning }}>{columns().label < 14 ? ' (Rec.)' : ' (Recommended)'}</span>
                      </Show>
                    </text>
                  </box>
                  <box width={columns().gap} flexShrink={0} />
                  <box width={columns().description} minWidth={columns().description} flexDirection='column' flexShrink={0}>
                    <text width='100%' fg={option.focused ? theme.selectionMuted : theme.muted} wrapMode='word'>{option.description || ' '}</text>
                  </box>
                </box>
              </box>
              <Show when={option.noteOpen}>
                <box flexDirection='row' width='100%' paddingX={1} flexShrink={0}>
                  <box width={columns().marker} flexShrink={0} />
                  <box flexDirection='row' minWidth={0} flexShrink={0}>
                    <box width={columns().label + columns().gap} flexShrink={0} />
                    <box width={columns().description} minWidth={columns().description} flexDirection='row' flexShrink={0}>
                      <text fg={theme.accent} attributes={TextAttributes.BOLD} wrapMode='none' flexShrink={0}>Note:</text>
                      <box width={1} flexShrink={0} />
                      <WrappedQuestionInput
                        value={option.note}
                        placeholder='Write a note…'
                        focused={option.noteFocused}
                        width={Math.max(1, columns().description - 6)}
                        onMouseDown={event => { if (event.button === 0) props.app.focusQuestionNote(option.label) }}
                        onChange={value => props.app.setQuestionNote(option.label, value)}
                        onSubmit={() => props.app.activateQuestionAction()}
                      />
                    </box>
                  </box>
                </box>
              </Show>
            </box>
          )}
        </For>
      </box>
      {props.view.sketchPreview ? (
        <box ref={value => { previewFrame = value }} renderAfter={drawDividerJunctions} flexDirection='column' marginTop={1} height={previewHeight() + 2} border={true} customBorderChars={sketchBorder} borderColor={theme.dim} flexShrink={0}>
          <scrollbox
            ref={value => { preview = value }}
            height={previewHeight()}
            flexShrink={0}
            scrollX={true} scrollY={true}
            verticalScrollbarOptions={{ visible: false }} horizontalScrollbarOptions={{ visible: false }}
            contentOptions={{ flexShrink: 0, minWidth: sketchWidth(), maxWidth: sketchWidth(), height: sketchLines().length }}
          >
            <text width={sketchWidth()} flexShrink={0} fg={theme.text} wrapMode='none'>{sketchPanel().text}</text>
          </scrollbox>
        </box>
      ) : null}
      </scrollbox>
      <Show when={props.view.error}>
        <box paddingX={1} marginTop={1} flexShrink={0}>
          <text fg={theme.error} wrapMode='word'>{props.view.error}</text>
        </box>
      </Show>
      <box flexDirection='row' alignItems='flex-start' paddingX={1} marginTop={1} flexShrink={0}>
        <Show when={props.view.allowText}>
          <text
            fg={props.view.focus === 'answer' ? theme.selectionText : theme.muted}
            attributes={props.view.focus === 'answer' ? TextAttributes.BOLD : 0}
            wrapMode='none'
          >{`${props.view.options.length + 1} `}</text>
          <WrappedQuestionInput
            value={props.view.text}
            placeholder='Something else…'
            focused={props.view.focus === 'answer'}
            width={questionDockAnswerWidth(contentWidth(), props.view.options.length, props.view.actionLabel)}
            onMouseDown={event => { if (event.button === 0) props.app.focusQuestionAnswer() }}
            onChange={value => props.app.setQuestionText(value)}
            onSubmit={() => props.app.activateQuestionAction()}
          />
          <box flexGrow={1} minWidth={0} />
        </Show>
        <box
          paddingX={1}
          backgroundColor={primaryAction() ? theme.questionActionBg : props.view.focus === 'action' ? theme.selectionBg : undefined}
          flexShrink={0}
          onMouseOver={() => props.app.focusQuestionAction()}
          onMouseUp={event => {
            if (event.button !== 0) return
            event.stopPropagation()
            props.app.activateQuestionAction()
          }}
        >
          <text
            fg={primaryAction() ? theme.questionActionText : props.view.focus === 'action' ? theme.selectionText : theme.text}
            attributes={primaryAction() || props.view.focus === 'action' ? TextAttributes.BOLD : 0}
            wrapMode='none'
          >
            {props.view.submitting ? 'Submitting…' : props.view.actionLabel}
          </text>
        </box>
      </box>
      <box marginTop={1} flexShrink={0}>
        <text fg={theme.dim} wrapMode='word'>
          {contentWidth() < 60 ? (props.view.sketchPreview ? '↑↓ · Enter · Tab · Esc · ⇧arrows pan' : '↑↓ choose · Enter · Tab · Esc stop') : <>
          {props.view.sketchPreview ? 'Shift+arrows sketch · PgUp/PgDn scroll · ' : ''}
          {props.view.focus === 'options'
            ? '↑↓ choose · Enter select/continue · n add note · ←→ question · Tab next · Esc stop'
            : props.view.focus === 'note'
              ? 'Tab next field · Shift+Tab choice · Enter continue or submit · Esc stop'
              : props.view.focus === 'answer'
                ? 'Tab action · Enter continue or submit · Esc stop'
                : 'Enter continue or submit · Shift+Tab back · ←→ question · Esc stop'}
          </>}
        </text>
      </box>
    </box>
  )
}
