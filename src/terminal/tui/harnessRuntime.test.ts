import { expect, it } from 'vitest'

import { harnessRuntimeSelected } from './harnessRuntime'

it('runs the terminal as a client of the harness unless the in-process runtime is asked for', () => {
  expect(harnessRuntimeSelected({})).toBe(true)
  expect(harnessRuntimeSelected({ XINGULAR_TERMINAL_RUNTIME: 'harness' })).toBe(true)
  expect(harnessRuntimeSelected({ XINGULAR_TERMINAL_RUNTIME: 'inprocess' })).toBe(false)
  expect(harnessRuntimeSelected({ XINGULAR_TERMINAL_RUNTIME: ' InProcess ' })).toBe(false)
})
