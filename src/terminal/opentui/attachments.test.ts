import { describe, expect, it } from 'vitest'

import { ComposerAttachments, isLargePaste, parsePastedImagePaths } from './attachments'

describe('composer attachments', () => {
  it('labels images and large pastes in order', () => {
    const attachments = new ComposerAttachments()
    expect(attachments.addImage('AAAA', 'image/png').label).toBe('[Image #1]')
    expect(attachments.addText('a\nb\nc\nd').label).toBe('[Pasted text #2 +4 lines]')
    expect(attachments.addText('x'.repeat(900)).label).toBe('[Pasted text #3 900 chars]')
  })

  it('collapses only large pastes', () => {
    expect(isLargePaste('one line')).toBe(false)
    expect(isLargePaste('a\nb\nc')).toBe(false)
    expect(isLargePaste('a\nb\nc\nd')).toBe(true)
    expect(isLargePaste('x'.repeat(801))).toBe(true)
  })

  it('expands pasted text and sends images beside the text', () => {
    const attachments = new ComposerAttachments()
    attachments.addImage('IMG', 'image/png')
    attachments.addText('l1\nl2\nl3\nl4')
    const draft = 'look at [Image #1] and [Pasted text #2 +4 lines] then [Image #1]'
    expect(attachments.expand(draft)).toEqual({
      text: 'look at [Image #1] and l1\nl2\nl3\nl4 then [Image #1]',
      images: [{ type: 'image', data: 'IMG', mimeType: 'image/png' }]
    })
  })

  it('leaves typed labels without an attachment alone', () => {
    const attachments = new ComposerAttachments()
    expect(attachments.expand('see [Image #4]')).toEqual({ text: 'see [Image #4]', images: [] })
  })

  it('drops an attachment once its placed label leaves the draft', () => {
    const attachments = new ComposerAttachments()
    attachments.addImage('IMG', 'image/png')
    attachments.retain('')
    expect(attachments.size).toBe(1)
    attachments.retain('hi [Image #1]')
    attachments.retain('hi [Image')
    expect(attachments.size).toBe(0)
    expect(attachments.expand('hi [Image #1]').images).toEqual([])
  })

  it('restores scratch attachments after browsing history without attaching them to recalled labels', () => {
    const attachments = new ComposerAttachments()
    const image = attachments.addImage('IMG', 'image/png')
    const pasted = attachments.addText('one\ntwo\nthree\nfour')
    const scratch = `Review ${image.label} ${pasted.label}`
    attachments.retain(scratch)
    const snapshot = attachments.snapshot()

    const history = 'Earlier [Image #1] [Pasted text #8 +8 lines]'
    attachments.clearForDraft(history)
    expect(attachments.expand(history)).toEqual({ text: history, images: [] })
    expect(attachments.addImage('NEW', 'image/png').label).toBe('[Image #9]')

    attachments.restore(snapshot)
    expect(attachments.labels().map(item => item.label)).toEqual([image.label, pasted.label])
    expect(attachments.expand(scratch)).toEqual({
      text: 'Review [Image #1] one\ntwo\nthree\nfour',
      images: [{ type: 'image', data: 'IMG', mimeType: 'image/png' }]
    })
  })

  it('restarts numbering when cleared', () => {
    const attachments = new ComposerAttachments()
    attachments.addImage('A', 'image/png')
    attachments.clear()
    expect(attachments.addImage('B', 'image/png').label).toBe('[Image #1]')
  })
})

describe('pasted image paths', () => {
  const files = new Set(['/tmp/a.png', '/tmp/my shot.jpg', '/tmp/c.webp'])
  const exists = (path: string) => files.has(path)

  it('recognises dropped, escaped, quoted and file URL paths', () => {
    expect(parsePastedImagePaths('/tmp/a.png', exists)).toEqual(['/tmp/a.png'])
    expect(parsePastedImagePaths('/tmp/my\\ shot.jpg /tmp/a.png', exists)).toEqual(['/tmp/my shot.jpg', '/tmp/a.png'])
    expect(parsePastedImagePaths("'/tmp/my shot.jpg'\n/tmp/c.webp", exists)).toEqual(['/tmp/my shot.jpg', '/tmp/c.webp'])
    expect(parsePastedImagePaths('/tmp/my shot.jpg', exists)).toEqual(['/tmp/my shot.jpg'])
    expect(parsePastedImagePaths('file:///tmp/a.png', exists)).toEqual(['/tmp/a.png'])
  })

  it('ignores text, missing files and non-images', () => {
    expect(parsePastedImagePaths('look at /tmp/a.png', exists)).toBeNull()
    expect(parsePastedImagePaths('/tmp/missing.png', exists)).toBeNull()
    expect(parsePastedImagePaths('/tmp/notes.txt', () => true)).toBeNull()
    expect(parsePastedImagePaths('   ', exists)).toBeNull()
  })
})
