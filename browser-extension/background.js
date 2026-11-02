importScripts('site-access.js')

const DEFAULT_PORT = 38671
const MAX_TEXT = 100_000
const attached = new Set()
const generations = new Map()
const agentCreatedTabs = new Set()
const eventWaiters = new Map()
let pollTask = null
let pollRestartRequested = false
let bridgeOnline = false

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const keyFor = id => String(id)
const send = (tabId, method, params = {}) => chrome.debugger.sendCommand({ tabId }, method, params)

async function saved() {
  return chrome.storage.local.get(['bridgePort', 'bridgeToken', 'paused'])
}

async function siteAllowed(url) {
  return XingularSiteAccess.allowed(url)
}

async function tabAvailable(tab) {
  if (!tab || tab.incognito || !Number.isInteger(tab.id)) return false
  if (tab.url === 'about:blank' && agentCreatedTabs.has(tab.id)) return true
  return siteAllowed(tab.url || '')
}

async function listTabs() {
  const tabs = await chrome.tabs.query({})
  const result = []
  for (const tab of tabs) {
    if (!await tabAvailable(tab)) continue
    result.push({
      tabId: tab.id,
      url: tab.url || 'about:blank',
      title: tab.title || '',
      active: tab.active === true,
      generation: generations.get(keyFor(tab.id)) || 0
    })
  }
  return result
}

async function tellTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message)
  } catch {}
}

async function syncTab(tabId) {
  const config = await saved()
  const tab = await chrome.tabs.get(tabId).catch(() => null)
  if (!bridgeOnline || !config.bridgeToken || !tab || !await tabAvailable(tab)) {
    await tellTab(tabId, { type: 'clear' })
    if (tab && !await tabAvailable(tab)) await detach(tabId)
    return
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['overlay.js'] })
    await tellTab(tabId, { type: 'badge', paused: config.paused === true })
  } catch {}
}

async function syncAllTabs() {
  const tabs = await chrome.tabs.query({})
  for (const tab of tabs) if (Number.isInteger(tab.id)) await syncTab(tab.id)
}

async function clearAllBadges() {
  const tabs = await chrome.tabs.query({})
  for (const tab of tabs) if (Number.isInteger(tab.id)) await tellTab(tab.id, { type: 'clear' })
}

function nextGeneration(tabId) {
  const key = keyFor(tabId)
  const next = (generations.get(key) || 0) + 1
  generations.set(key, next)
  return next
}

async function attach(tabId) {
  const tab = await chrome.tabs.get(tabId)
  if (!await tabAvailable(tab)) throw new Error('This tab is not on a site you allowed in the Brave extension.')
  if (attached.has(tabId)) return
  try {
    await chrome.debugger.attach({ tabId }, '1.3')
    attached.add(tabId)
    generations.set(keyFor(tabId), generations.get(keyFor(tabId)) || 0)
    await send(tabId, 'Page.enable')
    await send(tabId, 'Runtime.enable')
    await send(tabId, 'DOM.enable')
    await send(tabId, 'Accessibility.enable')
  } catch (error) {
    attached.delete(tabId)
    const detail = String(error?.message || error)
    if (/already attached|another debugger/i.test(detail)) throw new Error('Brave could not attach to this tab because another debugger is using it. Close DevTools on the tab and try again.')
    throw new Error(`Brave could not attach to this tab: ${detail}`)
  }
}

async function detach(tabId) {
  if (!attached.has(tabId)) return
  attached.delete(tabId)
  try {
    await chrome.debugger.detach({ tabId })
  } catch {}
  nextGeneration(tabId)
}

function waitForTabComplete(tabId, timeout = 25_000) {
  return new Promise(resolve => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      chrome.tabs.onUpdated.removeListener(onUpdated)
      resolve()
    }
    const onUpdated = (id, info) => { if (id === tabId && info.status === 'complete') finish() }
    const timer = setTimeout(finish, timeout)
    chrome.tabs.onUpdated.addListener(onUpdated)
  })
}

function waitForDebuggerEvent(tabId, method, timeout = 25_000) {
  return new Promise(resolve => {
    const key = `${tabId}:${method}`
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const entries = eventWaiters.get(key) || []
      eventWaiters.set(key, entries.filter(entry => entry !== finish))
      resolve()
    }
    const timer = setTimeout(finish, timeout)
    const entries = eventWaiters.get(key) || []
    entries.push(finish)
    eventWaiters.set(key, entries)
  })
}

function notifyDebuggerEvent(tabId, method) {
  const key = `${tabId}:${method}`
  for (const finish of eventWaiters.get(key) || []) finish()
}

function cdpValue(result) {
  if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'The page operation failed.')
  return result?.result?.value
}

async function resolveNode(tabId, backendDOMNodeId) {
  const resolved = await send(tabId, 'DOM.resolveNode', { backendNodeId: backendDOMNodeId })
  if (!resolved?.object?.objectId) throw new Error('That page element is no longer available. Take a fresh snapshot.')
  return resolved.object.objectId
}

async function callOnNode(tabId, backendDOMNodeId, functionDeclaration, args = []) {
  const objectId = await resolveNode(tabId, backendDOMNodeId)
  try {
    const result = await send(tabId, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration,
      arguments: args,
      returnByValue: true,
      awaitPromise: true
    })
    return cdpValue(result)
  } finally {
    await send(tabId, 'Runtime.releaseObject', { objectId }).catch(() => {})
  }
}

async function boxFor(tabId, backendDOMNodeId) {
  const result = await send(tabId, 'DOM.getBoxModel', { backendNodeId: backendDOMNodeId })
  const quad = result?.model?.content
  if (!Array.isArray(quad) || quad.length < 8) throw new Error('That page element is not visible.')
  const xs = [quad[0], quad[2], quad[4], quad[6]]
  const ys = [quad[1], quad[3], quad[5], quad[7]]
  const x = (Math.min(...xs) + Math.max(...xs)) / 2
  const y = (Math.min(...ys) + Math.max(...ys)) / 2
  const width = Math.max(...xs) - Math.min(...xs)
  const height = Math.max(...ys) - Math.min(...ys)
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) throw new Error('That page element is not visible.')
  return { x, y, width, height }
}

function keyInfo(input) {
  const parts = input.split('+').map(part => part.trim()).filter(Boolean)
  const key = parts.pop() || ''
  const modifiers = new Set(parts.map(part => part.toLowerCase()))
  const modifierBits = (modifiers.has('alt') ? 1 : 0) | (modifiers.has('control') || modifiers.has('ctrl') ? 2 : 0) | (modifiers.has('meta') || modifiers.has('command') || modifiers.has('cmd') ? 4 : 0) | (modifiers.has('shift') ? 8 : 0)
  const named = {
    Enter: ['Enter', 'Enter', 13], Escape: ['Escape', 'Escape', 27], Tab: ['Tab', 'Tab', 9],
    Backspace: ['Backspace', 'Backspace', 8], Delete: ['Delete', 'Delete', 46],
    ArrowDown: ['ArrowDown', 'ArrowDown', 40], ArrowUp: ['ArrowUp', 'ArrowUp', 38],
    ArrowLeft: ['ArrowLeft', 'ArrowLeft', 37], ArrowRight: ['ArrowRight', 'ArrowRight', 39],
    Home: ['Home', 'Home', 36], End: ['End', 'End', 35], PageDown: ['PageDown', 'PageDown', 34],
    PageUp: ['PageUp', 'PageUp', 33], Space: [' ', 'Space', 32]
  }
  if (named[key]) return { key: named[key][0], code: named[key][1], keyCode: named[key][2], modifiers: modifierBits }
  if (/^[a-z]$/i.test(key)) return { key: modifiers.has('shift') ? key.toUpperCase() : key.toLowerCase(), code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0), modifiers: modifierBits }
  if (/^F(?:[1-9]|1[0-2])$/.test(key)) return { key, code: key, keyCode: 111 + Number(key.slice(1)), modifiers: modifierBits }
  throw new Error(`Brave does not recognize the key ${key}.`)
}

async function pressKey(tabId, input) {
  const info = keyInfo(input)
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: info.key, code: info.code, windowsVirtualKeyCode: info.keyCode, nativeVirtualKeyCode: info.keyCode, modifiers: info.modifiers })
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: info.key, code: info.code, windowsVirtualKeyCode: info.keyCode, nativeVirtualKeyCode: info.keyCode, modifiers: info.modifiers })
}

async function currentTab(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null)
  if (!tab || !await tabAvailable(tab)) throw new Error('This Brave tab is no longer available. It may have closed or moved to a site you have not allowed.')
  return tab
}

async function navigate(tabId, url) {
  let target
  try { target = new URL(url) } catch { throw new Error('Give a valid web address.') }
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Brave can only open http and https addresses.')
  if (!await siteAllowed(target.href)) throw new Error(`Site access is not enabled for ${target.origin}. Use the Brave extension popup to allow this site first; nothing was done.`)
  const wait = waitForTabComplete(tabId)
  const result = await send(tabId, 'Page.navigate', { url: target.href })
  if (result?.errorText) throw new Error(`Brave could not open the page: ${result.errorText}`)
  await wait
  return null
}

async function accessibilityTree(tabId, depth) {
  const result = await send(tabId, 'Accessibility.getFullAXTree', { depth: Math.max(1, Math.min(40, Number(depth) || 12)) })
  const raw = Array.isArray(result?.nodes) ? result.nodes : []
  const byId = new Map(raw.map(node => [String(node.nodeId), node]))
  const hiddenIds = new Set()
  const hiddenNames = new Set(['Xingular Agent browser controls', 'Pause browser control', 'Resume browser control', 'Stop browser control'])
  const pending = raw.filter(node => hiddenNames.has(String(node.name?.value || ''))).map(node => String(node.nodeId))
  while (pending.length) {
    const id = pending.pop()
    if (hiddenIds.has(id)) continue
    hiddenIds.add(id)
    const node = byId.get(id)
    for (const childId of node?.childIds || []) pending.push(String(childId))
  }
  const children = new Map()
  for (const node of raw) {
    if (node.parentId) {
      const siblings = children.get(node.parentId) || []
      siblings.push(node.nodeId)
      children.set(node.parentId, siblings)
    }
  }
  return raw.filter(node => !hiddenIds.has(String(node.nodeId))).map(node => {
    const level = node.properties?.find(property => property.name === 'level')?.value?.value
    return {
      nodeId: String(node.nodeId),
      parentId: node.parentId ? String(node.parentId) : undefined,
      childIds: (node.childIds || children.get(node.nodeId) || []).map(String),
      role: String(node.role?.value || 'text'),
      name: String(node.name?.value || ''),
      level: Number.isInteger(level) ? level : undefined,
      backendDOMNodeId: Number.isInteger(node.backendDOMNodeId) ? node.backendDOMNodeId : undefined,
      ignored: node.ignored === true
    }
  })
}

async function executeElement(tabId, operation) {
  if (!Number.isInteger(operation.generation) || operation.generation !== (generations.get(keyFor(tabId)) || 0)) throw new Error(`The page in b${Number(tabId).toString(36)} changed since its snapshot. Take browser_snapshot again.`)
  const backendDOMNodeId = Number(operation.backendDOMNodeId)
  if (!Number.isInteger(backendDOMNodeId)) throw new Error('Take browser_snapshot and choose one of its refs.')
  const method = operation.method
  if (method === 'click') {
    const button = ['right', 'middle'].includes(operation.button) ? operation.button : 'left'
    const { x, y } = await boxFor(tabId, backendDOMNodeId)
    const count = operation.double === true ? 2 : 1
    for (let index = 1; index <= count; index++) {
      await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button })
      await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: index })
      await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: index })
    }
    await tellTab(tabId, { type: 'pulse', x, y })
    return null
  }
  if (method === 'evaluate') {
    const declaration = typeof operation.functionDeclaration === 'string' ? operation.functionDeclaration.slice(0, 4000) : ''
    if (!declaration.startsWith('function(){ return (')) throw new Error('This page check is not supported.')
    return callOnNode(tabId, backendDOMNodeId, declaration)
  }
  if (method === 'fill') {
    const sensitivity = await callOnNode(tabId, backendDOMNodeId, `function(){
      const type=(this.getAttribute('type')||'').toLowerCase();
      const autocomplete=(this.getAttribute('autocomplete')||'').toLowerCase();
      return type==='password' || /cc-|one-time-code|current-password|new-password/.test(autocomplete) || /card number|security code|password|one.?time/i.test((this.getAttribute('aria-label')||'')+' '+(this.getAttribute('name')||'')+' '+(this.getAttribute('placeholder')||''));
    }`)
    if (sensitivity) throw new Error('That field takes a password, a card number or a code. Ask the user to fill it themselves.')
    const accepted = await callOnNode(tabId, backendDOMNodeId, `function(){
      if (!(this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement || this.isContentEditable)) return false;
      this.focus();
      if (typeof this.select === 'function') this.select();
      return true;
    }`)
    if (!accepted) throw new Error('That ref is not a text field.')
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 })
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 })
    await send(tabId, 'Input.insertText', { text: String(operation.text || '') })
    return null
  }
  if (method === 'press') {
    if (Number.isInteger(backendDOMNodeId)) await callOnNode(tabId, backendDOMNodeId, 'function(){ this.focus(); return true; }')
    await pressKey(tabId, String(operation.key || ''))
    return null
  }
  if (method === 'select') {
    const values = Array.isArray(operation.values) ? operation.values.filter(value => typeof value === 'string').slice(0, 100) : []
    const result = await callOnNode(tabId, backendDOMNodeId, `function(values){
      if (!(this instanceof HTMLSelectElement)) return null;
      const wanted=new Set(values);
      for (const option of this.options) option.selected=wanted.has(option.value);
      this.dispatchEvent(new Event('input',{bubbles:true}));
      this.dispatchEvent(new Event('change',{bubbles:true}));
      return Array.from(this.selectedOptions, option=>option.value);
    }`, [{ value: values }])
    if (!Array.isArray(result)) throw new Error('That ref is not a select menu.')
    return result
  }
  if (method === 'scrollIntoView') {
    await callOnNode(tabId, backendDOMNodeId, 'function(){ this.scrollIntoView({block:"center",inline:"center"}); return true; }')
    return null
  }
  throw new Error('Brave does not support that element operation.')
}

async function execute(operation) {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) throw new Error('Invalid browser request.')
  const op = operation.op
  if (op === 'tabs.list') return listTabs()
  if (op === 'tabs.create') {
    const tab = await chrome.tabs.create({ url: 'about:blank', active: true })
    agentCreatedTabs.add(tab.id)
    generations.set(keyFor(tab.id), 0)
    return tab.id
  }
  if (op === 'tabs.activate') {
    const tabId = Number(operation.tabId)
    const tab = await currentTab(tabId)
    await chrome.tabs.update(tab.id, { active: true })
    return true
  }
  if (op === 'tabs.close') {
    const tabId = Number(operation.tabId)
    await currentTab(tabId)
    await chrome.tabs.remove(tabId)
    return true
  }

  const tabId = Number(operation.tabId)
  if (!Number.isInteger(tabId)) throw new Error('The browser request did not name a tab.')
  await currentTab(tabId)
  await attach(tabId)
  if (op === 'page.navigate') return navigate(tabId, String(operation.url || ''))
  if (op === 'page.back' || op === 'page.forward') {
    const history = await send(tabId, 'Page.getNavigationHistory')
    const offset = op === 'page.back' ? -1 : 1
    const entry = history.entries?.[history.currentIndex + offset]
    if (!entry) return null
    const wait = waitForTabComplete(tabId)
    await send(tabId, 'Page.navigateToHistoryEntry', { entryId: entry.id })
    await wait
    return null
  }
  if (op === 'page.reload') {
    const wait = waitForTabComplete(tabId)
    await send(tabId, 'Page.reload', { ignoreCache: false })
    await wait
    return null
  }
  if (op === 'page.snapshot') {
    const nodes = await accessibilityTree(tabId, operation.depth)
    const generation = nextGeneration(tabId)
    return { nodes, generation }
  }
  if (op === 'page.text' || op === 'page.containsText') {
    const result = await send(tabId, 'Runtime.evaluate', {
      expression: 'JSON.stringify({title:document.title||"",text:document.body?.innerText||""})',
      returnByValue: true,
      awaitPromise: true
    })
    let value
    try { value = JSON.parse(String(cdpValue(result) || '{}')) } catch { value = { title: '', text: '' } }
    const pageText = String(value.text || '').slice(0, MAX_TEXT)
    if (op === 'page.containsText') return pageText.includes(String(operation.text || '').slice(0, 1000))
    return { title: String(value.title || '').slice(0, 1000), text: pageText }
  }
  if (op === 'page.evaluate') {
    const expression = typeof operation.expression === 'string' ? operation.expression.slice(0, 4000) : ''
    if (!expression) throw new Error('The page check is empty.')
    const result = await send(tabId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    return cdpValue(result)
  }
  if (op === 'page.screenshot') {
    if (Number.isInteger(operation.backendDOMNodeId) && (!Number.isInteger(operation.generation) || operation.generation !== (generations.get(keyFor(tabId)) || 0))) throw new Error('The page changed since its snapshot. Take browser_snapshot again.')
    const quality = Math.max(10, Math.min(95, Number(operation.quality) || 70))
    const params = { format: 'jpeg', quality, fromSurface: true, captureBeyondViewport: false }
    if (Number.isInteger(operation.backendDOMNodeId)) {
      const box = await boxFor(tabId, Number(operation.backendDOMNodeId))
      params.clip = { x: Math.max(0, box.x - box.width / 2), y: Math.max(0, box.y - box.height / 2), width: box.width, height: box.height, scale: 1 }
    }
    const result = await send(tabId, 'Page.captureScreenshot', params)
    return { data: result.data }
  }
  if (op === 'page.press') {
    await pressKey(tabId, String(operation.key || ''))
    return null
  }
  if (op === 'page.scroll') {
    const x = Number.isFinite(operation.x) ? Number(operation.x) : 0
    const y = Number.isFinite(operation.y) ? Number(operation.y) : 650
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: 640, y: 400, deltaX: x, deltaY: y })
    return null
  }
  if (op === 'page.element') return executeElement(tabId, operation)
  throw new Error('Brave does not support that browser operation.')
}

async function bridgeFetch(path, init = {}) {
  const config = await saved()
  if (!Number.isInteger(config.bridgePort) || typeof config.bridgeToken !== 'string') throw new Error('The extension is not paired with the Harness.')
  const response = await fetch(`http://127.0.0.1:${config.bridgePort}${path}`, {
    ...init,
    cache: 'no-store',
    headers: { ...(init.headers || {}), Authorization: `Bearer ${config.bridgeToken}` }
  })
  return response
}

async function startPoller() {
  if (pollTask) {
    pollRestartRequested = true
    return
  }
  pollTask = (async () => {
    while (true) {
      const config = await saved()
      if (!Number.isInteger(config.bridgePort) || typeof config.bridgeToken !== 'string') {
        bridgeOnline = false
        await clearAllBadges()
        break
      }
      try {
        const response = await bridgeFetch('/poll')
        if (response.status === 410) {
          await chrome.storage.local.remove(['bridgePort', 'bridgeToken', 'paused'])
          bridgeOnline = false
          await clearAllBadges()
          break
        }
        if (response.status === 204) {
          bridgeOnline = true
          await syncAllTabs()
          continue
        }
        if (!response.ok) {
          bridgeOnline = false
          await clearAllBadges()
          await sleep(1200)
          continue
        }
        bridgeOnline = true
        const packet = await response.json()
        let result
        try { result = { ok: true, value: await execute(packet.operation) } }
        catch (error) { result = { ok: false, error: String(error?.message || error).split('\n')[0] } }
        await bridgeFetch('/reply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: packet.id, result }) })
        await syncAllTabs()
      } catch {
        bridgeOnline = false
        await clearAllBadges()
        await sleep(1500)
      }
    }
  })().finally(() => {
    pollTask = null
    if (pollRestartRequested) {
      pollRestartRequested = false
      void startPoller()
    }
  })
}

async function pair(code, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof code !== 'string' || !/^[0-9A-F]{12}$/i.test(code)) throw new Error('Enter the pairing code shown in Harness Browser settings.')
  const response = await fetch(`http://127.0.0.1:${port}/pair`, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code })
  })
  const value = await response.json().catch(() => ({}))
  if (!response.ok || typeof value.token !== 'string') throw new Error(response.status === 403 ? 'That pairing code is wrong or expired. Start a new one in Harness Browser settings.' : 'Could not reach the Harness bridge. Start it in Browser settings and try again.')
  await chrome.storage.local.set({ bridgePort: port, bridgeToken: value.token, paused: false })
  bridgeOnline = false
  void startPoller()
  await clearAllBadges()
  return { paired: true }
}

async function control(action) {
  const response = await bridgeFetch('/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error('The Harness bridge is no longer available.')
  if (action === 'stop') {
    await chrome.storage.local.remove(['bridgePort', 'bridgeToken', 'paused'])
    bridgeOnline = false
    await clearAllBadges()
  } else {
    await chrome.storage.local.set({ paused: action === 'pause' })
    await syncAllTabs()
  }
  return result.status
}

async function status() {
  const config = await saved()
  if (!config.bridgeToken || !Number.isInteger(config.bridgePort)) {
    bridgeOnline = false
    await clearAllBadges()
    return { paired: false, connected: false, paused: false, state: 'disconnected' }
  }
  try {
    const response = await bridgeFetch('/status')
    if (!response.ok) return { paired: true, connected: false, paused: config.paused === true, state: 'waiting' }
    const value = await response.json()
    bridgeOnline = value.connected === true
    if (!bridgeOnline) await clearAllBadges()
    return value
  } catch {
    bridgeOnline = false
    await clearAllBadges()
    return { paired: true, connected: false, paused: config.paused === true, state: 'waiting' }
  }
}

async function onMessage(message, sender) {
  if (message?.type === 'status') return status()
  if (message?.type === 'pair') return pair(message.code, Number(message.port))
  if (message?.type === 'control') {
    const action = message.action
    if (!['pause', 'resume', 'stop'].includes(action)) throw new Error('Unknown control action.')
    if (sender.tab && !await tabAvailable(sender.tab)) throw new Error('This tab is not allowed to control the Brave bridge.')
    return control(action)
  }
  if (message?.type === 'site-access-changed') {
    await syncAllTabs()
    return { ok: true }
  }
  if (message?.type === 'page-changed') {
    const tabId = sender.tab?.id
    if (Number.isInteger(tabId)) nextGeneration(tabId)
    return { ok: true }
  }
  throw new Error('Unknown extension message.')
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  onMessage(message, sender).then(value => sendResponse({ ok: true, value })).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }))
  return true
})

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!Number.isInteger(source.tabId)) return
  const tabId = source.tabId
  notifyDebuggerEvent(tabId, method)
  if (method === 'Page.frameNavigated' && !params?.frame?.parentId) nextGeneration(tabId)
})

chrome.debugger.onDetach.addListener(source => {
  if (!Number.isInteger(source.tabId)) return
  attached.delete(source.tabId)
  nextGeneration(source.tabId)
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && tab.url) {
    if (XingularSiteAccess.originOf(tab.url) && agentCreatedTabs.has(tabId)) agentCreatedTabs.delete(tabId)
    nextGeneration(tabId)
  }
  if (changeInfo.status === 'complete' || changeInfo.url) void syncTab(tabId)
})

chrome.tabs.onRemoved.addListener(tabId => {
  agentCreatedTabs.delete(tabId)
  generations.delete(keyFor(tabId))
  void detach(tabId)
})

chrome.permissions.onRemoved.addListener(permissions => {
  void (async () => {
    await XingularSiteAccess.forgetRemoved(permissions)
    await syncAllTabs()
  })()
})

chrome.runtime.onStartup.addListener(() => { void startPoller() })
chrome.runtime.onInstalled.addListener(() => { void startPoller() })
void startPoller()
