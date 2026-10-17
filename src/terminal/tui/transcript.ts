import { AssistantMessageComponent, BranchSummaryMessageComponent, CompactionSummaryMessageComponent, CustomMessageComponent, ToolExecutionComponent, UserMessageComponent, getMarkdownTheme, type AgentSession, type AgentSessionEvent, type Theme, type ToolRenderers } from '@earendil-works/pi-coding-agent'
import { Container, Text, type Component, type TUI } from '@earendil-works/pi-tui'
import { harnessToolRenderers } from './tools'
import type { AgentMessage } from '@earendil-works/pi-agent-core'

type BuiltinRenderers = (name: string, definition: ToolRenderers | undefined) => ToolRenderers | undefined

/** A projection of SDK history/events. This module never executes tools or writes run records. */
export class TerminalTranscript extends Container {
  private tools = new Map<string, ToolExecutionComponent>()
  private assistant?: AssistantMessageComponent
  private session?: AgentSession
  private hideThinking = false
  private expanded = false
  private hiddenLabel = 'Thinking…'

  constructor(private readonly tui: TUI, private readonly theme: () => Theme, private readonly builtinRenderers: BuiltinRenderers) { super() }

  clearSession(): void {
    for (const component of this.children) {
      try { (component as Component & { dispose?(): void }).dispose?.() } catch { /* Detach every component even when a plugin's cleanup fails. */ }
    }
    this.clear()
    this.tools.clear()
    this.assistant = undefined
    this.session = undefined
  }

  bind(session: AgentSession): void {
    this.clearSession()
    this.session = session
    this.hideThinking = session.settingsManager.getHideThinkingBlock()
    for (const projected of session.sessionManager.buildSessionProjection().entries) {
      if (projected.sourceEntry.type === 'custom') {
        const entry = projected.sourceEntry
        const component = session.extensionRunner.getEntryRenderer(entry.customType)?.(entry, { expanded: this.expanded }, this.theme())
        if (component) this.addChild(component)
      }
      for (const message of projected.messages) this.message(message, false)
    }
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded
    for (const component of this.children) {
      if ('setExpanded' in component) (component as Component & { setExpanded(value: boolean): void }).setExpanded(expanded)
    }
  }

  setThinking(hidden: boolean, label = this.hiddenLabel): void {
    if (this.hideThinking === hidden && this.hiddenLabel === label) return
    this.hideThinking = hidden
    this.hiddenLabel = label
    for (const component of this.children) if (component instanceof AssistantMessageComponent) {
      component.setHideThinkingBlock(hidden)
      component.setHiddenThinkingLabel(label)
    }
  }

  private tool(id: string, name: string, args: unknown): ToolExecutionComponent {
    let component = this.tools.get(id)
    if (!component) {
      const session = this.session!
      const renderer = harnessToolRenderers(name, () => session.extensionRunner.resolveToolRenderers(name, () => this.builtinRenderers(name, session.getToolDefinition(name))))
      component = new ToolExecutionComponent(name, id, args, {
        showImages: session.settingsManager.getShowImages(), imageWidthCells: session.settingsManager.getImageWidthCells(), outputPad: 1
      }, renderer, this.tui, session.sessionManager.getCwd())
      component.setExpanded(this.expanded)
      this.tools.set(id, component)
      this.addChild(component)
    } else component.updateArgs(args)
    return component
  }

  private message(message: AgentMessage, streaming: boolean): void {
    const session = this.session!
    const transformers = session.extensionRunner.getMarkdownTransformers()
    if (message.role === 'user') {
      const text = typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
      const images = typeof message.content === 'string' ? 0 : message.content.filter(part => part.type === 'image').length
      const content = [text, images ? `[${images} attached image${images === 1 ? '' : 's'}]` : ''].filter(Boolean).join('\n')
      if (content) this.addChild(new UserMessageComponent(content, getMarkdownTheme(), 1, transformers))
    } else if (message.role === 'assistant') {
      const assistant = new AssistantMessageComponent(message, this.hideThinking, getMarkdownTheme(), this.hiddenLabel, 1, transformers)
      assistant.updateContent(message, streaming)
      this.addChild(assistant)
      this.assistant = streaming ? assistant : undefined
      for (const part of message.content) if (part.type === 'toolCall') {
        const component = this.tool(part.id, part.name, part.arguments)
        if (!streaming) component.setArgsComplete()
        if (message.stopReason === 'error' || message.stopReason === 'aborted') component.updateResult({ content: [{ type: 'text', text: message.errorMessage ?? 'Operation aborted' }], isError: true })
      }
    } else if (message.role === 'toolResult') {
      this.tools.get(message.toolCallId)?.updateResult(message)
    } else if (message.role === 'custom') {
      if (message.display) this.addChild(new CustomMessageComponent(message, session.extensionRunner.getMessageRenderer(message.customType), getMarkdownTheme(), 1))
    } else if (message.role === 'compactionSummary') this.addChild(new CompactionSummaryMessageComponent(message, getMarkdownTheme(), 1))
    else if (message.role === 'branchSummary') this.addChild(new BranchSummaryMessageComponent(message, getMarkdownTheme(), 1))
    else if (message.role === 'bashExecution') {
      this.addChild(new Text(this.theme().fg('muted', `$ ${message.command}\n${message.output}`), 1, 1))
    }
  }

  accept(event: AgentSessionEvent): void {
    if (event.type === 'message_start') this.message(event.message, event.message.role === 'assistant')
    else if (event.type === 'message_update' && event.message.role === 'assistant') {
      if (!this.assistant) this.message(event.message, true)
      else this.assistant.updateContent(event.message, true)
      for (const part of event.message.content) if (part.type === 'toolCall') this.tool(part.id, part.name, part.arguments)
    } else if (event.type === 'message_end') {
      if (event.message.role === 'assistant') {
        this.assistant?.updateContent(event.message, false)
        this.assistant = undefined
        for (const part of event.message.content) if (part.type === 'toolCall') this.tool(part.id, part.name, part.arguments).setArgsComplete()
      } else if (event.message.role === 'toolResult') this.tools.get(event.message.toolCallId)?.updateResult(event.message)
    } else if (event.type === 'tool_execution_start') this.tool(event.toolCallId, event.toolName, event.args).markExecutionStarted()
    else if (event.type === 'tool_execution_update') this.tool(event.toolCallId, event.toolName, event.args).updateResult({ ...event.partialResult, isError: false }, true)
    else if (event.type === 'tool_execution_end') this.tools.get(event.toolCallId)?.updateResult({ ...event.result, isError: event.isError, durationMs: event.durationMs })
    else if (event.type === 'entry_appended' && event.entry.type === 'custom') {
      const component = this.session!.extensionRunner.getEntryRenderer(event.entry.customType)?.(event.entry, { expanded: this.expanded }, this.theme())
      if (component) this.addChild(component)
    }
  }
}
