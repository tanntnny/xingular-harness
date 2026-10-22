import type { TUI } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'

import {
  centeredDialogHost, centeredRect, dialogFits, dialogRows, dialogWidth, pageOverlayOptions, pageRows
} from './dialogGeometry'

const host = (columns: number, rows: number, centered = true) =>
  ({ terminal: { columns, rows }, centeredDialogs: centered }) as unknown as TUI

describe('centered dialog geometry', () => {
  it('takes 80% of the terminal, capped at 100 columns and 30 rows', () => {
    expect(dialogWidth(40)).toBe(32)
    expect(dialogWidth(80)).toBe(64)
    expect(dialogWidth(120)).toBe(96)
    expect(dialogWidth(200)).toBe(100)
    expect(dialogRows(20)).toBe(16)
    expect(dialogRows(24)).toBe(19)
    expect(dialogRows(40)).toBe(30)
    expect(dialogRows(80)).toBe(30)
  })

  it('never exceeds a tiny screen, and falls back when the dialog would be unreadable', () => {
    for (const columns of [1, 10, 20, 29, 30, 31]) expect(dialogWidth(columns)).toBeLessThanOrEqual(columns)
    for (const rows of [1, 4, 8, 11, 12]) expect(dialogRows(rows)).toBeLessThanOrEqual(rows)
    expect(dialogFits(40, 20)).toBe(true)
    expect(dialogFits(38, 20)).toBe(true)
    expect(dialogFits(37, 20)).toBe(false)
    expect(dialogFits(40, 15)).toBe(true)
    expect(dialogFits(40, 14)).toBe(false)
  })

  it('centers the rectangle and clamps it to the screen', () => {
    expect(centeredRect(80, 24, 64, 19)).toEqual({ top: 2, left: 8, width: 64, height: 19 })
    expect(centeredRect(120, 40, 96, 30)).toEqual({ top: 5, left: 12, width: 96, height: 30 })
    expect(centeredRect(20, 10, 40, 20)).toEqual({ top: 0, left: 0, width: 20, height: 10 })
  })

  it('gives page rows only to a host that presents centered dialogs', () => {
    expect(centeredDialogHost(host(80, 24))).toBe(true)
    expect(centeredDialogHost(host(80, 24, false))).toBe(false)
    expect(pageRows(host(80, 24))).toBe(19)
    expect(pageRows(host(80, 24, false))).toBe(24)
    expect(pageRows(host(30, 20))).toBe(20)
  })

  it('marks a page overlay for hosts that center it', () => {
    expect(pageOverlayOptions()).toMatchObject({ width: '100%', maxHeight: '100%', anchor: 'top-left', dialog: 'page' })
  })
})
