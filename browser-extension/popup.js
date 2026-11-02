const statusLine = document.getElementById('status')
const pairing = document.getElementById('pairing')
const codeInput = document.getElementById('pairing-code')
const connectButton = document.getElementById('connect')
const siteName = document.getElementById('site-name')
const siteDetail = document.getElementById('site-detail')
const allowButton = document.getElementById('allow')
const removeButton = document.getElementById('remove')
const errorLine = document.getElementById('error')
let currentOrigin = null
let currentPermission = null

function showError(message) {
  errorLine.textContent = message
  errorLine.hidden = !message
}

async function message(value) {
  const response = await chrome.runtime.sendMessage(value)
  if (!response?.ok) throw new Error(response?.error || 'The extension could not complete that action.')
  return response.value
}

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  return tab || null
}

async function update() {
  showError('')
  const state = await message({ type: 'status' }).catch(() => ({ state: 'waiting', connected: false, paired: false }))
  statusLine.textContent = state.connected ? (state.paused ? 'Connected · control paused' : 'Connected to Harness') : state.paired ? 'Paired · waiting for Harness' : 'Not connected to Harness'
  pairing.hidden = state.paired

  const tab = await currentTab()
  currentOrigin = tab && !tab.incognito ? XingularSiteAccess.originOf(tab.url || '') : null
  currentPermission = tab && !tab.incognito ? XingularSiteAccess.permissionFor(tab.url || '') : null
  if (!currentOrigin || !currentPermission) {
    siteName.textContent = 'No ordinary website tab selected'
    siteDetail.textContent = tab?.incognito ? 'Incognito is never available to Xingular Agent.' : 'Open an http or https site in a normal Brave tab.'
    allowButton.disabled = true
    removeButton.hidden = true
    return
  }
  let host = new URL(currentOrigin).host
  try { host = new URL(tab.url).host } catch {}
  siteName.textContent = host
  const allowed = await XingularSiteAccess.allowed(tab.url)
  siteDetail.textContent = allowed ? 'Xingular Agent can access normal tabs on this site.' : 'Allow this exact site before its tabs can be read or controlled.'
  allowButton.hidden = allowed
  allowButton.disabled = !state.connected
  removeButton.hidden = !allowed
}

connectButton.addEventListener('click', async () => {
  showError('')
  const match = /^(\d{1,5}):([0-9a-f]{12})$/i.exec(codeInput.value.trim())
  if (!match) return showError('Enter the port and code shown in Harness Browser settings.')
  connectButton.disabled = true
  try {
    await message({ type: 'pair', port: Number(match[1]), code: match[2] })
    codeInput.value = ''
    await update()
  } catch (error) {
    showError(error.message)
  } finally {
    connectButton.disabled = false
  }
})

allowButton.addEventListener('click', async () => {
  showError('')
  if (!currentOrigin) return
  allowButton.disabled = true
  try {
    const granted = await XingularSiteAccess.grant(currentOrigin)
    if (!granted) throw new Error('Brave did not grant access to this site.')
    await message({ type: 'site-access-changed' })
    await update()
  } catch (error) {
    showError(error.message)
    allowButton.disabled = false
  }
})

removeButton.addEventListener('click', async () => {
  showError('')
  if (!currentOrigin) return
  removeButton.disabled = true
  try {
    await XingularSiteAccess.revoke(currentOrigin)
    await message({ type: 'site-access-changed' })
    await update()
  } catch (error) {
    showError(error.message)
  } finally {
    removeButton.disabled = false
  }
})

void update()
