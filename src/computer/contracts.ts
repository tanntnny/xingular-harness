// Backend-neutral contracts. Importing this module does not register tools or grant permission.
export const COMPUTER_LIMITS = { id: 128, text: 10_000, dimension: 16_384, imageData: 20_000_000 } as const
export const COMPUTER_KEYS = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Space'] as const

const id = { type: 'string', minLength: 1, maxLength: COMPUTER_LIMITS.id }
const target = { target: id }
export const COMPUTER_CONTROL_SCHEMAS = {
  target: { type: 'object', properties: {}, additionalProperties: false },
  screenshot: { type: 'object', properties: target, required: ['target'], additionalProperties: false },
  click: { type: 'object', properties: { ...target, screenshot: id, x: { type: 'integer', minimum: 0 }, y: { type: 'integer', minimum: 0 }, button: { type: 'string', enum: ['left', 'right', 'middle'] } }, required: ['target', 'screenshot', 'x', 'y', 'button'], additionalProperties: false },
  type: { type: 'object', properties: { ...target, text: { type: 'string', minLength: 1, maxLength: COMPUTER_LIMITS.text } }, required: ['target', 'text'], additionalProperties: false },
  key: { type: 'object', properties: { ...target, key: { type: 'string', enum: COMPUTER_KEYS } }, required: ['target', 'key'], additionalProperties: false },
  activate: { type: 'object', properties: target, required: ['target'], additionalProperties: false }
} as const

export type ComputerKey = typeof COMPUTER_KEYS[number]
export type ComputerButton = 'left' | 'right' | 'middle'
export interface ComputerTargetInput { target: string }
export interface ComputerClickInput extends ComputerTargetInput { screenshot: string; x: number; y: number; button: ComputerButton }
export interface ComputerTypeInput extends ComputerTargetInput { text: string }
export interface ComputerKeyInput extends ComputerTargetInput { key: ComputerKey }
export interface ComputerTarget { target: string }
export interface ComputerControlScreenshot { screenshot: string; data: string; mimeType: 'image/png' | 'image/jpeg'; width: number; height: number }
