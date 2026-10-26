import { expect, test } from 'vitest'

import { CODEX_ADAPTER, DEEPSEEK_ADAPTER, OPENCODE_GO_ADAPTER, OPENROUTER_ADAPTER, adapterFor } from './adapters'
import type { AdapterContext, FetchLike } from './types'

const now = new Date('2026-03-10T12:00:00.000Z')

function context(fetch: FetchLike, overrides: Partial<AdapterContext> = {}): AdapterContext {
  return {
    provider: 'openrouter',
    credentialType: 'api_key',
    auth: { apiKey: 'test-key' },
    baseUrl: null,
    fetch,
    signal: AbortSignal.timeout(1_000),
    now,
    ...overrides
  }
}

const json = (status: number, body: unknown): FetchLike => async () => ({ status, text: async () => JSON.stringify(body) })

test('only providers with a documented adapter have one', () => {
  expect(adapterFor('openrouter')).toBe(OPENROUTER_ADAPTER)
  expect(adapterFor('deepseek')).toBe(DEEPSEEK_ADAPTER)
  expect(adapterFor('groq')).toBeNull()
})

test('OpenRouter key limits become credit and budget readings', async () => {
  const reading = await OPENROUTER_ADAPTER.read(context(json(200, {
    data: {
      limit: 50,
      limit_remaining: 12.5,
      usage: 37.5,
      is_free_tier: false,
      budgets: [{ budget_id: 'b1', limit_usd: 20, spend_usd: 5, remaining_usd: 15, reset_interval: 'weekly', resets_at: '2026-03-16T00:00:00Z' }],
      free_model_daily_requests: { used: 3, limit: 50, remaining: 47 }
    }
  })))
  expect(reading.limits.map((limit) => limit.id)).toEqual([
    'openrouter:key-credits',
    'openrouter:budget-b1',
    'openrouter:free-daily'
  ])
  expect(reading.limits[0]).toMatchObject({ used: 37.5, limit: 50, remaining: 12.5, usedPercent: 75, status: 'allowed' })
  expect(reading.limits[1]!.resetsAt).toBe('2026-03-16T00:00:00.000Z')
  expect(reading.reason).toBeNull()
})

test('DeepSeek balance is a currency reading, never a percentage', async () => {
  const reading = await DEEPSEEK_ADAPTER.read(context(json(200, {
    is_available: true,
    balance_infos: [{ currency: 'USD', total_balance: '12.34', granted_balance: '0.00', topped_up_balance: '12.34' }]
  }), { provider: 'deepseek' }))
  expect(reading.limits).toHaveLength(1)
  expect(reading.limits[0]).toMatchObject({ id: 'deepseek:balance-USD', kind: 'credit', remaining: 12.34, status: 'allowed' })
  expect(reading.limits[0]!.usedPercent).toBeUndefined()
})

test('an endpoint failure becomes a readable reason without the credential', async () => {
  await expect(OPENROUTER_ADAPTER.read(context(json(401, { error: 'nope' })))).rejects.toThrow(/credential cannot read usage limits/)
})

test('a non-JSON endpoint response fails instead of guessing', async () => {
  const text: FetchLike = async () => ({ status: 200, text: async () => '<html>captcha</html>' })
  await expect(OPENROUTER_ADAPTER.read(context(text))).rejects.toThrow(/unreadable response/)
})

test('a redirect is never followed', async () => {
  let redirect: string | undefined
  const fetch: FetchLike = async (_url, init) => {
    redirect = init?.redirect
    return { status: 200, text: async () => '{}' }
  }
  await OPENROUTER_ADAPTER.read(context(fetch))
  expect(redirect).toBe('error')
})

test('Codex plan windows and credits are read from the ChatGPT usage endpoint', async () => {
  const reading = await CODEX_ADAPTER.read(context(json(200, {
    plantype: 'plus',
    ratelimit: {
      primarywindow: { usedpercent: 42, resetat: 1_780_000_000, limitwindowseconds: 18_000 },
      secondarywindow: { usedpercent: 81, resetat: 1_780_500_000, limitwindowseconds: 604_800 }
    },
    credits: { hascredits: true, unlimited: false, balance: '12.5' }
  }), { provider: 'openai-codex', credentialType: 'oauth', baseUrl: 'https://chatgpt.com/backend-api' }))
  expect(reading.plan).toBe('ChatGPT plus')
  expect(reading.limits.map((limit) => limit.id)).toEqual([
    'openai-codex:window-primary',
    'openai-codex:window-secondary',
    'openai-codex:credits'
  ])
  expect(reading.limits[0]).toMatchObject({ label: '5-hour window', usedPercent: 42, remainingPercent: 58, windowMinutes: 300, status: 'allowed' })
  expect(reading.limits[0]!.resetsAt).toBe('2026-05-28T20:26:40.000Z')
  expect(reading.limits[1]).toMatchObject({ label: 'Weekly window', usedPercent: 81, status: 'warning' })
  expect(reading.limits[2]).toMatchObject({ kind: 'credit', remaining: 12.5, status: 'allowed' })
})

test('Codex accepts snake_case response keys', async () => {
  const reading = await CODEX_ADAPTER.read(context(json(200, {
    plan_type: 'pro',
    rate_limit: {
      primary_window: { used_percent: 10, reset_at: 1_780_000_000, limit_window_seconds: 18_000 }
    }
  }), { provider: 'openai-codex', credentialType: 'oauth', baseUrl: 'https://chatgpt.com/backend-api' }))
  expect(reading.limits[0]).toMatchObject({ usedPercent: 10, windowMinutes: 300 })
})

test('the Codex account id travels in the request header, decoded from the access token', async () => {
  const payload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-test' } })).toString('base64url')
  const token = `header.${payload}.signature`
  let headers: Record<string, string> | undefined
  const fetch: FetchLike = async (_url, init) => {
    headers = init?.headers
    return { status: 200, text: async () => JSON.stringify({ ratelimit: { primarywindow: { usedpercent: 1, limitwindowseconds: 18_000 } } }) }
  }
  await CODEX_ADAPTER.read(context(fetch, { provider: 'openai-codex', credentialType: 'oauth', auth: { apiKey: token }, baseUrl: 'https://chatgpt.com/backend-api' }))
  expect(headers?.['chatgpt-account-id']).toBe('acct-test')
})

test('Codex and OpenCode report a sign-in problem distinctly', async () => {
  await expect(CODEX_ADAPTER.read(context(json(401, {}), { provider: 'openai-codex', credentialType: 'oauth' }))).rejects.toThrow(/sign-in cannot read Codex usage/)
  await expect(OPENCODE_GO_ADAPTER.read(context(json(403, {}), { provider: 'opencode-go' }))).rejects.toThrow(/API key cannot read Go usage/)
})

test('OpenCode Go maps rolling, weekly and monthly percentages', async () => {
  const reading = await OPENCODE_GO_ADAPTER.read(context(json(200, {
    usage: {
      rolling: { percent: 12.5, resetInSec: 3_600 },
      weekly: { percent: 40, resetInSec: 86_400 },
      monthly: { percent: 5 }
    },
    renewsAt: '2026-12-01T00:00:00Z'
  }), { provider: 'opencode-go', auth: { apiKey: 'test-key' }, baseUrl: null }))
  expect(reading.limits.map((limit) => limit.label)).toEqual(['5-hour window', 'Weekly window', 'Monthly window'])
  expect(reading.limits[0]).toMatchObject({ usedPercent: 12.5, remainingPercent: 87.5, windowMinutes: 300, status: 'allowed' })
  expect(reading.limits[0]!.resetsAt).toBe('2026-03-10T13:00:00.000Z')
  expect(reading.limits[2]!.resetsAt).toBe('2026-12-01T00:00:00.000Z')
})

test('OpenCode Go accepts reset timestamps when an interval is absent', async () => {
  const reading = await OPENCODE_GO_ADAPTER.read(context(json(200, {
    usage: { rolling: { percent: 3, reset_at: '2026-03-10T14:00:00Z' }, weekly: { percent: 20, resetInSec: 60 } }
  }), { provider: 'opencode-go' }))
  expect(reading.limits[0]!.resetsAt).toBe('2026-03-10T14:00:00.000Z')
  expect(reading.limits[1]!.resetsAt).toBe('2026-03-10T12:01:00.000Z')
})

test('an empty optional Codex credit balance does not mark the plan limited', async () => {
  const reading = await CODEX_ADAPTER.read(context(json(200, {
    ratelimit: { primarywindow: { usedpercent: 0, limitwindowseconds: 18_000 } },
    credits: { hascredits: false, unlimited: false, balance: '0' }
  }), { provider: 'openai-codex', credentialType: 'oauth', baseUrl: 'https://chatgpt.com/backend-api' }))
  expect(reading.limits.map((limit) => limit.id)).toEqual(['openai-codex:window-primary'])
})
