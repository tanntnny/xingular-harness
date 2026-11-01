import { describe, expect, it } from 'vitest'

import { toolDisplayName } from './toolName'

describe('toolDisplayName', () => {
  it('renders a tool id in CamelCase', () => {
    expect(toolDisplayName('computer_screenshot')).toBe('ComputerScreenshot')
    expect(toolDisplayName('mcp_list_tools')).toBe('McpListTools')
    expect(toolDisplayName('read')).toBe('Read')
    expect(toolDisplayName('bash')).toBe('Bash')
    expect(toolDisplayName('write')).toBe('Write')
  })

  it('treats every separator in an id the same way', () => {
    expect(toolDisplayName('xingular-slice-continue')).toBe('XingularSliceContinue')
    expect(toolDisplayName('computer.screenshot')).toBe('ComputerScreenshot')
    expect(toolDisplayName('n1a2b3c4d5e6f_create_issue')).toBe('N1a2b3c4d5e6fCreateIssue')
  })

  it('keeps capitals the name already has', () => {
    expect(toolDisplayName('customTool')).toBe('CustomTool')
    expect(toolDisplayName('TodoWrite')).toBe('TodoWrite')
  })

  it('returns nothing for an id with no letters or digits', () => {
    expect(toolDisplayName('')).toBe('')
    expect(toolDisplayName('__')).toBe('')
  })
})
