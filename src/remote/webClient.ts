// The phone page remote control serves. Plain HTML, CSS and JavaScript with no build step; the
// script uses tweetnacl (served beside it as /nacl.js) for sealed frames. Every string from the
// session is untrusted model output and is only ever set as text, never parsed as HTML. The product
// name comes from the host (`env.productName`); the harness names no application.

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

export function pageHtml(productName: string): string {
  const name = escapeHtml(productName)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="${name}">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="stylesheet" href="/app.css">
<title>${name}</title>
</head>
<body>
<header class="bar">
  <div class="title"><strong id="title">${name}</strong><span id="device" class="muted"></span></div>
  <span id="status" class="chip">Connecting…</span>
</header>
<main id="log" aria-live="polite"></main>
<section id="todo" hidden></section>
<section id="cards"></section>
<div id="notice" role="status" hidden></div>
<footer class="composer">
  <textarea id="input" rows="1" placeholder="Message the session" autocomplete="off" autocapitalize="sentences" enterkeyhint="send"></textarea>
  <button id="stop" class="secondary" type="button" hidden>Stop</button>
  <button id="send" type="button">Send</button>
</footer>
<div id="cover" hidden><div class="panel"><h1 id="coverTitle"></h1><p id="coverText"></p></div></div>
<script src="/nacl.js"></script>
<script src="/app.js"></script>
</body>
</html>
`
}

export function pageManifest(productName: string): string {
  return JSON.stringify({
    name: productName,
    short_name: productName.split(/\s+/)[0] || productName,
    display: 'standalone',
    start_url: '/',
    background_color: '#111214',
    theme_color: '#111214'
  })
}

export const PAGE_CSS = `
:root {
  --bg: #f6f6f4; --panel: #ffffff; --text: #18181b; --muted: #6b6b73; --line: #e2e2de;
  --accent: #2b59c3; --accent-text: #ffffff; --user: #e8eefb; --danger: #b42318; --ok: #1f7a3f;
  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #111214; --panel: #1b1c1f; --text: #ececee; --muted: #9a9aa3; --line: #2c2d31; --accent: #7aa2ff; --accent-text: #0d0f14; --user: #1f2a44; --danger: #ff7b72; --ok: #5bd08a; }
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  background: var(--bg); color: var(--text);
  font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  display: flex; flex-direction: column; max-width: 860px; margin: 0 auto;
  padding: env(safe-area-inset-top) env(safe-area-inset-right) 0 env(safe-area-inset-left);
}
.bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--line); }
.title { display: flex; flex-direction: column; min-width: 0; }
.title strong { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.muted { color: var(--muted); font-size: 13px; }
.chip { font-size: 13px; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); white-space: nowrap; }
.chip.working { color: var(--accent); border-color: var(--accent); }
.chip.bad { color: var(--danger); border-color: var(--danger); }
#log { flex: 1; overflow-y: auto; padding: 12px 16px; -webkit-overflow-scrolling: touch; }
.msg { margin: 10px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.msg.user { margin-left: 15%; background: var(--user); padding: 8px 12px; border-radius: 14px 14px 4px 14px; }
.msg.assistant { padding: 2px 0; }
.tool { margin: 4px 0; font: 13px/1.4 var(--mono); color: var(--muted); overflow-wrap: anywhere; }
.tool.failed { color: var(--danger); }
#todo { border-top: 1px solid var(--line); padding: 8px 16px; font-size: 14px; max-height: 30vh; overflow-y: auto; }
#todo li { list-style: none; margin: 2px 0; }
#todo ul { margin: 0; padding: 0; }
#cards { padding: 0 16px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 12px; margin: 10px 0; }
.card h2 { font-size: 15px; margin: 0 0 6px; }
.card pre { font: 13px/1.45 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 40vh; overflow-y: auto; background: var(--bg); padding: 8px; border-radius: 8px; margin: 6px 0; }
.card .row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.card label.option { display: flex; gap: 8px; align-items: flex-start; padding: 8px; border: 1px solid var(--line); border-radius: 8px; margin: 6px 0; }
.card label.option small { display: block; color: var(--muted); }
.card input[type=text] { width: 100%; font: inherit; padding: 8px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--text); margin-top: 6px; }
#notice { margin: 0 16px 8px; padding: 8px 12px; border-radius: 8px; background: var(--panel); border: 1px solid var(--line); font-size: 14px; }
#notice.bad { border-color: var(--danger); color: var(--danger); }
.composer { display: flex; gap: 8px; align-items: flex-end; padding: 8px 16px calc(8px + env(safe-area-inset-bottom)); border-top: 1px solid var(--line); background: var(--bg); }
textarea { flex: 1; resize: none; font: inherit; padding: 9px 12px; border-radius: 18px; border: 1px solid var(--line); background: var(--panel); color: var(--text); max-height: 40vh; }
button { font: inherit; font-weight: 600; padding: 9px 16px; border-radius: 18px; border: 1px solid var(--accent); background: var(--accent); color: var(--accent-text); }
button.secondary { background: transparent; color: var(--text); border-color: var(--line); }
button.danger { background: transparent; color: var(--danger); border-color: var(--danger); }
button:disabled { opacity: .5; }
#cover { position: fixed; inset: 0; background: var(--bg); display: flex; align-items: center; justify-content: center; padding: 24px; }
#cover .panel { max-width: 420px; text-align: center; }
#cover h1 { font-size: 20px; }
#cover p { color: var(--muted); }
[hidden] { display: none !important; }
`

export const PAGE_JS = String.raw`
(function () {
  'use strict'
  var nacl = window.nacl
  var enc = new TextEncoder()
  var dec = new TextDecoder()
  var STORE = 'remote-control:' + location.host
  var el = function (id) { return document.getElementById(id) }

  function toB64(bytes) {
    var text = ''
    for (var i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i])
    return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  function fromB64(text) {
    var b = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
    var bytes = new Uint8Array(b.length)
    for (var i = 0; i < b.length; i++) bytes[i] = b.charCodeAt(i)
    return bytes
  }

  // Counters only grow, across reloads too, so the harness can refuse a replayed frame.
  var counter = 0
  function nextN() { counter = Math.max(counter + 1, Date.now()); return counter }
  function seal(key, body) {
    var nonce = nacl.randomBytes(24)
    var box = nacl.secretbox(enc.encode(JSON.stringify({ n: nextN(), body: body })), nonce, key)
    var frame = new Uint8Array(nonce.length + box.length)
    frame.set(nonce); frame.set(box, nonce.length)
    return toB64(frame)
  }
  var seen = {}
  function open(key, frame) {
    var bytes = fromB64(frame)
    var plain = nacl.secretbox.open(bytes.subarray(24), bytes.subarray(0, 24), key)
    if (!plain) return null
    var value = JSON.parse(dec.decode(plain))
    if (typeof value.n !== 'number' || seen[value.n]) return null
    seen[value.n] = true
    return value.body
  }

  function load() { try { var v = JSON.parse(localStorage.getItem(STORE) || 'null'); return v && v.deviceId ? v : null } catch (e) { return null } }
  function save(v) { try { if (v) localStorage.setItem(STORE, JSON.stringify(v)); else localStorage.removeItem(STORE) } catch (e) {} }

  var device = null
  var key = null
  var source = null
  var retry = 0
  var active = false
  var pending = []
  var answered = {}

  function cover(title, text) {
    el('coverTitle').textContent = title
    el('coverText').textContent = text
    el('cover').hidden = !title
  }
  function chip(text, kind) {
    var c = el('status'); c.textContent = text; c.className = 'chip' + (kind ? ' ' + kind : '')
  }
  var noticeTimer = null
  function notice(text, bad) {
    var n = el('notice'); n.textContent = text; n.className = bad ? 'bad' : ''; n.hidden = !text
    clearTimeout(noticeTimer)
    if (text) noticeTimer = setTimeout(function () { n.hidden = true }, 6000)
  }
  function setActive(value) {
    active = value
    el('stop').hidden = !active
    chip(active ? 'Working…' : 'Connected', active ? 'working' : '')
  }

  function post(path, body) {
    return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j } }) })
  }

  function ended(text) {
    if (source) { source.close(); source = null }
    save(null); device = null; key = null
    chip('Ended', 'bad')
    cover('Session not reachable', text || 'Remote control ended. Run /remote-control in the terminal and scan the new QR code.')
  }

  function call(method, params) {
    if (!device) return Promise.reject(new Error('Not paired.'))
    var id = Math.random().toString(36).slice(2)
    return post('/rc/call', { d: device.deviceId, f: seal(key, { id: id, method: method, params: params || {} }) }).then(function (r) {
      if (r.body.error) {
        if (r.status === 401) ended()
        throw new Error(r.body.error.message)
      }
      var reply = open(key, r.body.f)
      if (!reply || reply.id !== id) throw new Error('The reply could not be read.')
      if (reply.error) throw new Error(reply.error.message)
      return reply.result
    })
  }

  // ---- transcript
  var log = el('log')
  var byMessage = {}
  var byTool = {}
  function nearBottom() { return log.scrollHeight - log.scrollTop - log.clientHeight < 120 }
  function add(node) { var stick = nearBottom(); log.appendChild(node); if (stick) log.scrollTop = log.scrollHeight }
  function message(role, id, text, append) {
    var node = id && byMessage[id]
    var stick = nearBottom()
    if (!node) {
      node = document.createElement('div')
      node.className = 'msg ' + role
      if (id) byMessage[id] = node
      log.appendChild(node)
    }
    node.textContent = append ? node.textContent + text : text
    if (stick) log.scrollTop = log.scrollHeight
  }
  function tool(event) {
    var node = byTool[event.id]
    if (!node) {
      node = document.createElement('div'); node.className = 'tool'
      byTool[event.id] = node
      node.textContent = '▸ ' + event.name + (event.summary ? '  ' + event.summary : '')
      add(node)
    }
    if (event.phase === 'end') {
      node.textContent = (event.ok ? '✓ ' : '✗ ') + node.textContent.slice(2)
      if (!event.ok) node.className = 'tool failed'
    }
  }
  function todo(items) {
    var box = el('todo')
    box.textContent = ''
    if (!items.length || items.every(function (i) { return i.status === 'completed' })) { box.hidden = true; return }
    var list = document.createElement('ul')
    items.forEach(function (item) {
      var li = document.createElement('li')
      li.textContent = (item.status === 'completed' ? '☑ ' : item.status === 'in_progress' ? '◐ ' : '☐ ') + item.text
      list.appendChild(li)
    })
    box.appendChild(list); box.hidden = false
  }
  var done = {}
  function apply(event) {
    // A late batch of streamed text never lands after the completed message it belongs to.
    if (event.kind === 'delta') { if (!done[event.messageId]) message('assistant', event.messageId, event.text, true) }
    else if (event.kind === 'message') { done[event.messageId] = true; message(event.role, event.messageId, event.text, false) }
    else if (event.kind === 'tool') tool(event)
    else if (event.kind === 'todo') todo(event.items)
    else if (event.kind === 'run') setActive(event.status === 'running' || event.status.indexOf('waiting') === 0)
  }

  // ---- decisions
  function button(text, kind, onClick) {
    var b = document.createElement('button'); b.type = 'button'; b.textContent = text
    if (kind) b.className = kind
    b.addEventListener('click', function () {
      var row = b.parentNode
      Array.prototype.forEach.call(row.querySelectorAll('button'), function (x) { x.disabled = true })
      Promise.resolve().then(onClick).catch(function (e) {
        Array.prototype.forEach.call(row.querySelectorAll('button'), function (x) { x.disabled = false })
        notice(e.message, true)
      })
    })
    return b
  }
  function heading(text) { var h = document.createElement('h2'); h.textContent = text; return h }
  function approvalCard(request) {
    var card = document.createElement('div'); card.className = 'card'
    card.appendChild(heading('Approve ' + (request.target || 'this action') + '?'))
    // The complete request, never shortened: a person decides on what they can read in full.
    var pre = document.createElement('pre'); pre.textContent = request.action; card.appendChild(pre)
    var row = document.createElement('div'); row.className = 'row'
    var decide = function (decision, always) {
      return function () { answered[request.requestId] = true; return call('approve', { requestId: request.requestId, decision: decision, alwaysAllow: !!always }) }
    }
    row.appendChild(button('Allow once', '', decide('approved')))
    if (request.rememberable) row.appendChild(button('Always allow', 'secondary', decide('approved', true)))
    row.appendChild(button('Deny', 'danger', decide('denied')))
    card.appendChild(row)
    return card
  }
  function questionBlock(request, card) {
    if (request.summary) { var s = document.createElement('p'); s.className = 'muted'; s.textContent = request.summary; card.appendChild(s) }
    card.appendChild(heading(request.question))
    var inputs = []
    request.options.forEach(function (option, index) {
      var label = document.createElement('label'); label.className = 'option'
      var input = document.createElement('input')
      input.type = request.multiSelect ? 'checkbox' : 'radio'
      input.name = 'q-' + request.requestId
      input.value = option.label
      if (!request.multiSelect && option.recommended && !inputs.some(function (i) { return i.checked })) input.checked = true
      var text = document.createElement('span'); text.textContent = option.label + (option.recommended ? ' (recommended)' : '')
      if (option.description) { var small = document.createElement('small'); small.textContent = option.description; text.appendChild(small) }
      label.appendChild(input); label.appendChild(text); card.appendChild(label)
      inputs.push(input)
      void index
    })
    var allowsText = request.allowText !== false
    var other = null
    if (allowsText) {
      other = document.createElement('input'); other.type = 'text'; other.placeholder = 'Or type an answer'
      card.appendChild(other)
    }
    return function () {
      var selected = inputs.filter(function (i) { return i.checked }).map(function (i) { return i.value })
      var typed = allowsText && other ? other.value.trim() : ''
      if (!selected.length && !typed) throw new Error('Choose an answer first.')
      return typed ? { selected: selected, text: typed } : { selected: selected }
    }
  }
  function questionCard(group) {
    var card = document.createElement('div'); card.className = 'card'
    var readers = group.map(function (request) { return { request: request, read: questionBlock(request, card) } })
    var row = document.createElement('div'); row.className = 'row'
    row.appendChild(button('Submit', '', function () {
      var answers = readers.map(function (r) { return { questionId: r.request.requestId, answer: r.read() } })
      group.forEach(function (r) { answered[r.requestId] = true })
      if (group[0].batchId) return call('answers', { batchId: group[0].batchId, answers: answers })
      return call('answer', { requestId: group[0].requestId, answer: answers[0].answer })
    }))
    row.appendChild(button('Stop the reply', 'secondary', function () { return call('interrupt') }))
    card.appendChild(row)
    return card
  }
  function renderCards() {
    var cards = el('cards')
    var focused = document.activeElement && cards.contains(document.activeElement)
    if (focused) return
    cards.textContent = ''
    var groups = {}
    pending.forEach(function (request) {
      if (answered[request.requestId]) return
      if (request.type === 'approval') { cards.appendChild(approvalCard(request)); return }
      var id = request.batchId || request.requestId
      if (!groups[id]) { groups[id] = []; cards.appendChild(document.createComment(id)) }
      groups[id].push(request)
    })
    Object.keys(groups).forEach(function (id) {
      var group = groups[id].sort(function (a, b) { return a.batchIndex - b.batchIndex })
      cards.appendChild(questionCard(group))
    })
    if (pending.length) log.scrollTop = log.scrollHeight
  }

  // ---- connection
  function snapshot() {
    return call('snapshot').then(function (s) {
      el('title').textContent = s.title || document.title
      el('device').textContent = s.device ? 'Remote control · ' + s.device : 'Remote control'
      log.textContent = ''; byMessage = {}; byTool = {}; done = {}
      s.events.forEach(apply)
      log.scrollTop = log.scrollHeight
      pending = s.pending; renderCards()
      setActive(!!(s.state && s.state.active))
    })
  }
  function stream() {
    if (source) source.close()
    source = new EventSource('/rc/events?d=' + encodeURIComponent(device.deviceId) + '&f=' + seal(key, { open: true }))
    source.onopen = function () { retry = 0 }
    source.onmessage = function (m) {
      var body = open(key, m.data)
      if (!body) return
      if (body.type === 'event') apply(body.event)
      else if (body.type === 'pending') { pending = body.requests; renderCards() }
      else if (body.type === 'ended') ended()
      else if (body.type === 'unpaired') ended('This device was unpaired. Scan the QR code in the terminal to pair again.')
    }
    source.onerror = function () {
      if (!source) return
      source.close(); source = null
      chip('Reconnecting…', 'bad')
      retry = Math.min(retry + 1, 6)
      setTimeout(connect, 500 * Math.pow(2, retry - 1))
    }
  }
  function connect() {
    if (!device) return
    snapshot().then(stream, function (e) {
      if (!device) return
      chip('Reconnecting…', 'bad')
      notice(e.message, true)
      retry = Math.min(retry + 1, 6)
      setTimeout(connect, 500 * Math.pow(2, retry - 1))
    })
  }

  function pair(fragment) {
    var dot = fragment.indexOf('.')
    var pairingId = fragment.slice(0, dot)
    var linkKey = fromB64(fragment.slice(dot + 1))
    cover('Waiting for approval', 'Allow this device in the terminal to continue.')
    chip('Pairing…')
    return post('/rc/hello', { p: pairingId, f: seal(linkKey, { userAgent: navigator.userAgent }) }).then(function (r) {
      if (r.body.error) throw new Error(r.body.error.message)
      var reply = open(linkKey, r.body.f)
      if (!reply) throw new Error('The pairing reply could not be read.')
      device = { deviceId: reply.deviceId, deviceKey: reply.deviceKey, label: reply.label }
      key = fromB64(reply.deviceKey)
      save(device)
      history.replaceState(null, '', location.pathname)
      cover('')
      connect()
    })
  }

  // ---- composer
  var input = el('input')
  function grow() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.4) + 'px' }
  input.addEventListener('input', grow)
  function send() {
    var text = input.value
    if (!text.trim()) return
    el('send').disabled = true
    call('send', { text: text }).then(function () {
      input.value = ''; grow(); setActive(true)
    }, function (e) { notice(e.message, true) }).then(function () { el('send').disabled = false })
  }
  el('cards').addEventListener('focusout', function () { setTimeout(renderCards, 0) })
  el('send').addEventListener('click', send)
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send() } })
  el('stop').addEventListener('click', function () { call('interrupt').catch(function (e) { notice(e.message, true) }) })
  document.addEventListener('visibilitychange', function () { if (!document.hidden && device && !source) connect() })

  // ---- start
  // The link stays in the address bar until pairing succeeds, so a reload can try again.
  var fragment = location.hash.slice(1)
  if (fragment && fragment.indexOf('.') > 0) {
    pair(fragment).catch(function (e) { chip('Not paired', 'bad'); cover('Could not pair', e.message + ' Reload to try again.') })
  } else {
    device = load()
    if (device) { key = fromB64(device.deviceKey); connect() }
    else { chip('Not paired', 'bad'); cover('Scan to connect', 'Run /remote-control in the terminal, then scan its QR code with this device.') }
  }
})()
`
