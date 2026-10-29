import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'
import { volatileComputerImages } from './volatileImages'

describe('volatile computer images', () => {
  it('keeps screenshot bytes out of Pi history while restoring them for a live request', () => {
    const root = mkdtempSync(join(tmpdir(), 'computer-image-'))
    try {
      const manager = SessionManager.create(root, root)
      const volatile = volatileComputerImages(manager)
      manager.appendMessage({ role: 'user', content: 'inspect', timestamp: Date.now() })
      manager.appendMessage({ role: 'toolResult', toolName: 'computer_screenshot', toolCallId: 'call-1', content: [{ type: 'text', text: 'unique-image-marker' }, { type: 'image', mimeType: 'image/png', data: 'unique-image-marker' }], details: { unexpected: 'unique-image-marker' }, isError: false, timestamp: Date.now() })
      const file = manager.getSessionFile()!
      expect(readFileSync(file, 'utf8')).not.toContain('unique-image-marker')
      const projection = manager.buildSessionProjection().messages
      expect(JSON.stringify(projection)).not.toContain('unique-image-marker')
      expect(JSON.stringify(volatile.restore(projection))).toContain('unique-image-marker')
      volatile.clear()
      expect(JSON.stringify(volatile.restore(projection))).not.toContain('unique-image-marker')
      volatile.dispose()
      const reopened = SessionManager.open(file)
      expect(JSON.stringify(reopened.buildSessionProjection().messages)).not.toContain('unique-image-marker')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
