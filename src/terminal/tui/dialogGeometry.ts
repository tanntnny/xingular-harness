// Centered pages use 80% of the terminal, capped at 100×30. Pages can explicitly
// request the whole screen; OpenTUI reads the presentation through the overlay options.
import type { OverlayOptions, TUI } from '@earendil-works/pi-tui'

export const DIALOG_MAX_WIDTH = 100
export const DIALOG_MAX_ROWS = 30
/** Below this a centered dialog would show too little of the page, so the page keeps the screen. */
const DIALOG_MIN_WIDTH = 30
const DIALOG_MIN_ROWS = 12

/** A page overlay this host may present as a centered dialog. Other hosts ignore the field. */
export interface HarnessOverlayOptions extends OverlayOptions {
  dialog?: 'page'
}

export interface DialogRect {
  top: number
  left: number
  width: number
  height: number
}

/** The width of a centered page dialog: 80% of the terminal, never more than 100 columns. */
export function dialogWidth(columns: number): number {
  const width = Math.trunc(columns)
  if (!Number.isFinite(width) || width < 1) return 0
  return Math.max(1, Math.min(width, DIALOG_MAX_WIDTH, Math.max(20, Math.floor(width * 0.8))))
}

/** The height of a centered page dialog: 80% of the terminal, never more than 30 rows. */
export function dialogRows(rows: number): number {
  const height = Math.trunc(rows)
  if (!Number.isFinite(height) || height < 1) return 0
  return Math.max(1, Math.min(height, DIALOG_MAX_ROWS, Math.max(8, Math.floor(height * 0.8))))
}

/** Whether the terminal can hold a readable page dialog instead of the full-screen page. */
export function dialogFits(columns: number, rows: number): boolean {
  return dialogWidth(columns) >= DIALOG_MIN_WIDTH && dialogRows(rows) >= DIALOG_MIN_ROWS
}

/** The host that presents page overlays as centered dialogs, rather than full-screen pages. */
export function centeredDialogHost(tui: TUI): boolean {
  return (tui as TUI & { centeredDialogs?: boolean }).centeredDialogs === true
}

/** Rows a page or picker should render for this host: the dialog's rows, or the whole screen. */
export function pageRows(tui: TUI): number {
  const rows = Math.max(0, Math.trunc(tui.terminal.rows))
  const columns = Math.max(0, Math.trunc(tui.terminal.columns))
  return centeredDialogHost(tui) && dialogFits(columns, rows) ? dialogRows(rows) : rows
}

/** Centers a rectangle on the screen, clamped so it never starts outside the terminal. */
export function centeredRect(columns: number, rows: number, width: number, height: number): DialogRect {
  const screenColumns = Math.max(1, Math.trunc(columns))
  const screenRows = Math.max(1, Math.trunc(rows))
  const boxWidth = Math.max(1, Math.min(Math.trunc(width), screenColumns))
  const boxHeight = Math.max(1, Math.min(Math.trunc(height), screenRows))
  return {
    top: Math.max(0, Math.floor((screenRows - boxHeight) / 2)),
    left: Math.max(0, Math.floor((screenColumns - boxWidth) / 2)),
    width: boxWidth,
    height: boxHeight
  }
}

/** Page commands declare their presentation; OpenTUI centers only marked dialogs. */
export function pageOverlayOptions(presentation: 'centered' | 'fullscreen' = 'centered'): HarnessOverlayOptions {
  if (presentation === 'fullscreen') return { anchor: 'top-left', width: '100%', maxHeight: '100%' }
  return { anchor: 'top-left', width: '100%', maxHeight: '100%', dialog: 'page' }
}
