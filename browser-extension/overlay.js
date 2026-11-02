(() => {
  const hostId = '__xingular_agent_browser_badge__'
  let host = document.getElementById(hostId)
  if (host) return

  host = document.createElement('div')
  host.id = hostId
  host.setAttribute('role', 'group')
  host.setAttribute('aria-label', 'Xingular Agent browser controls')
  host.style.cssText = 'all:initial;position:fixed;inset:auto 16px 16px auto;z-index:2147483647;pointer-events:auto;'
  const root = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = `
    :host { all: initial; }
    .badge { display:flex; align-items:center; gap:9px; padding:8px 10px 8px 12px; border:1px solid rgba(255,255,255,.16); border-radius:999px; background:#17201e; color:#f5f4ee; box-shadow:0 8px 24px rgba(0,0,0,.28); font:500 12px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; letter-spacing:0; }
    .dot { width:7px; height:7px; flex:none; border-radius:50%; background:#81d5a8; box-shadow:0 0 0 3px rgba(129,213,168,.15); }
    .badge.paused .dot { background:#e5b960; box-shadow:0 0 0 3px rgba(229,185,96,.15); }
    .label { white-space:nowrap; }
    button { appearance:none; border:0; border-radius:999px; padding:5px 9px; background:#2b3834; color:inherit; font:inherit; cursor:pointer; }
    button:hover { background:#3a4b45; }
    button:focus-visible { outline:2px solid #c5ead7; outline-offset:2px; }
    button.stop { background:#643d3a; }
    button.stop:hover { background:#7a4945; }
    .pulse { position:fixed; width:14px; height:14px; margin:-7px 0 0 -7px; border:2px solid #d8f7e5; border-radius:50%; background:rgba(94,193,139,.22); box-shadow:0 0 0 4px rgba(94,193,139,.2); pointer-events:none; animation:agent-pulse .65s cubic-bezier(.2,.8,.2,1) forwards; }
    @keyframes agent-pulse { from { opacity:.95; transform:scale(.45); } to { opacity:0; transform:scale(2.7); } }
  `
  const badge = document.createElement('div')
  badge.className = 'badge'
  const dot = document.createElement('span')
  dot.className = 'dot'
  const label = document.createElement('span')
  label.className = 'label'
  label.textContent = 'Xingular Agent is on this site'
  const pause = document.createElement('button')
  pause.type = 'button'
  pause.textContent = 'Pause'
  pause.setAttribute('aria-label', 'Pause browser control')
  const stop = document.createElement('button')
  stop.type = 'button'
  stop.className = 'stop'
  stop.textContent = 'Stop'
  stop.setAttribute('aria-label', 'Stop browser control')
  badge.append(dot, label, pause, stop)
  root.append(style, badge)
  document.documentElement.append(host)

  let paused = false
  const refresh = () => {
    badge.classList.toggle('paused', paused)
    label.textContent = paused ? 'Xingular Agent is paused' : 'Xingular Agent is on this site'
    pause.textContent = paused ? 'Resume' : 'Pause'
    pause.setAttribute('aria-label', paused ? 'Resume browser control' : 'Pause browser control')
  }

  const ask = action => chrome.runtime.sendMessage({ type: 'control', action })
  pause.addEventListener('click', async event => {
    event.preventDefault()
    event.stopPropagation()
    const result = await ask(paused ? 'resume' : 'pause').catch(() => null)
    if (result?.ok) {
      paused = !paused
      refresh()
    }
  })
  stop.addEventListener('click', async event => {
    event.preventDefault()
    event.stopPropagation()
    await ask('stop').catch(() => null)
  })

  let mutationTimer = null
  const observer = new MutationObserver(records => {
    if (records.every(record => host.contains(record.target))) return
    if (mutationTimer) clearTimeout(mutationTimer)
    mutationTimer = setTimeout(() => chrome.runtime.sendMessage({ type: 'page-changed' }).catch(() => {}), 250)
  })
  const onMessage = message => {
    if (message?.type === 'badge') {
      paused = message.paused === true
      refresh()
    } else if (message?.type === 'pulse') {
      const pulse = document.createElement('span')
      pulse.className = 'pulse'
      pulse.style.left = `${Number(message.x) || 0}px`
      pulse.style.top = `${Number(message.y) || 0}px`
      root.append(pulse)
      setTimeout(() => pulse.remove(), 750)
    } else if (message?.type === 'clear') {
      observer.disconnect()
      if (mutationTimer) clearTimeout(mutationTimer)
      chrome.runtime.onMessage.removeListener(onMessage)
      host.remove()
    }
  }
  chrome.runtime.onMessage.addListener(onMessage)
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-label', 'aria-expanded', 'disabled', 'href', 'role', 'value'] })
})()
