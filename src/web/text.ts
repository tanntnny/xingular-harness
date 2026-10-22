// Which bodies are text a page can be read from.
export function isHtmlType(contentType: string): boolean {
  return /^(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType)
}

export function isTextType(contentType: string): boolean {
  return /^(?:text\/|application\/(?:json|xml|xhtml\+xml|ld\+json)\b)/i.test(contentType) || contentType === ''
}
