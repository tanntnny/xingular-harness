// The page helper both front ends run inside a web page to capture and reveal note targets: the
// Harness's own headed browser and a host's web view (PROP-0017). It is plain DOM code with a pull
// model: the front end calls it with one operation (`identity`, `begin`, `capture`, `next`, `toast`,
// `cancel`, `resolve`, `reveal`) and reads the JSON it returns. `begin` with kind `inspect` turns on
// the inspector (PROP-0018): hover outlines, a click or a text drag opens a comment popover, and
// each submitted comment waits for `next`. The page never calls out. Everything it
// returns is page-controlled data, never authentication; the caller validates it before saving.
// No note bodies or host capabilities enter the page.

/** The helper's source. `__ARGS__` is replaced with one JSON operation; the expression evaluates to a JSON string. */
export const PAGE_SCRIPT = String.raw`(() => {
  const args = __ARGS__
  try {
    const key = Symbol.for('xingular.browser.annotations.page.v2')
    if (!globalThis[key]) {
      globalThis[key] = (() => {
        // This fallback also works on non-secure HTTP pages. Neither token is a secret.
        const documentId = globalThis.crypto?.randomUUID?.() ?? 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, char => {
          const random = Math.floor(Math.random() * 16)
          return (char === 'x' ? random : (random & 3) | 8).toString(16)
        })
        const excluded = 'script,style,noscript,template,input,textarea,select,option,iframe,object,embed,[contenteditable],[role="textbox"],[hidden],[inert],[aria-hidden="true"],[data-sensitive],[data-private],[data-annotation-overlay],[data-harness-annotation-overlay],[autocomplete*="password"],[autocomplete*="cc-"],[autocomplete*="one-time-code"]'
        const overlays = new WeakSet()
        const cp = value => Array.from(value)
        const norm = value => String(value ?? '').replace(/\s+/gu, ' ').trim()
        const bounded = (value, size) => cp(norm(value)).slice(0, size).join('')
        const validString = (value, size) => typeof value === 'string' && cp(value).length <= size
        let pending = null
        let picked = null
        let listeners = []
        let mark = null
        let overlay = null
        let frame = 0
        let observer = null
        let mutations = null

        const allowed = element => {
          if (!element || element.getRootNode() !== document || element.closest(excluded)) return false
          for (let current = element; current; current = current.parentElement) {
            if (overlays.has(current) || current.shadowRoot) return false
            const style = getComputedStyle(current)
            if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false
          }
          return element.getClientRects().length > 0
        }
        const block = element => {
          while (element && element !== document.body) {
            if (!['inline', 'contents', 'inline-block'].includes(getComputedStyle(element).display)) return element
            element = element.parentElement
          }
          return document.body
        }
        // ---- The composed tree: open shadow roots and slotted content, in rendered order. Targets
        // captured with it carry tree:'composed'; older targets keep the document-only rules above
        // and below, so a saved note never changes what it points at. Closed shadow roots stay
        // invisible to script, and frames are never entered.
        const refusedContent = 'input,textarea,select,option,iframe,object,embed,[contenteditable],[role="textbox"],[data-sensitive],[data-private],[autocomplete*="password"],[autocomplete*="cc-"],[autocomplete*="one-time-code"]'
        const tooLarge = () => new Error('This page is too large to anchor safely. Use a page note instead.')
        const composedParent = node => node.assignedSlot ?? node.parentElement ?? (node.parentNode instanceof ShadowRoot ? node.parentNode.host : null)
        const flatChildren = node => {
          if (node instanceof Element && node.shadowRoot) return Array.from(node.shadowRoot.childNodes)
          if (node instanceof HTMLSlotElement) {
            const assigned = node.assignedNodes()
            return assigned.length ? assigned : Array.from(node.childNodes)
          }
          return Array.from(node.childNodes)
        }
        const shown = element => {
          if (overlays.has(element) || element.matches(excluded)) return false
          const style = getComputedStyle(element)
          if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false
          return style.display === 'contents' || element.getClientRects().length > 0
        }
        const allowedComposed = element => {
          if (!(element instanceof Element) || !element.isConnected || !element.getClientRects().length) return false
          for (let current = element; current; current = composedParent(current)) if (!shown(current)) return false
          return true
        }
        const rootsOf = node => {
          const roots = []
          for (let root = node?.getRootNode?.(); root instanceof ShadowRoot; root = root.host.getRootNode()) roots.push(root)
          return roots
        }
        const openRoots = () => {
          const roots = []
          const pending = [document]
          let seen = 0
          while (pending.length) {
            for (const element of pending.pop().querySelectorAll('*')) {
              if (++seen > 50000) throw tooLarge()
              if (element.shadowRoot) { roots.push(element.shadowRoot); pending.push(element.shadowRoot) }
            }
          }
          return roots
        }
        const byTagComposed = tag => {
          const found = []
          const pending = [document]
          let seen = 0
          while (pending.length) {
            for (const element of pending.pop().querySelectorAll('*')) {
              if (++seen > 50000) throw tooLarge()
              if (element.localName === tag) found.push(element)
              if (element.shadowRoot) pending.push(element.shadowRoot)
            }
          }
          return found
        }
        const blockComposed = node => {
          let element = composedParent(node)
          while (element && element !== document.body) {
            if (!['inline', 'contents', 'inline-block'].includes(getComputedStyle(element).display)) return element
            element = composedParent(element)
          }
          return document.body
        }
        // The same normalized stream as below, walked over the composed tree. It also records where
        // it passed visible fields or private content, so a selection across one is refused, and
        // where each node starts and ends, so selection boundaries in any tree map to positions.
        const streamComposed = (root = document.body) => {
          const chars = []
          const map = []
          const refused = []
          const spans = new Map()
          if (!root) return { chars, map, refused, spans }
          let texts = 0
          let elements = 0
          let previousBlock
          const append = (char, start, end) => {
            if (/\s/u.test(char)) {
              if (!chars.length) return false
              if (chars.at(-1) === ' ') { map.at(-1).end = end; return false }
              char = ' '
            }
            chars.push(char)
            map.push({ start, end })
            return true
          }
          const closing = Symbol('end of node')
          const stack = [root]
          while (stack.length) {
            const node = stack.pop()
            if (node[closing]) { node[closing].end = chars.length; continue }
            if (node.nodeType === Node.TEXT_NODE) {
              if (++texts > 20000 || chars.length + node.data.length > 250000) throw tooLarge()
              // A component with a closed shadow root shows only the light text it slots; the rest is not rendered.
              const holder = node.parentElement
              if (holder && holder.localName.includes('-') && !holder.shadowRoot) {
                const probe = document.createRange()
                probe.selectNodeContents(node)
                if (!probe.getClientRects().length) continue
              }
              const currentBlock = blockComposed(node)
              if (previousBlock && currentBlock !== previousBlock && chars.length) append(' ', map.at(-1).end, [node, 0])
              previousBlock = currentBlock
              const span = { at: chars.length, starts: [], end: chars.length }
              let offset = 0
              for (const char of node.data) {
                if (append(char, [node, offset], [node, offset + char.length])) span.starts.push(offset)
                offset += char.length
              }
              span.end = chars.length
              spans.set(node, span)
              continue
            }
            if (node.nodeType !== Node.ELEMENT_NODE) continue
            if (++elements > 50000) throw tooLarge()
            if (node !== root && !shown(node)) {
              if (node.matches(refusedContent) && node.getClientRects().length > 0) refused.push(chars.length)
              continue
            }
            const span = { at: chars.length, starts: [], end: chars.length }
            spans.set(node, span)
            stack.push({ [closing]: span })
            const children = flatChildren(node)
            for (let index = children.length - 1; index >= 0; index--) stack.push(children[index])
          }
          if (chars.at(-1) === ' ') { chars.pop(); map.pop() }
          return { chars, map, refused, spans }
        }
        // A boundary point (in any tree) as a stream position: the first character at or after it.
        const positionAt = (data, container, offset) => {
          if (container.nodeType === Node.TEXT_NODE) {
            const span = data.spans.get(container)
            return span ? span.at + span.starts.filter(start => start < offset).length : null
          }
          const children = container.childNodes
          for (let index = offset; index < children.length; index++) {
            const span = data.spans.get(children[index])
            if (span) return span.at
          }
          const own = data.spans.get(container instanceof ShadowRoot ? container.host : container)
          return own ? own.end : null
        }
        const textComposed = element => streamComposed(element).chars.join('')
        // One Range per text node: a Range cannot span shadow trees.
        const segmentsFor = (data, start, end) => {
          const segments = []
          let run = null
          for (let index = start; index < end; index++) {
            const entry = data.map[index]
            if (entry.start[0] !== entry.end[0]) { run = null; continue }
            if (run && run.node === entry.start[0]) { run.range.setEnd(...entry.end); continue }
            const range = document.createRange()
            range.setStart(...entry.start)
            range.setEnd(...entry.end)
            run = { node: entry.start[0], range }
            segments.push(range)
          }
          return segments
        }
        const composedSelectionTarget = () => {
          const selection = getSelection()
          // rangeCount, isCollapsed and getRangeAt see a selection in a shadow root only from the document:
          // WebKit reports no range at all for one that crosses into a component.
          if (!selection || typeof selection.getComposedRanges !== 'function') return null
          const roots = openRoots()
          let ranges
          try { ranges = selection.getComposedRanges({ shadowRoots: roots }) } catch { ranges = selection.getComposedRanges(...roots) }
          const range = ranges?.[0]
          if (!range || range.collapsed) return null
          const data = streamComposed()
          let start = positionAt(data, range.startContainer, range.startOffset)
          let end = positionAt(data, range.endContainer, range.endOffset)
          if (start === null || end === null) return null
          while (data.chars[start] === ' ') start++
          while (end > start && data.chars[end - 1] === ' ') end--
          if (end <= start || end - start > 4000) return null
          // Refuse ranges crossing fields or private content rather than silently capturing partial secrets.
          if (data.refused.some(position => position > start && position < end)) return null
          return {
            target: { kind: 'text', exact: data.chars.slice(start, end).join(''), prefix: data.chars.slice(Math.max(0, start - 128), start).join(''), suffix: data.chars.slice(end, end + 128).join(''), start, end, tree: 'composed' },
            segments: segmentsFor(data, start, end)
          }
        }
        // Positions are normalized Unicode code points. Mapping offsets remain DOM UTF-16.
        const stream = (root = document.body) => {
          const chars = []
          const map = []
          if (!root) return { chars, map }
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
          let node
          let previousBlock
          let visited = 0
          const append = (char, start, end) => {
            if (/\s/u.test(char)) {
              if (!chars.length) return
              if (chars.at(-1) === ' ') { map.at(-1).end = end; return }
              char = ' '
            }
            chars.push(char)
            map.push({ start, end })
          }
          while ((node = walker.nextNode())) {
            if (++visited > 20000 || chars.length + node.data.length > 250000) throw new Error('This page is too large to anchor safely. Use a page note instead.')
            if (!allowed(node.parentElement)) continue
            const currentBlock = block(node.parentElement)
            if (previousBlock && currentBlock !== previousBlock && chars.length) {
              append(' ', map.at(-1).end, [node, 0])
            }
            previousBlock = currentBlock
            let offset = 0
            for (const char of node.data) {
              append(char, [node, offset], [node, offset + char.length])
              offset += char.length
            }
          }
          if (chars.at(-1) === ' ') { chars.pop(); map.pop() }
          return { chars, map }
        }
        const text = element => stream(element).chars.join('')
        const role = element => norm(element.getAttribute('role')) || ({ BUTTON: 'button', A: element.hasAttribute('href') ? 'link' : '', IMG: 'img', SUMMARY: 'button' }[element.tagName] ?? '')
        // composed: read the composed tree (open shadow roots), where ids are scoped to their root.
        const name = (element, composed = false) => {
          const scope = composed ? element.getRootNode() : document
          const labelled = norm(element.getAttribute('aria-labelledby')).split(' ').filter(Boolean).map(id => {
            const label = scope.getElementById?.(id) ?? null
            return composed ? (allowedComposed(label) ? textComposed(label) : '') : (allowed(label) ? text(label) : '')
          }).join(' ')
          return bounded(labelled || element.getAttribute('aria-label') || (element.tagName === 'IMG' ? element.getAttribute('alt') : '') || (composed ? textComposed(element) : text(element)), 200)
        }
        const specificSelector = (selector, tag) => selector.trim().toLowerCase() !== tag.toLowerCase() && ['#', '.', '[', ':', '>', '+', '~'].some(marker => selector.includes(marker))
        const selectorPart = element => {
          const tag = element.localName
          const classes = Array.from(element.classList).slice(0, 3).map(name => '.' + CSS.escape(name)).join('')
          const testId = element.getAttribute('data-testid')
          const identity = element.id ? '#' + CSS.escape(element.id) : tag + (testId ? '[data-testid="' + CSS.escape(testId) + '"]' : '')
          return identity + classes
        }
        const selectorFor = (element, semantic) => {
          const root = element.getRootNode()
          const unique = selector => {
            try {
              const matches = root.querySelectorAll(selector)
              return matches.length === 1 && matches[0] === element
            } catch { return false }
          }
          const direct = selectorPart(element)
          if (cp(direct).length <= 500 && unique(direct) && (semantic || specificSelector(direct, element.localName))) return direct
          const path = []
          for (let current = element; current instanceof Element && current.getRootNode() === root; current = current.parentElement) {
            let part = selectorPart(current)
            const siblings = current.parentElement ? Array.from(current.parentElement.children) : Array.from(root.children ?? [])
            const sameTag = siblings.filter(sibling => sibling.localName === current.localName)
            const index = sameTag.indexOf(current)
            if (!specificSelector(part, current.localName) || sameTag.length > 1) part += ':nth-of-type(' + (index + 1) + ')'
            path.unshift(part)
            const candidate = path.join(' > ')
            if (cp(candidate).length <= 500 && specificSelector(candidate, element.localName) && unique(candidate)) return candidate
          }
          const candidate = path.join(' > ')
          return cp(candidate).length <= 500 ? candidate : cp(direct).length <= 500 ? direct : element.localName
        }
        const describe = (element, composed = false) => {
          const elementName = name(element, composed)
          const elementText = bounded(composed ? textComposed(element) : text(element), 500)
          // At the top of a shadow root the context is the component that holds it.
          const parent = composed ? element.parentElement ?? (element.parentNode instanceof ShadowRoot ? element.parentNode.host : null) : element.parentElement
          const context = composed ? (allowedComposed(parent) ? textComposed(parent) : '') : (allowed(parent) ? text(parent) : '')
          return {
            kind: 'element', tag: element.localName, role: bounded(role(element), 80),
            name: elementName, text: elementText, context: bounded(context, 200),
            selector: selectorFor(element, Boolean(elementName || elementText)),
            ...(composed ? { tree: 'composed' } : {})
          }
        }
        const rangeFor = (data, start, end) => {
          const range = document.createRange()
          range.setStart(...data.map[start].start)
          range.setEnd(...data.map[end - 1].end)
          return range
        }
        const selectionTarget = () => {
          const selection = getSelection()
          if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null
          const range = selection.getRangeAt(0)
          if (range.startContainer.getRootNode() !== document || range.endContainer.getRootNode() !== document) return null
          const data = stream()
          const same = (point, node, offset) => point[0] === node && point[1] === offset
          const indices = data.map.flatMap((entry, index) =>
            range.comparePoint(...entry.end) >= 0 && range.comparePoint(...entry.start) <= 0 &&
            !same(entry.end, range.startContainer, range.startOffset) && !same(entry.start, range.endContainer, range.endOffset) ? [index] : [])
          if (!indices.length) return null
          let start = indices[0]
          let end = indices.at(-1) + 1
          while (data.chars[start] === ' ') start++
          while (data.chars[end - 1] === ' ') end--
          if (end <= start || end - start > 4000) return null
          // Refuse ranges crossing excluded subtrees rather than silently capturing partial secrets.
          const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_ELEMENT)
          let element
          if (range.commonAncestorContainer.nodeType === Node.TEXT_NODE && !allowed(range.commonAncestorContainer.parentElement)) return null
          while ((element = walker.nextNode())) {
            if (!allowed(element) && range.intersectsNode(element)) return null
          }
          return { kind: 'text', exact: data.chars.slice(start, end).join(''), prefix: data.chars.slice(Math.max(0, start - 128), start).join(''), suffix: data.chars.slice(end, end + 128).join(''), start, end }
        }
        const resolve = target => {
          if (!target || typeof target !== 'object') throw new Error('Invalid target')
          if (target.kind === 'page') return { state: 'matched' }
          if ('tree' in target && target.tree !== 'composed') throw new Error('Invalid target tree')
          const composed = target.tree === 'composed'
          if (target.kind === 'text') {
            if (!validString(target.exact, 4000) || !target.exact || norm(target.exact) !== target.exact ||
                !validString(target.prefix, 128) || !validString(target.suffix, 128) ||
                !Number.isSafeInteger(target.start) || !Number.isSafeInteger(target.end) || target.start < 0 || target.end <= target.start) throw new Error('Invalid text target')
            const data = composed ? streamComposed() : stream()
            const quote = cp(target.exact)
            const prefix = cp(target.prefix)
            const suffix = cp(target.suffix)
            const matches = []
            // Do not prefer the stored position: a duplicate there is still ambiguous.
            const content = data.chars.join('')
            let utf16Index = content.indexOf(target.exact)
            let previousUtf16 = 0
            let index = 0
            while (utf16Index >= 0) {
              index += cp(content.slice(previousUtf16, utf16Index)).length
              previousUtf16 = utf16Index
              utf16Index = content.indexOf(target.exact, utf16Index + 1)
              const end = index + quote.length
              if (prefix.length && data.chars.slice(Math.max(0, index - prefix.length), index).join('') !== target.prefix) continue
              if (suffix.length && data.chars.slice(end, end + suffix.length).join('') !== target.suffix) continue
              matches.push([index, end])
              if (matches.length > 1) return { state: 'ambiguous', reason: 'Quote and context match more than once' }
            }
            if (!matches.length) return { state: 'unresolved', reason: 'Quote or context changed or is unavailable' }
            if (!composed) return { state: 'matched', range: rangeFor(data, ...matches[0]) }
            const segments = segmentsFor(data, ...matches[0])
            return segments.length ? { state: 'matched', segments } : { state: 'unresolved', reason: 'Quote or context changed or is unavailable' }
          }
          if (target.kind === 'element') {
            if (!validString(target.tag, 100) || !/^[a-z][a-z0-9-]*$/.test(target.tag) ||
                !validString(target.role, 200) || !validString(target.name, 200) || !validString(target.text, 500) ||
                !validString(target.context, 200) || !validString(target.selector, 500)) throw new Error('Invalid element target')
            const semantic = Boolean(target.name.trim() || target.text.trim())
            const elements = composed ? byTagComposed(target.tag) : document.getElementsByTagName(target.tag)
            if (elements.length > 2000) return { state: 'unresolved', reason: 'Too many element candidates to resolve safely' }
            if (specificSelector(target.selector, target.tag)) {
              let anchored = []
              try {
                anchored = Array.from(elements).filter(composed ? allowedComposed : allowed).filter(element => element.matches(target.selector)).filter(element => {
                  const candidate = describe(element, composed)
                  return candidate.role === target.role && candidate.name === target.name && candidate.text === target.text && (!target.context || candidate.context === target.context)
                })
              } catch { anchored = [] }
              if (anchored.length === 1) return { state: 'matched', element: anchored[0] }
              if (anchored.length > 1 && !semantic) return { state: 'ambiguous', reason: 'The CSS selector matches more than one element' }
            }
            if (!semantic) return { state: 'unresolved', reason: 'No semantic evidence or unique CSS selector' }
            let candidates = Array.from(elements).filter(composed ? allowedComposed : allowed).filter(element => {
              const candidate = describe(element, composed)
              return candidate.role === target.role && candidate.name === target.name && candidate.text === target.text
            })
            if (candidates.length > 1 && target.context) candidates = candidates.filter(element => describe(element, composed).context === target.context)
            if (candidates.length > 1) return { state: 'ambiguous', reason: 'Element semantics are duplicated' }
            if (!candidates.length) return { state: 'unresolved', reason: 'Element semantics changed or are unavailable' }
            return { state: 'matched', element: candidates[0] }
          }
          throw new Error('Unknown target kind')
        }
        // What a pointer event points at: the nearest annotatable element on its composed path, or
        // why there is none. Icons and other decorative parts give way to the control around them.
        const pick = event => {
          for (const node of event.composedPath()) {
            if (node === document.body || node === document.documentElement || node === document || node === window) break
            if (!(node instanceof Element)) continue
            if (node.matches('iframe,object,embed')) return { element: null, refusal: 'Embedded frames can\u2019t be annotated.' }
            if (node.matches(refusedContent)) return { element: null, refusal: 'Form fields and private content can\u2019t be annotated.' }
            if (!allowedComposed(node)) continue
            // A component that shows nothing script can read (a closed shadow root) gives nothing to anchor to.
            if (node.localName.includes('-') && !node.shadowRoot && !norm(node.getAttribute('aria-label')) && !textComposed(node)) {
              return { element: null, refusal: 'This component\u2019s contents are private and can\u2019t be annotated.' }
            }
            return { element: node, refusal: null }
          }
          return { element: null, refusal: null }
        }
        // The current selection as a target: through the composed tree when the browser can say
        // where a selection inside a shadow root is, else by the document-only rules.
        const currentSelection = () => {
          if (typeof getSelection()?.getComposedRanges === 'function') return composedSelectionTarget()
          const target = selectionTarget()
          return target ? { target, range: getSelection().getRangeAt(0).cloneRange() } : null
        }
        const unionRect = rects => {
          const list = rects.filter(rect => rect.width || rect.height)
          if (!list.length) return new DOMRect(0, 0, 0, 0)
          const left = Math.min(...list.map(rect => rect.left))
          const top = Math.min(...list.map(rect => rect.top))
          return new DOMRect(left, top, Math.max(...list.map(rect => rect.right)) - left, Math.max(...list.map(rect => rect.bottom)) - top)
        }
        const segmentRects = segments => segments.flatMap(range => Array.from(range.getClientRects()))
        const listen = (node, type, handler, options = true) => {
          node.addEventListener(type, handler, options)
          listeners.push(() => node.removeEventListener(type, handler, options))
        }
        const clear = () => {
          listeners.forEach(remove => remove())
          listeners = []
          observer?.disconnect()
          observer = null
          mutations?.disconnect()
          mutations = null
          if (frame) clearTimeout(frame)
          frame = 0
          overlay?.remove()
          overlay = null
          mark = null
        }
        const draw = () => {
          frame = 0
          if (!mark) return
          const match = resolve(mark)
          overlay?.remove()
          overlay = null
          if (match.state !== 'matched' || (!match.range && !match.element && !match.segments?.length)) return
          const rects = match.range ? Array.from(match.range.getClientRects()) : match.segments ? segmentRects(match.segments) : [match.element.getBoundingClientRect()]
          // Clip marks to nested scrollports, not just the top-level viewport, including those inside components.
          const anchor = match.element ?? match.range?.commonAncestorContainer ?? match.segments[0].startContainer
          let ancestor = anchor.nodeType === Node.ELEMENT_NODE ? anchor : composedParent(anchor)
          let clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
          if (match.element) ancestor = composedParent(ancestor)
          for (; ancestor; ancestor = composedParent(ancestor)) {
            const style = getComputedStyle(ancestor)
            const rect = ancestor.getBoundingClientRect()
            if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
              clip.left = Math.max(clip.left, rect.left)
              clip.right = Math.min(clip.right, rect.right)
            }
            if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
              clip.top = Math.max(clip.top, rect.top)
              clip.bottom = Math.min(clip.bottom, rect.bottom)
            }
          }
          overlay = document.createElement('div')
          overlays.add(overlay)
          overlay.setAttribute('data-harness-annotation-overlay', '')
          overlay.setAttribute('aria-hidden', 'true')
          overlay.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;overflow:hidden!important;'
          for (const original of rects) {
            const rect = { left: Math.max(original.left, clip.left), top: Math.max(original.top, clip.top) }
            rect.width = Math.min(original.right, clip.right) - rect.left
            rect.height = Math.min(original.bottom, clip.bottom) - rect.top
            if (rect.width <= 0 || rect.height <= 0) continue
            const box = document.createElement('div')
            box.style.cssText = 'all:initial!important;position:absolute!important;pointer-events:none!important;box-sizing:border-box!important;left:' + rect.left + 'px!important;top:' + rect.top + 'px!important;width:' + rect.width + 'px!important;height:' + rect.height + 'px!important;border:2px solid Highlight!important;background:color-mix(in srgb, Highlight 12%, transparent)!important;'
            overlay.append(box)
          }
          document.documentElement.append(overlay)
        }
        const schedule = () => { if (!frame) frame = setTimeout(draw, 16) }
        const envelope = target => ({ url: location.href, title: bounded(document.title, 200), documentId, target })

        // ---- Inspect mode (PROP-0018): hover outlines a component, a click opens a comment popover.
        // Everything drawn lives in a closed shadow root, so page CSS and scripts cannot reach it;
        // a page can still call this helper, so hosts treat each result as untrusted.
        let inspect = null
        const INSPECT_CSS = ':host{all:initial!important}' +
          '.layer{position:fixed;inset:0;pointer-events:none;z-index:2147483647;font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:light dark}' +
          '.box{position:fixed;box-sizing:border-box;border:2px solid #3b82f6;background:rgba(59,130,246,.12);border-radius:2px;display:none}' +
          '.box.frozen{border-color:#f97316;background:rgba(249,115,22,.12)}' +
          '.chip{position:fixed;display:none;padding:2px 6px;border-radius:4px;background:#1e293b;color:#f8fafc;font-size:11px;white-space:nowrap;max-width:360px;overflow:hidden;text-overflow:ellipsis}' +
          '.chip b{font-weight:600;color:#93c5fd}' +
          '.chip.refused{background:#334155;color:#e2e8f0;font-style:italic}' +
          '.pop{position:fixed;display:none;width:320px;box-sizing:border-box;padding:10px;border-radius:8px;pointer-events:auto;background:Canvas;color:CanvasText;border:1px solid rgba(127,127,127,.35);box-shadow:0 8px 28px rgba(0,0,0,.28)}' +
          '.what{font-size:11px;opacity:.7;margin:0 0 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
          'textarea{all:unset;display:block;box-sizing:border-box;width:100%;min-height:68px;max-height:200px;padding:6px 8px;border-radius:6px;border:1px solid rgba(127,127,127,.45);font:inherit;font-size:13px;white-space:pre-wrap;overflow:auto;background:Field;color:FieldText}' +
          'textarea:focus{outline:2px solid #3b82f6;outline-offset:-1px}' +
          '.row{display:flex;gap:6px;margin-top:8px;justify-content:flex-end;flex-wrap:wrap}' +
          'button{all:unset;cursor:pointer;padding:4px 9px;border-radius:6px;font-size:12px;border:1px solid rgba(127,127,127,.45)}' +
          'button:hover{background:rgba(127,127,127,.15)}button:focus-visible{outline:2px solid #3b82f6}' +
          'button.primary{background:#2563eb;border-color:#2563eb;color:#fff}button.primary:hover{background:#1d4ed8}' +
          'button[disabled]{opacity:.45;cursor:default}' +
          '.hint{margin-top:6px;font-size:10px;opacity:.55;text-align:right}' +
          '.toast{position:fixed;right:16px;bottom:16px;padding:6px 10px;border-radius:6px;background:#1e293b;color:#f8fafc;font-size:12px;display:none}'
        const label = element => {
          const tag = element.tagName.toLowerCase()
          const id = element.id ? '#' + element.id : ''
          const classes = typeof element.className === 'string' ? element.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(name => '.' + name).join('') : ''
          const rect = element.getBoundingClientRect()
          return { tag, rest: (id || classes) + '  ' + Math.round(rect.width) + '×' + Math.round(rect.height) }
        }
        const place = (node, rect, width, height, gap) => {
          let top = rect.bottom + gap
          if (top + height > innerHeight - 4 && rect.top - gap - height >= 4) top = rect.top - gap - height
          top = Math.max(4, Math.min(top, innerHeight - height - 4))
          const left = Math.max(4, Math.min(rect.left, innerWidth - width - 4))
          node.style.top = top + 'px'
          node.style.left = left + 'px'
        }
        const stopInspect = () => {
          if (!inspect) return
          inspect.listeners.forEach(remove => remove())
          inspect.host.remove()
          inspect = null
        }
        const startInspect = captureId => {
          stopInspect()
          const host = document.createElement('div')
          overlays.add(host)
          host.setAttribute('data-harness-annotation-overlay', '')
          host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;'
          const shadow = host.attachShadow({ mode: 'closed' })
          shadow.innerHTML = '<style>' + INSPECT_CSS + '</style><div class="layer"><div class="box"></div><div class="chip"></div>' +
            '<div class="pop" role="dialog" aria-label="Annotate"><p class="what"></p><textarea placeholder="What should change?" aria-label="Comment"></textarea>' +
            '<div class="row"><button data-action="save">Create annotation</button><button data-action="queue">Ask agent to fix</button><button class="primary" data-action="send">Proceed now</button></div>' +
            '<div class="hint">Esc to cancel · ⌘↵ proceed now</div></div><div class="toast" role="status"></div></div>'
          const $ = selector => shadow.querySelector(selector)
          const state = { captureId, host, shadow, listeners: [], hovered: null, refusal: null, pointer: null, frozen: null, frame: 0, results: [], box: $('.box'), chip: $('.chip'), pop: $('.pop'), what: $('.what'), input: $('textarea'), toast: $('.toast'), toastTimer: 0 }
          inspect = state
          const on = (node, type, handler, options = true) => {
            node.addEventListener(type, handler, options)
            state.listeners.push(() => node.removeEventListener(type, handler, options))
          }
          const rectOf = picked => picked.range ? picked.range.getBoundingClientRect() : picked.segments ? unionRect(segmentRects(picked.segments)) : picked.element.getBoundingClientRect()
          // Scrolls inside a component do not reach the window, so listen on each shadow root met.
          const watched = new WeakSet()
          const watch = node => {
            for (const root of rootsOf(node)) {
              if (watched.has(root)) continue
              watched.add(root)
              on(root, 'scroll', () => repaint(), { capture: true, passive: true })
            }
          }
          const paint = () => {
            state.frame = 0
            const current = state.frozen ?? (state.hovered ? { element: state.hovered } : null)
            state.chip.classList.remove('refused')
            if (!current && state.refusal && state.pointer) {
              // Say why nothing is outlined instead of staying silent.
              state.box.style.display = 'none'
              state.chip.textContent = state.refusal
              state.chip.classList.add('refused')
              state.chip.style.display = 'block'
              place(state.chip, { left: state.pointer.x + 12, top: state.pointer.y + 14, bottom: state.pointer.y + 14 }, Math.min(360, state.chip.offsetWidth || 240), 20, 0)
              return
            }
            const detached = current && (current.element ? !current.element.isConnected : current.segments ? !current.segments[0]?.startContainer.isConnected : false)
            if (!current || detached) {
              state.box.style.display = state.chip.style.display = 'none'
              return
            }
            const rect = rectOf(current)
            Object.assign(state.box.style, { display: 'block', left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px' })
            state.box.classList.toggle('frozen', Boolean(state.frozen))
            if (state.frozen) {
              state.chip.style.display = 'none'
              place(state.pop, rect, 320, state.pop.offsetHeight || 170, 8)
            } else {
              const text = label(current.element)
              state.chip.innerHTML = ''
              const tag = document.createElement('b')
              tag.textContent = text.tag
              state.chip.append(tag, document.createTextNode(text.rest))
              state.chip.style.display = 'block'
              place(state.chip, { left: rect.left, top: rect.top - 22, bottom: rect.top - 22 + 0 }, Math.min(360, state.chip.offsetWidth || 120), 20, 0)
              if (rect.top < 26) place(state.chip, { left: rect.left, top: rect.bottom, bottom: rect.bottom }, Math.min(360, state.chip.offsetWidth || 120), 20, 2)
            }
          }
          const repaint = () => { if (!state.frame) state.frame = requestAnimationFrame(paint) }
          const closePopover = () => {
            state.frozen = null
            state.pop.style.display = 'none'
            state.input.value = ''
            repaint()
          }
          const openPopover = picked => {
            state.frozen = picked
            state.refusal = null
            watch(picked.element ?? picked.segments?.[0]?.startContainer ?? picked.range?.startContainer)
            const target = picked.target
            state.what.textContent = target.kind === 'text' ? '“' + bounded(target.exact, 80) + '”' : '<' + target.tag + '> ' + (target.name || target.text || target.selector)
            state.pop.style.display = 'block'
            state.chip.style.display = 'none'
            paint()
            state.input.focus()
            setTimeout(() => { if (state.frozen) state.input.focus() }, 0)
          }
          const submit = action => {
            if (!state.frozen) return
            const body = state.input.value.trim()
            if (!body) { state.input.focus(); return }
            state.results.push({ ...envelope(state.frozen.target), body: cp(body).slice(0, 10000).join(''), action })
            if (state.results.length > 20) state.results.shift()
            getSelection()?.removeAllRanges()
            closePopover()
          }
          // The popover's own events stay inside it: the page sees nothing typed or clicked there.
          for (const type of ['keydown', 'keyup', 'keypress', 'input', 'beforeinput', 'paste', 'copy', 'cut', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'wheel', 'focusin', 'focusout']) {
            on(state.pop, type, event => event.stopPropagation(), false)
          }
          on(state.pop, 'click', event => {
            const button = event.composedPath().find(node => node instanceof HTMLElement && node.dataset?.action)
            if (button) submit(button.dataset.action)
          }, false)
          on(state.input, 'keydown', event => {
            if (event.key === 'Escape') { event.preventDefault(); closePopover() }
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit(event.shiftKey ? 'queue' : 'send') }
          }, false)
          const inPopover = event => event.composedPath().includes(host)
          on(window, 'pointermove', event => {
            if (state.frozen || inPopover(event)) return
            const found = pick(event)
            state.pointer = { x: event.clientX, y: event.clientY }
            if (found.element) watch(found.element)
            if (found.element !== state.hovered || found.refusal !== state.refusal || found.refusal) {
              state.hovered = found.element
              state.refusal = found.refusal
              repaint()
            }
          }, { capture: true, passive: true })
          let down = null
          // The page never sees presses on what is being inspected; the browser may still select text.
          for (const type of ['pointerdown', 'mousedown']) {
            on(window, type, event => {
              if (!event.isTrusted || inPopover(event)) return
              event.stopImmediatePropagation()
              if (event.type === 'pointerdown' && event.button === 0) down = { x: event.clientX, y: event.clientY, element: pick(event).element }
            }, { capture: true, passive: false })
          }
          for (const type of ['pointerup', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'submit']) {
            on(window, type, event => {
              if (inPopover(event)) return
              event.preventDefault()
              event.stopImmediatePropagation()
              if (!event.isTrusted || event.button !== 0 || !down || state.frozen) return
              const start = down
              const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4
              if (event.type === 'pointerup') {
                // A drag selects text; the popover opens on the selection.
                if (!moved) return
                down = null
                let selected = null
                try { selected = currentSelection() } catch { selected = null }
                if (selected) openPopover(selected)
                else if (!getSelection()?.isCollapsed) showToast('This selection can\u2019t be annotated: it is too long or crosses a form field or private content.')
                return
              }
              if (event.type !== 'click' || moved) return
              down = null
              const found = pick(event)
              if (found.refusal) { showToast(found.refusal); return }
              if (!found.element || found.element !== start.element) return
              openPopover({ target: describe(found.element, true), element: found.element })
            }, { capture: true, passive: false })
          }
          on(window, 'keydown', event => {
            if (event.key === 'Escape' && !inPopover(event)) {
              if (state.frozen) closePopover()
              else { state.hovered = null; repaint() }
            }
          }, true)
          on(window, 'scroll', repaint, { capture: true, passive: true })
          on(window, 'resize', repaint)
          document.documentElement.append(host)
          return state
        }
        const showToast = text => {
          if (!inspect) return
          const state = inspect
          state.toast.textContent = bounded(text, 120)
          state.toast.style.display = 'block'
          clearTimeout(state.toastTimer)
          state.toastTimer = setTimeout(() => { state.toast.style.display = 'none' }, 2200)
        }
        return operation => {
          switch (operation.operation) {
            case 'identity': return { url: location.href, title: bounded(document.title, 200), documentId }
            case 'begin': {
              if (!['text', 'element', 'inspect'].includes(operation.kind) || !validString(operation.captureId, 200) || !operation.captureId) throw new Error('Invalid capture request')
              if (operation.kind === 'inspect') {
                // Stays on across in-page navigation, until cancel or a new document.
                clear()
                pending = null
                picked = null
                startInspect(operation.captureId)
                return null
              }
              stopInspect()
              clear()
              picked = null
              pending = { kind: operation.kind, captureId: operation.captureId }
              const captureUrl = location.href
              const expired = setTimeout(() => { clear(); pending = null; picked = null }, 300000)
              const navigation = setInterval(() => {
                if (location.href !== captureUrl) { clear(); pending = null; picked = null }
              }, 250)
              listeners.push(() => clearTimeout(expired), () => clearInterval(navigation))
              listen(window, 'keydown', event => {
                if (event.key === 'Escape') { clear(); pending = null; picked = null }
              })
              if (pending.kind === 'text') {
                listen(document, 'selectionchange', () => {
                  // A selection that grows over something refused must not leave the last acceptable one behind.
                  try { const selected = currentSelection(); picked = selected ? envelope(selected.target) : null } catch { picked = null }
                })
              }
              if (pending.kind === 'element') {
                let chosen = null
                const choose = event => {
                  if (!event.isTrusted || event.button !== 0 || !pending || pending.kind !== 'element') return
                  // Open shadow roots are followed; frames and closed shadow roots never are.
                  const element = pick(event).element
                  if (!element) return
                  event.preventDefault()
                  event.stopImmediatePropagation()
                  if (event.type === 'pointerdown') chosen = element
                  if (event.type === 'click' && chosen === element) {
                    picked = envelope(describe(element, true))
                    // Keep suppression through this click; capture/cancel removes the listeners.
                  }
                }
                for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'auxclick']) listen(window, type, choose, { capture: true, passive: false })
              }
              return null
            }
            case 'capture': {
              if (!pending || operation.captureId !== pending.captureId) return null
              const result = picked ?? (pending.kind === 'text' ? currentSelection()?.target ?? null : null)
              if (!result) return null
              const captured = picked ?? envelope(result)
              clear()
              // The trusted host previews, then rechecks this same snapshot on Save.
              picked = captured
              return captured
            }
            case 'next': {
              // Inspect mode: whether it is still on, and the next comment the person submitted.
              const active = Boolean(inspect && inspect.captureId === operation.captureId)
              return { url: location.href, title: bounded(document.title, 200), documentId, active, result: active ? inspect.results.shift() ?? null : null }
            }
            case 'toast':
              if (!validString(operation.text, 400)) throw new Error('Invalid toast')
              showToast(operation.text)
              return null
            case 'cancel':
              if (inspect && (!operation.captureId || operation.captureId === inspect.captureId)) { stopInspect(); return null }
              if (operation.captureId && operation.captureId !== pending?.captureId) return null
              clear()
              pending = null
              picked = null
              return null
            case 'resolve':
            case 'reveal': {
              const match = resolve(operation.target)
              if (operation.operation === 'reveal') {
                clear()
                pending = null
                picked = null
                if (match.state === 'matched' && operation.target.kind !== 'page') {
                  const start = (match.range ?? match.segments?.[0])?.startContainer
                  const element = match.element ?? start.parentElement ?? start.parentNode.host
                  element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
                  mark = operation.target
                  const roots = rootsOf(element)
                  listen(window, 'scroll', schedule)
                  listen(window, 'resize', schedule)
                  // Scrolls inside a component do not reach the window.
                  for (const root of roots) listen(root, 'scroll', schedule, { capture: true, passive: true })
                  if (window.visualViewport) {
                    listen(window.visualViewport, 'scroll', schedule)
                    listen(window.visualViewport, 'resize', schedule)
                  }
                  if (globalThis.ResizeObserver) {
                    observer = new ResizeObserver(schedule)
                    observer.observe(document.documentElement)
                    observer.observe(element)
                  }
                  draw()
                  mutations = new MutationObserver(records => {
                    if (records.some(record => {
                      if (overlays.has(record.target) || overlays.has(record.target.parentElement)) return false
                      if (record.type !== 'childList') return true
                      return [...record.addedNodes, ...record.removedNodes].some(node => !overlays.has(node))
                    })) schedule()
                  })
                  mutations.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true })
                  for (const root of roots) mutations.observe(root, { subtree: true, childList: true, characterData: true, attributes: true })
                }
              }
              return { state: match.state, ...(match.reason ? { reason: match.reason } : {}) }
            }
            default: throw new Error('Unknown annotation operation')
          }
        }
      })()
    }
    return JSON.stringify({ ok: true, result: globalThis[key](args) })
  } catch (error) {
    return JSON.stringify({ ok: false, error: String(error?.message ?? error) })
  }
})()`

export type PageOperation =
  | { operation: 'identity' }
  | { operation: 'begin'; kind: 'text' | 'element' | 'inspect'; captureId: string }
  | { operation: 'capture'; captureId: string }
  | { operation: 'next'; captureId: string }
  | { operation: 'toast'; text: string }
  | { operation: 'cancel'; captureId?: string }
  | { operation: 'resolve' | 'reveal'; target: unknown }

/** The expression to evaluate in the page for one operation. */
export function pageCall(operation: PageOperation): string {
  return PAGE_SCRIPT.replace('__ARGS__', () => JSON.stringify(operation))
}

/** Reads the helper's reply, throwing its error. */
export function pageReply<T>(reply: unknown): T {
  if (typeof reply !== 'string') throw new Error('The page did not answer.')
  let parsed: { ok?: boolean; result?: T; error?: string }
  try {
    parsed = JSON.parse(reply)
  } catch {
    throw new Error('The page answered with something that is not JSON.')
  }
  if (!parsed.ok) throw new Error(parsed.error || 'The page helper failed.')
  return parsed.result as T
}
