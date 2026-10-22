// The `/accounts` command of a terminal session, without Pi: what it lists, what it offers for
// each account, and the sign-in conversation. It asks through the interface it is given and
// changes accounts only through the session's `accounts.*` calls, so the same flow is tested
// without a terminal. The app's Accounts screen does the same things (see App/src/modes/accounts).
import type { AccountsOverview, AccountView, Limit } from '../accounts/store'
import type { MenuUi } from './pluginMenu'

export interface AccountsUi extends MenuUi {
  input(title: string, placeholder?: string): Promise<string | undefined>
}

/** `accounts.*` over the session socket, with the session's control key. */
export type AccountsCall = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>

/** The account this session is on, from `accounts.session`. */
export interface SessionAccount {
  accountId: string
  label: string
}

/** One entry of `accounts.providers`. */
export interface ProviderOption {
  id: string
  name: string
  oauth: boolean
  oauthLabel: string | null
  apiKey: boolean
}

/** `accounts.loginStatus`. `events` and `prompt` are the harness's own login steps, passed through. */
interface LoginSnapshot {
  loginId: string
  revision: number
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  events: Record<string, unknown>[]
  prompt: Record<string, unknown> | null
  error: string | null
}

/** The same words the app shows for each health state (`App/src/modes/accounts/accountModel.ts`). */
export const HEALTH: Record<string, string> = {
  ok: 'Ready',
  limited: 'Limit reached',
  auth_expired: 'Sign in again',
  signed_out: 'Signed out',
  error: 'Needs attention',
  unknown: 'Not checked'
}

const ADD = 'Add account'
const POOLS = 'Pools'
const CHECK_ALL = 'Check all accounts'
const DONE = 'Done'
const BACK = 'Back'
const USE_HERE = 'Use for this session (restarts it)'
const MAKE_DEFAULT = 'Make default for new sessions'
const RENAME = 'Rename'
const CHECK = 'Check'
const DETAILS = 'Details'
const ACTIVITY = 'Activity'
const SIGN_IN = 'Sign in'
const REMOVE_PROVIDER = 'Remove a provider'
const SIGN_OUT = 'Sign out'
const REMOVE = 'Remove account'
const NEW_POOL = 'New pool'
const EDIT = 'Edit'
const DELETE = 'Delete'
const SAVE_POOL = 'Save pool'
const CANCEL = 'Cancel'
const START_OVER = 'Start over'
const REMOVE_LAST = 'Remove the last one'
const CANCEL_SIGN_IN = 'Cancel sign-in'
const CHECK_STATUS = 'Check status'

const LOGIN_TIMEOUT_MS = 10 * 60_000
const POLL_MS = 1000

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Runs one call, reports a failure through the menu, and says whether it worked. */
async function attempt(ui: MenuUi, action: () => Promise<unknown>): Promise<boolean> {
  try {
    await action()
    return true
  } catch (error) {
    ui.notify(message(error), 'error')
    return false
  }
}

/** A short "in 2h 5m" from an ISO time, or the time itself when it has passed. */
export function resetIn(resetsAt: string, now = Date.now()): string {
  const minutes = Math.round((Date.parse(resetsAt) - now) / 60_000)
  if (Number.isNaN(minutes)) return resetsAt
  if (minutes <= 0) return 'now'
  if (minutes < 60) return `in ${minutes}m`
  if (minutes < 60 * 24) return `in ${Math.floor(minutes / 60)}h ${minutes % 60}m`
  return `in ${Math.floor(minutes / (60 * 24))}d`
}

/** One line per account, numbered so two accounts with the same name stay distinct in the menu. */
export function accountRows(overview: AccountsOverview, session: SessionAccount | null): { label: string; account: AccountView }[] {
  return overview.accounts.map((account, index) => {
    const mark = account.isDefault ? '●' : '○'
    const here = session?.accountId === account.id ? ' · this session' : ''
    return { account, label: `${index + 1}. ${mark} ${account.label} · ${HEALTH[account.state.health] ?? HEALTH.unknown}${here}` }
  })
}

const limitLine = (limit: Limit): string => `${limit.label}: ${limit.usedPercent ?? '?'}% used${limit.resetsAt ? `, resets ${resetIn(limit.resetsAt)}` : ''}`

/** What `Details` shows for one account. */
export function accountDetails(account: AccountView): string {
  const state = account.state
  const lines = [
    account.label,
    `Health: ${HEALTH[state.health] ?? HEALTH.unknown}`,
    `Default for new sessions: ${account.isDefault ? 'yes' : 'no'}`,
    `Signed in: ${state.signedIn === null ? 'not checked' : state.signedIn ? 'yes' : 'no'}`,
    `Providers: ${state.piProviders.length ? state.piProviders.join(', ') : 'none'}`,
    state.plan ? `Plan: ${state.plan}` : null,
    state.identity ? `Identity: ${state.identity}` : null,
    `Last checked: ${state.lastCheckedAt ? new Date(state.lastCheckedAt).toLocaleString() : 'never'}`,
    state.lastError ? `Last error: ${state.lastError.message}${state.lastError.resetsAt ? ` (resets ${resetIn(state.lastError.resetsAt)})` : ''}` : null,
    ...state.limits.map(limitLine),
    state.limits.length ? null : 'Usage limits: Pi providers do not report them.',
    state.capabilities.length ? `Detected: ${state.capabilities.join(', ')}` : null
  ]
  return lines.filter((line): line is string => line !== null).join('\n')
}

/** The text shown while a sign-in waits for the person: a link, or a code to enter. */
function loginStep(step: Record<string, unknown>): string | null {
  if (step.type === 'auth_url' && typeof step.url === 'string') return `Open this link to sign in:\n${step.url}${typeof step.instructions === 'string' ? `\n${step.instructions}` : ''}`
  if (step.type === 'device_code' && typeof step.userCode === 'string') return `Enter the code ${step.userCode} at ${String(step.verificationUri ?? '')}`
  return null
}

/** The whole `/accounts` conversation. Returns `'relaunch'` when the person chose to switch this session's account. */
export async function runAccountsMenu(ui: AccountsUi, call: AccountsCall, session: SessionAccount): Promise<'relaunch' | void> {
  for (;;) {
    const overview = await call<AccountsOverview>('accounts.list')
    const rows = accountRows(overview, session)
    const options = [...rows.map((row) => row.label), ADD, POOLS, CHECK_ALL, DONE]
    const picked = await ui.select('Accounts', options)
    if (!picked || picked === DONE) return
    if (picked === ADD) {
      await addAccount(ui, call)
      continue
    }
    if (picked === POOLS) {
      await poolsMenu(ui, call)
      continue
    }
    if (picked === CHECK_ALL) {
      await attempt(ui, () => call('accounts.refresh'))
      continue
    }
    const row = rows[options.indexOf(picked)]
    if (!row) continue
    if ((await accountMenu(ui, call, session, row.account.id)) === 'relaunch') return 'relaunch'
  }
}

export async function addAccount(ui: AccountsUi, call: AccountsCall): Promise<void> {
  const label = await ui.input('Name for the new account', 'Work, Personal, …')
  if (!label?.trim()) return
  if (await attempt(ui, () => call('accounts.create', { label: label.trim(), authKind: 'subscription' }))) ui.notify('Account added. Sign in to use it.', 'info')
}

/** What can be done with one account; `details` is left out where the screen already shows them. */
export function accountActions(account: AccountView, isSession: boolean, details = true): string[] {
  return [
    ...(isSession ? [] : [USE_HERE]),
    ...(account.isDefault ? [] : [MAKE_DEFAULT]),
    RENAME,
    CHECK,
    ...(details ? [DETAILS] : []),
    ACTIVITY,
    SIGN_IN,
    ...(account.state.piProviders.length ? [REMOVE_PROVIDER] : []),
    SIGN_OUT,
    // The session's own account is in use, so it cannot be removed from inside the session.
    ...(isSession ? [] : [REMOVE])
  ]
}

/**
 * Runs one chosen action. `'relaunch'` means the session is switching to this account; `'gone'` that the
 * account was removed. Anything the person declines or that fails leaves everything as it was.
 */
export async function runAccountAction(ui: AccountsUi, call: AccountsCall, overview: AccountsOverview, account: AccountView, action: string): Promise<'relaunch' | 'gone' | void> {
  const accountId = account.id
  if (action === USE_HERE) {
    if (!(await ui.confirm('Switch this session?', `This ends the terminal's Pi process and resumes the conversation on ${account.label}. Work in progress stops.`))) return
    if (await attempt(ui, () => call('accounts.relaunch', { accountId }))) {
      ui.notify(`Switching to ${account.label}.`, 'info')
      return 'relaunch'
    }
  } else if (action === MAKE_DEFAULT) {
    if (await attempt(ui, () => call('accounts.setDefault', { accountId }))) ui.notify(`${account.label} is the default for new sessions.`, 'info')
  } else if (action === RENAME) {
    const label = await ui.input('New name', account.label)
    if (label?.trim()) await attempt(ui, () => call('accounts.rename', { accountId, label: label.trim() }))
  } else if (action === CHECK) {
    if (await attempt(ui, () => call('accounts.refresh', { accountId }))) ui.notify('Checked.', 'info')
  } else if (action === DETAILS) {
    await ui.select(accountDetails(account), [BACK])
  } else if (action === ACTIVITY) {
    await showActivity(ui, call, accountId, account.label)
  } else if (action === SIGN_IN) {
    await signIn(ui, call, account)
  } else if (action === REMOVE_PROVIDER) {
    const provider = await ui.select('Remove which provider?', [...account.state.piProviders, BACK])
    if (!provider || provider === BACK) return
    if (await ui.confirm(`Remove ${provider}?`, `The stored ${provider} sign-in for ${account.label} is deleted from this device.`)) await attempt(ui, () => call('accounts.removeProvider', { accountId, provider }))
  } else if (action === SIGN_OUT) {
    if (await ui.confirm(`Sign out of ${account.label}?`, 'Stored sign-ins are deleted. The account stays, so you can sign in again.')) await attempt(ui, () => call('accounts.signOut', { accountId }))
  } else if (action === REMOVE) {
    const last = overview.accounts.length === 1
    const consequence = last
      ? 'This is the only account. New sessions will ask you to add one.'
      : account.isDefault
        ? 'New sessions will use another account.'
        : 'Sessions pinned to it will ask for another account next time they start.'
    if (!(await ui.confirm(`Remove ${account.label}?`, `Its stored sign-in and its runtime folder are deleted. ${consequence}`))) return
    if (await attempt(ui, () => call('accounts.remove', { accountId }))) {
      ui.notify(`${account.label} was removed.`, 'info')
      return 'gone'
    }
  }
}

async function accountMenu(ui: AccountsUi, call: AccountsCall, session: SessionAccount, accountId: string): Promise<'relaunch' | void> {
  const isSession = session.accountId === accountId
  for (;;) {
    const overview = await call<AccountsOverview>('accounts.list')
    const account = overview.accounts.find((candidate) => candidate.id === accountId)
    if (!account) return
    const action = await ui.select(`${account.label} · ${HEALTH[account.state.health] ?? HEALTH.unknown}`, [...accountActions(account, isSession), BACK])
    if (!action || action === BACK) return
    const outcome = await runAccountAction(ui, call, overview, account, action)
    if (outcome === 'relaunch') return 'relaunch'
    if (outcome === 'gone') return
  }
}

async function showActivity(ui: AccountsUi, call: AccountsCall, accountId: string, label: string): Promise<void> {
  const entries = await call<{ at: string; action: string; detail: string }[]>('accounts.audit', { accountId, limit: 30 })
  const lines = entries.map((entry) => `${new Date(entry.at).toLocaleString()} · ${entry.action} · ${entry.detail}`)
  await ui.select(`${label}: activity\n${lines.join('\n') || 'Nothing has happened here yet.'}`, [BACK])
}

async function signIn(ui: AccountsUi, call: AccountsCall, account: AccountView): Promise<void> {
  const providers = await call<ProviderOption[]>('accounts.providers')
  if (!providers.length) {
    ui.notify('No provider here can be signed in to.', 'warning')
    return
  }
  const labels = providers.map((provider, index) => `${index + 1}. ${provider.name}${account.state.piProviders.includes(provider.id) ? ' · signed in' : ''}`)
  const pickedLabel = await ui.select(`Sign in ${account.label} to which provider?`, [...labels, BACK])
  const index = labels.indexOf(pickedLabel ?? '')
  const provider = providers[index]
  if (!provider) return
  const methods = [...(provider.oauth ? [provider.oauthLabel ?? 'Sign in with the browser'] : []), ...(provider.apiKey ? ['Enter an API key'] : [])]
  if (!methods.length) {
    ui.notify(`${provider.name} has no sign-in from a terminal.`, 'warning')
    return
  }
  const method = methods.length === 1 ? methods[0] : await ui.select(`${provider.name}: how to sign in`, [...methods, BACK])
  if (!method || method === BACK) return
  if (method === 'Enter an API key') {
    const key = await ui.input(`API key for ${provider.name}`, 'Paste the key')
    if (!key?.trim()) return
    if (await attempt(ui, () => call('accounts.setApiKey', { accountId: account.id, provider: provider.id, key: key.trim() }))) ui.notify(`Key saved for ${provider.name}.`, 'info')
    return
  }
  await runLogin(ui, call, account.id, provider.id)
}

/** Starts a provider sign-in and follows it until it ends: shows the link or code, answers prompts, and stops on a timeout. */
async function runLogin(ui: AccountsUi, call: AccountsCall, accountId: string, provider: string): Promise<void> {
  let loginId: string
  try {
    loginId = (await call<{ loginId: string }>('accounts.loginStart', { accountId, provider })).loginId
  } catch (error) {
    ui.notify(message(error), 'error')
    return
  }
  return followLogin(ui, call, accountId, loginId)
}

async function followLogin(ui: AccountsUi, call: AccountsCall, accountId: string, loginId: string): Promise<void> {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS
  let shownRevision = -1
  for (;;) {
    const snapshot = await call<LoginSnapshot | null>('accounts.loginStatus', { accountId })
    // A newer sign-in on this account replaced ours; there is nothing left to follow.
    if (!snapshot || snapshot.loginId !== loginId) return
    if (snapshot.status !== 'running') return reportLogin(ui, snapshot)
    if (snapshot.prompt) {
      await answerPrompt(ui, call, loginId, snapshot.prompt)
      continue
    }
    const step = [...snapshot.events].reverse().map(loginStep).find((text) => text !== null)
    if (step && snapshot.revision !== shownRevision) {
      shownRevision = snapshot.revision
      const choice = await ui.select(`${step}\n\nFinish in your browser, then choose Check status.`, [CHECK_STATUS, CANCEL_SIGN_IN])
      if (choice === CANCEL_SIGN_IN) {
        await call('accounts.loginCancel', { accountId, loginId })
        ui.notify('Sign-in cancelled.', 'warning')
        return
      }
      continue
    }
    if (Date.now() > deadline) {
      await call('accounts.loginCancel', { accountId, loginId })
      ui.notify('Sign-in timed out and was cancelled.', 'error')
      return
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}

function reportLogin(ui: AccountsUi, snapshot: LoginSnapshot): void {
  if (snapshot.status === 'completed') ui.notify('Signed in.', 'info')
  else if (snapshot.status === 'cancelled') ui.notify('Sign-in was cancelled.', 'warning')
  else ui.notify(snapshot.error ?? 'Sign-in failed.', 'error')
}

async function answerPrompt(ui: AccountsUi, call: AccountsCall, loginId: string, prompt: Record<string, unknown>): Promise<void> {
  const promptId = String(prompt.promptId ?? '')
  const detail = (prompt.prompt ?? {}) as { type?: string; message?: string; placeholder?: string | null; options?: unknown }
  const text = detail.message ?? 'Sign-in needs an answer.'
  // A secret is typed with `input` like any other answer: it is never echoed or logged here.
  let value: string | undefined
  if (detail.type === 'select' && Array.isArray(detail.options)) {
    if (detail.options.every((option) => typeof option === 'string')) {
      value = await ui.select(text, detail.options as string[])
    } else if (detail.options.every((option) => typeof option === 'object' && option !== null && 'id' in option && typeof option.id === 'string' && 'label' in option && typeof option.label === 'string')) {
      const options = detail.options as { id: string; label: string }[]
      const selected = await ui.select(text, options.map((option) => option.label))
      value = options.find((option) => option.label === selected)?.id
    }
  } else {
    value = await ui.input(text, detail.placeholder ?? undefined)
  }
  await call('accounts.loginRespond', { loginId, promptId, value: value ?? null })
}

async function poolsMenu(ui: AccountsUi, call: AccountsCall): Promise<void> {
  for (;;) {
    const overview = await call<AccountsOverview>('accounts.list')
    const names = new Map(overview.accounts.map((account) => [account.id, account.label]))
    const labels = overview.pools.map((pool, index) => `${index + 1}. ${pool.label} · ${pool.accountIds.map((id) => names.get(id) ?? 'removed account').join(' → ')}`)
    const options = [NEW_POOL, ...labels, BACK]
    const picked = await ui.select('Pools: new sessions use the first ready account in a pool, in this order', options)
    if (!picked || picked === BACK) return
    if (picked === NEW_POOL) {
      await editPool(ui, call, overview, null)
      continue
    }
    const pool = overview.pools[options.indexOf(picked) - 1]
    if (!pool) continue
    const action = await ui.select(pool.label, [EDIT, DELETE, BACK])
    if (action === EDIT) await editPool(ui, call, overview, pool)
    else if (action === DELETE && (await ui.confirm(`Delete ${pool.label}?`, 'The accounts stay. Only the pool is removed.'))) await attempt(ui, () => call('accounts.removePool', { poolId: pool.id }))
  }
}

export async function editPool(ui: AccountsUi, call: AccountsCall, overview: AccountsOverview, pool: { id: string; label: string; accountIds: string[] } | null): Promise<void> {
  const label = await ui.input('Pool name', pool?.label)
  if (!label?.trim()) return
  const names = new Map(overview.accounts.map((account) => [account.id, account.label]))
  const order: string[] = [...(pool?.accountIds ?? [])]
  for (;;) {
    const ordered = order.map((id, index) => `${index + 1}. ${names.get(id) ?? 'removed account'}`).join('  ')
    const free = overview.accounts.filter((account) => !order.includes(account.id))
    const addOptions = free.map((account) => `Add ${account.label}`)
    const options = [...addOptions, ...(order.length ? [REMOVE_LAST, START_OVER] : []), SAVE_POOL, CANCEL]
    const picked = await ui.select(`${label.trim()}: ${ordered || 'no accounts yet'}`, options)
    if (!picked || picked === CANCEL) return
    if (picked === SAVE_POOL) {
      if (!order.length) {
        ui.notify('A pool needs at least one account.', 'error')
        continue
      }
      if (await attempt(ui, () => call('accounts.savePool', { pool: { id: pool?.id, label: label.trim(), accountIds: order } }))) ui.notify('Pool saved.', 'info')
      return
    }
    if (picked === START_OVER) order.length = 0
    else if (picked === REMOVE_LAST) order.pop()
    else {
      const account = free[addOptions.indexOf(picked)]
      if (account) order.push(account.id)
    }
  }
}
