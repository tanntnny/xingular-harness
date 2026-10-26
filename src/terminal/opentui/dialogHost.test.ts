import { describe, expect, it, vi } from 'vitest'
import type { Component, OverlayOptions } from '@earendil-works/pi-tui'

import { asTui, PiDialogHost } from './dialogHost'
import type { TerminalMouseInput } from '../tui/mouse'
import type { OpenTuiMouseInput } from './mouse'

function component(render: (width: number) => string[], onInput?: (data: string) => void): Component {
  return {
    render,
    handleInput: (data: string) => onInput?.(data),
    invalidate: () => {}
  } as unknown as Component
}

describe('PiDialogHost', () => {
  it('renders an overlay at its declared width and slices it to the height', () => {
    const host = new PiDialogHost(() => {})
    host.showOverlay(component(width => [`width ${width}`, 'second', 'third']), { width: 20, maxHeight: 2 })
    const view = host.overlay()
    expect(view?.width).toBe(20)
    expect(view?.lines.map(line => line.spans.map(span => span.text).join(''))).toEqual(['width 20', 'second'])
    expect(view?.fullscreen).toBe(false)
  })

  it('forwards keys to the overlay and reports whether it took them', () => {
    const keys: string[] = []
    const host = new PiDialogHost(() => {})
    host.showOverlay(component(() => ['dialog'], data => keys.push(data)))
    expect(host.sendToOverlay('\x1b[B')).toBe(true)
    expect(keys).toEqual(['\x1b[B'])
    host.hideOverlay()
    expect(host.sendToOverlay('\x1b[B')).toBe(false)
  })

  it('forwards pasted text through the bracketed-paste protocol', () => {
    const inputs: string[] = []
    const host = new PiDialogHost(() => {})
    host.showOverlay(component(() => ['dialog'], data => inputs.push(data)))

    expect(host.sendPasteToOverlay('first line\nsecond line')).toBe(true)
    expect(inputs).toEqual(['\x1b[200~first line\nsecond line\x1b[201~'])
    expect(host.sendPasteToOverlay('')).toBe(false)
  })

  it('normalizes OpenTUI clicks to component-local TUI mouse events', () => {
    const events: TerminalMouseInput[] = []
    const changed = vi.fn()
    const host = new PiDialogHost(changed)
    host.resize(80, 24)
    host.showOverlay({
      render: () => Array.from({ length: 8 }, (_, index) => `row ${index}`),
      handleInput: () => {},
      handleMouse: event => { events.push(event); return { handled: true, render: true } },
      invalidate: () => {}
    }, { anchor: 'top-left', width: '100%', maxHeight: '100%', dialog: 'page' } as OverlayOptions)
    host.overlay()

    const click: OpenTuiMouseInput = {
      type: 'up', button: 0, x: 11, y: 10, modifiers: { shift: false, alt: false, ctrl: false }
    }
    expect(host.sendMouseToOverlay(click)).toBe(true)
    expect(events[0]).toMatchObject({
      type: 'click', button: 'left', x: 3, y: 2, screenX: 11, screenY: 10, width: 64, height: 8
    })
    expect(changed).toHaveBeenCalled()
  })

  it('maps scroll direction to TUI wheel deltas', () => {
    const events: TerminalMouseInput[] = []
    const host = new PiDialogHost(() => {})
    host.resize(80, 24)
    host.showOverlay({
      render: () => ['row'],
      handleMouse: event => { events.push(event); return { handled: true } },
      invalidate: () => {}
    }, { anchor: 'top-left', width: '100%', maxHeight: '100%', dialog: 'page' } as OverlayOptions)
    host.overlay()

    expect(host.sendMouseToOverlay({
      type: 'scroll', button: 4, x: 10, y: 11, modifiers: { shift: false, alt: false, ctrl: false },
      scroll: { direction: 'up', delta: 2 }
    })).toBe(true)
    expect(events[0]).toMatchObject({ type: 'wheel', wheelDelta: -2 })
  })

  it('hides and shows an overlay without losing it', () => {
    const host = new PiDialogHost(() => {})
    const handle = host.showOverlay(component(() => ['dialog']))
    expect(handle.isFocused()).toBe(true)
    handle.setHidden(true)
    expect(host.hasOverlay()).toBe(false)
    expect(handle.isHidden()).toBe(true)
    handle.setHidden(false)
    expect(host.overlay()).toBeDefined()
    handle.hide()
    expect(host.overlay()).toBeUndefined()
  })

  it('honours a visibility callback and calls invalidate on resize', () => {
    let invalidated = 0
    const host = new PiDialogHost(() => {})
    const dialog = {
      render: () => ['dialog'],
      handleInput: () => {},
      invalidate: () => { invalidated += 1 }
    } as unknown as Component
    host.showOverlay(dialog, { width: 10, visible: columns => columns >= 50 })
    expect(host.overlay()?.width).toBe(10)
    host.resize(40, 20)
    expect(host.overlay()).toBeUndefined()
    expect(invalidated).toBeGreaterThan(0)
  })

  it('stacks an overlay above a page and reveals the page again', () => {
    const host = new PiDialogHost(() => {})
    host.showOverlay(component(() => ['page']), { anchor: 'top-left', width: '100%', maxHeight: '100%' })
    const dialog = host.showOverlay(component(() => ['confirm']))
    expect(host.overlay()?.lines[0]?.spans[0]?.text).toBe('confirm')
    dialog.hide()
    expect(host.overlay()?.lines[0]?.spans[0]?.text).toBe('page')
    expect(host.overlay()?.fullscreen).toBe(true)
  })

  it('recognizes a fullscreen page', () => {
    const host = new PiDialogHost(() => {})
    host.showOverlay(component(() => ['page']), { anchor: 'top-left', width: '100%', maxHeight: '100%' })
    expect(host.overlay()?.fullscreen).toBe(true)
    expect(host.overlay()?.dialog).toBe(false)
  })

  it('presents a marked page as a centered dialog instead of a fullscreen page', () => {
    const host = new PiDialogHost(() => {})
    host.resize(80, 24)
    const page = host.showOverlay(
      component(width => Array.from({ length: 40 }, (_, index) => `${index} ${width}`)),
      { anchor: 'top-left', width: '100%', maxHeight: '100%', dialog: 'page' } as OverlayOptions
    )
    const view = host.overlay()
    expect(view?.dialog).toBe(true)
    expect(view?.fullscreen).toBe(false)
    expect(view?.width).toBe(64)
    expect(view?.maxHeight).toBe(19)
    expect(view?.lines).toHaveLength(19)
    expect(view?.lines[0]?.spans.map(span => span.text).join('')).toBe('0 64')
    expect(page.getBounds()).toEqual({ row: 2, col: 8, width: 64, height: 19 })
  })

  it('falls back to the fullscreen page when the terminal is too small for a dialog', () => {
    const host = new PiDialogHost(() => {})
    host.resize(30, 20)
    host.showOverlay(component(() => ['page']), { anchor: 'top-left', width: '100%', maxHeight: '100%', dialog: 'page' } as OverlayOptions)
    expect(host.overlay()?.dialog).toBe(false)
    expect(host.overlay()?.fullscreen).toBe(true)
  })

  it('reports a render failure instead of throwing', () => {
    const host = new PiDialogHost(() => {})
    host.showOverlay(component(() => { throw new Error('broken') }))
    expect(host.overlay()?.lines[0]?.spans[0]?.text).toContain('The dialog could not be drawn: broken')
  })

  it('runs extension input listeners in order and stops on consume', () => {
    const host = new PiDialogHost(() => {})
    const seen: string[] = []
    host.addInputListener(data => { seen.push(`a:${data}`); return { data: `${data}!` } })
    host.addInputListener(data => { seen.push(`b:${data}`); return { consume: true } })
    host.addInputListener(data => { seen.push(`c:${data}`); return undefined })
    expect(host.emitInput('x')).toEqual({ consume: true })
    expect(seen).toEqual(['a:x', 'b:x!'])
  })

  it('forwards the terminal title and exposes the Pi TUI shape', () => {
    const host = new PiDialogHost(() => {})
    const titles: string[] = []
    host.onTitle = title => titles.push(title)
    host.terminal.setTitle('Harness')
    expect(titles).toEqual(['Harness'])
    expect(asTui(host)).toBe(host)
    expect(host.mode).toBe('fullscreen')
  })
})
