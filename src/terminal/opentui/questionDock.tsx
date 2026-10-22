import { For, Show, createEffect } from 'solid-js'
import { TextAttributes, type KeyBinding, type TextareaRenderable } from '@opentui/core'

import type { OpenTuiApplication } from './app'
import { opentuiTheme } from './theme'
import type { QuestionDockView } from './questionDockState'

const theme = opentuiTheme

const answerKeyBindings: KeyBinding[] = [
  { name: 'return', action: 'submit' },
  { name: 'kpenter', action: 'submit' },
  { name: 'linefeed', action: 'submit' }
]

export function QuestionDock(props: { app: OpenTuiApplication; view: QuestionDockView }) {
  let answer: TextareaRenderable | undefined
  const noteFields = new Map<string, TextareaRenderable>()
  const primaryAction = () => props.view.actionLabel.startsWith('Continue')

  createEffect(() => {
    const view = props.view
    view.activeIndex
    if (view.allowText && answer && answer.plainText !== view.text) answer.setText(view.text)
    for (const option of view.options) {
      const field = noteFields.get(option.label)
      if (option.noteOpen && field && field.plainText !== option.note) field.setText(option.note)
    }
  })

  return (
    <box
      flexDirection='column'
      border={['top']}
      borderStyle='single'
      borderColor={theme.dim}
      backgroundColor={theme.panel}
      paddingX={1}
      marginTop={0}
      flexShrink={0}
    >
      <Show
        when={!props.view.collapsed}
        fallback={(
          <box flexDirection='row' justifyContent='space-between' flexShrink={0}>
            <text fg={theme.text} wrapMode='none' truncate={true} flexGrow={1}>
              {props.view.summary} · {props.view.activeIndex + 1} of {props.view.count}
            </text>
            <text fg={theme.dim} wrapMode='none'>Tab reopen · Esc stop</text>
          </box>
        )}
      >
        <box flexDirection='row' alignItems='center' flexShrink={0}>
          <text fg={theme.text} wrapMode='word' flexGrow={1} minWidth={0}>{props.view.question}</text>
          <text fg={theme.dim} wrapMode='none' flexShrink={0}>
            {' '}
            <Show when={props.view.activeIndex > 0} fallback={<span style={{ fg: theme.dim }}>‹</span>}>
              <span style={{ fg: theme.muted }}>‹</span>
            </Show>
            {' '}{props.view.activeIndex + 1} of {props.view.count}{' '}
            <Show when={props.view.activeIndex + 1 < props.view.count} fallback={<span style={{ fg: theme.dim }}>›</span>}>
              <span style={{ fg: theme.muted }}>›</span>
            </Show>
            {' '}×
          </text>
        </box>
        <Show when={props.view.options.length > 0}>
          <box flexDirection='column' marginTop={1} flexShrink={0}>
            <For each={props.view.options}>
              {(option, index) => (
                <box flexDirection='column' flexShrink={0}>
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
                      wrapMode='none'
                    >
                      {props.view.multiSelect
                        ? option.selected ? '☑ ' : '☐ '
                        : `${index() + 1} `}
                    </text>
                    <box flexDirection='column' flexGrow={1} minWidth={0}>
                      <text fg={option.focused ? theme.selectionText : theme.text} wrapMode='word'>
                        <span style={{ bold: option.focused || option.selected }}>{option.label}</span>
                        <Show when={option.recommended}>
                          <span style={{ fg: theme.warning }}> (Recommended)</span>
                        </Show>
                      </text>
                      <Show when={option.description}>
                        <text fg={option.focused ? theme.selectionMuted : theme.muted} wrapMode='word'>{option.description}</text>
                      </Show>
                    </box>
                  </box>
                  <Show when={option.noteOpen}>
                    <box flexDirection='row' paddingLeft={4} flexShrink={0}>
                      <textarea
                        ref={value => {
                          if (value) noteFields.set(option.label, value)
                          else noteFields.delete(option.label)
                        }}
                        flexGrow={1}
                        minWidth={0}
                        height={1}
                        minHeight={1}
                        maxHeight={1}
                        wrapMode='none'
                        backgroundColor='transparent'
                        focusedBackgroundColor='transparent'
                        textColor={theme.text}
                        focusedTextColor={theme.text}
                        placeholder='Write a note…'
                        placeholderColor={theme.dim}
                        focused={option.noteFocused}
                        onMouseDown={event => {
                          if (event.button === 0) props.app.focusQuestionNote(option.label)
                        }}
                        keyBindings={answerKeyBindings}
                        onContentChange={() => props.app.setQuestionNote(option.label, noteFields.get(option.label)?.plainText ?? '')}
                        onSubmit={() => {
                          props.app.setQuestionNote(option.label, noteFields.get(option.label)?.plainText ?? '')
                          props.app.activateQuestionAction()
                        }}
                      />
                    </box>
                  </Show>
                </box>
              )}
            </For>
          </box>
        </Show>
        <box flexDirection='row' alignItems='center' paddingX={1} marginTop={1} flexShrink={0}>
          <Show when={props.view.allowText}>
            <text
              fg={props.view.focus === 'answer' ? theme.selectionText : theme.muted}
              attributes={props.view.focus === 'answer' ? TextAttributes.BOLD : 0}
              wrapMode='none'
            >{`${props.view.options.length + 1} `}</text>
            <textarea
              ref={value => { answer = value }}
              flexGrow={1}
              minWidth={0}
              height={1}
              minHeight={1}
              maxHeight={1}
              wrapMode='none'
              backgroundColor='transparent'
              focusedBackgroundColor='transparent'
              textColor={theme.text}
              focusedTextColor={theme.text}
              placeholder='Something else…'
              placeholderColor={theme.dim}
              focused={props.view.focus === 'answer'}
              onMouseDown={event => {
                if (event.button === 0) props.app.focusQuestionAnswer()
              }}
              keyBindings={answerKeyBindings}
              onContentChange={() => props.app.setQuestionText(answer?.plainText ?? '')}
              onSubmit={() => {
                props.app.setQuestionText(answer?.plainText ?? '')
                props.app.activateQuestionAction()
              }}
            />
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
              {props.view.actionLabel}
            </text>
          </box>
        </box>
        <box marginTop={1} flexShrink={0}>
          <text fg={theme.dim} wrapMode='word'>
            {props.view.focus === 'options'
              ? '↑↓ choose · Enter select/continue · Tab add note · ←→ question · x collapse · Esc stop'
              : props.view.focus === 'note'
                ? 'Tab next note/answer · Shift+Tab choice · Enter continue or submit · Esc stop'
                : props.view.focus === 'answer'
                  ? 'Tab next · Enter continue or submit · Esc stop'
                  : props.view.focus === 'action'
                    ? 'Enter continue or submit · x collapse · Tab composer · Shift+Tab back'
                    : 'Shift+Tab previous · Esc stop'}
          </text>
        </box>
      </Show>
    </box>
  )
}
