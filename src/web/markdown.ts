// A fetched page as Markdown an agent can read. Content a person would not see is dropped first:
// hidden text is a known way to slip instructions to a model. A page nested deeper than any real
// page is refused rather than converted, so a hostile page cannot stall the conversion.
import { parseHTML } from 'linkedom'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'

/** Deeper than this, a page is not converted. */
export const MAX_DEPTH = 512

const INVISIBLE = 'script, style, noscript, template, iframe, object, embed, svg, canvas, head, link, meta, input[type="hidden"], [hidden], [aria-hidden="true"]'
const HIDING_STYLE = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\.0+)?\s*(?:;|$)|font-size\s*:\s*0(?:px)?\s*(?:;|$))/i

interface Node { nodeType: number; childNodes: ArrayLike<Node> }

function depth(node: Node, limit: number): number {
  let deepest = 0
  const stack: [Node, number][] = [[node, 0]]
  while (stack.length) {
    const [current, level] = stack.pop()!
    if (level > deepest) deepest = level
    if (deepest > limit) return deepest
    for (let index = 0; index < current.childNodes.length; index += 1) {
      const child = current.childNodes[index]
      if (child.nodeType === 1) stack.push([child, level + 1])
    }
  }
  return deepest
}

function converter(): TurndownService {
  const service = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*' })
  service.use(gfm)
  // An image is a word, not a link the model may follow without reading the page.
  service.addRule('image', { filter: 'img', replacement: (_content, node) => {
    const alt = (node as unknown as { getAttribute(name: string): string | null }).getAttribute('alt')?.trim()
    return alt ? `[image: ${alt}]` : ''
  } })
  return service
}

export interface PageText {
  title: string
  text: string
}

/** The page's title and its visible content as Markdown. Throws when the page cannot be converted safely. */
export function htmlToMarkdown(html: string): PageText {
  const { document } = parseHTML(html.includes('<html') ? html : `<!doctype html><html><body>${html}</body></html>`)
  const title = (document.querySelector('title')?.textContent ?? '').replace(/\s+/g, ' ').trim()
  const body = document.body ?? document.documentElement
  if (!body) return { title, text: '' }
  if (depth(body as unknown as Node, MAX_DEPTH) > MAX_DEPTH) throw new Error('The page is nested too deeply to convert safely.')
  for (const element of [...body.querySelectorAll(INVISIBLE)]) element.remove()
  for (const element of [...body.querySelectorAll('[style]')]) {
    if (HIDING_STYLE.test(element.getAttribute('style') ?? '')) element.remove()
  }
  const text = converter().turndown(body.innerHTML)
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
  return { title, text }
}

/** Plain text of Markdown: emphasis and link targets dropped, for `format: "text"`. */
export function markdownToText(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*|__|\*|_|`)/g, '')
    .trim()
}
