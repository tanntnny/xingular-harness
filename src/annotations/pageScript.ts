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
        const name = element => {
          const labelled = norm(element.getAttribute('aria-labelledby')).split(' ').filter(Boolean).map(id => {
            const label = document.getElementById(id)
            return allowed(label) ? text(label) : ''
          }).join(' ')
          return bounded(labelled || element.getAttribute('aria-label') || (element.tagName === 'IMG' ? element.getAttribute('alt') : '') || text(element), 200)
        }
        const describe = element => {
          let selector = element.tagName.toLowerCase()
          if (element.id) selector = '#' + CSS.escape(element.id)
          else if (element.getAttribute('data-testid')) selector = '[data-testid="' + CSS.escape(element.getAttribute('data-testid')) + '"]'
          return {
            kind: 'element', tag: element.tagName.toLowerCase(), role: bounded(role(element), 80),
            name: name(element), text: bounded(text(element), 500),
            context: bounded(allowed(element.parentElement) ? text(element.parentElement) : '', 200),
            selector: cp(selector).length <= 500 ? selector : element.tagName.toLowerCase()
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
          if (target.kind === 'text') {
            if (!validString(target.exact, 4000) || !target.exact || norm(target.exact) !== target.exact ||
                !validString(target.prefix, 128) || !validString(target.suffix, 128) ||
                !Number.isSafeInteger(target.start) || !Number.isSafeInteger(target.end) || target.start < 0 || target.end <= target.start) throw new Error('Invalid text target')
            const data = stream()
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
            return { state: 'matched', range: rangeFor(data, ...matches[0]) }
          }
          if (target.kind === 'element') {
            if (!validString(target.tag, 100) || !/^[a-z][a-z0-9-]*$/.test(target.tag) ||
                !validString(target.role, 200) || !validString(target.name, 200) || !validString(target.text, 500) ||
                !validString(target.context, 200) || !validString(target.selector, 500)) throw new Error('Invalid element target')
            if (!target.name && !target.text) return { state: 'unresolved', reason: 'No semantic evidence' }
            const elements = document.getElementsByTagName(target.tag)
            if (elements.length > 2000) return { state: 'unresolved', reason: 'Too many element candidates to resolve safely' }
            let candidates = Array.from(elements).filter(allowed).filter(element => {
              const candidate = describe(element)
              return candidate.role === target.role && candidate.name === target.name && candidate.text === target.text
            })
            if (candidates.length > 1 && target.context) candidates = candidates.filter(element => describe(element).context === target.context)
            if (candidates.length > 1) return { state: 'ambiguous', reason: 'Element semantics are duplicated' }
            if (!candidates.length) return { state: 'unresolved', reason: 'Element semantics changed or are unavailable' }
            return { state: 'matched', element: candidates[0] }
          }
          throw new Error('Unknown target kind')
        }
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
          if (match.state !== 'matched' || (!match.range && !match.element)) return
          const rects = match.range ? Array.from(match.range.getClientRects()) : [match.element.getBoundingClientRect()]
          // Clip marks to nested scrollports, not just the top-level viewport.
          const anchor = match.element ?? match.range.commonAncestorContainer
          let ancestor = anchor.nodeType === Node.ELEMENT_NODE ? anchor : anchor.parentElement
          let clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
          if (match.element) ancestor = ancestor.parentElement
          for (; ancestor; ancestor = ancestor.parentElement) {
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
          const state = { captureId, host, shadow, listeners: [], hovered: null, frozen: null, frame: 0, results: [], box: $('.box'), chip: $('.chip'), pop: $('.pop'), what: $('.what'), input: $('textarea'), toast: $('.toast'), toastTimer: 0 }
          inspect = state
          const on = (node, type, handler, options = true) => {
            node.addEventListener(type, handler, options)
            state.listeners.push(() => node.removeEventListener(type, handler, options))
          }
          const rectOf = picked => picked.range ? picked.range.getBoundingClientRect() : picked.element.getBoundingClientRect()
          const paint = () => {
            state.frame = 0
            const current = state.frozen ?? (state.hovered ? { element: state.hovered } : null)
            if (!current || (current.element && !current.element.isConnected)) {
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
          const pickable = element => element instanceof Element && allowed(element) && !element.tagName.includes('-')
          on(window, 'pointermove', event => {
            if (state.frozen || inPopover(event)) return
            const element = event.composedPath()[0]
            const next = pickable(element) ? element : null
            if (next !== state.hovered) { state.hovered = next; repaint() }
          }, { capture: true, passive: true })
          let down = null
          // The page never sees presses on what is being inspected; the browser may still select text.
          for (const type of ['pointerdown', 'mousedown']) {
            on(window, type, event => {
              if (!event.isTrusted || inPopover(event)) return
              event.stopImmediatePropagation()
              if (event.type === 'pointerdown' && event.button === 0) down = { x: event.clientX, y: event.clientY, element: event.composedPath()[0] }
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
                let target = null
                try { target = selectionTarget() } catch { target = null }
                if (target) openPopover({ target, range: getSelection().getRangeAt(0).cloneRange() })
                return
              }
              if (event.type !== 'click' || moved) return
              down = null
              const element = event.composedPath()[0]
              if (element !== start.element || !pickable(element)) return
              openPopover({ target: describe(element), element })
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
                  try { const target = selectionTarget(); if (target) picked = envelope(target) } catch { picked = null }
                })
              }
              if (pending.kind === 'element') {
                let chosen = null
                const choose = event => {
                  if (!event.isTrusted || event.button !== 0 || !pending || pending.kind !== 'element') return
                  // Never traverse frames/shadow roots, including retargeted closed shadow events.
                  const element = event.target
                  if (!(element instanceof Element) || !allowed(element) || event.composedPath()[0] !== element) return
                  if (element.tagName.includes('-')) return
                  event.preventDefault()
                  event.stopImmediatePropagation()
                  if (event.type === 'pointerdown') chosen = element
                  if (event.type === 'click' && chosen === element) {
                    picked = envelope(describe(element))
                    // Keep suppression through this click; capture/cancel removes the listeners.
                  }
                }
                for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'auxclick']) listen(window, type, choose, { capture: true, passive: false })
              }
              return null
            }
            case 'capture': {
              if (!pending || operation.captureId !== pending.captureId) return null
              const result = picked ?? (pending.kind === 'text' ? selectionTarget() : null)
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
                  const element = match.element ?? match.range.startContainer.parentElement
                  element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
                  mark = operation.target
                  listen(window, 'scroll', schedule)
                  listen(window, 'resize', schedule)
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
