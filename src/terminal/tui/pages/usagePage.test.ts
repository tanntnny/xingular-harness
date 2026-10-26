import type { Theme } from '@earendil-works/pi-coding-agent'
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'

import type { UsageLimitsReport } from '../../../usage/limits/types'
import type { UsageSummary, UsageTotals } from '../../../usage/types'
import { createHarnessTheme } from '../theme'
import { UsagePage } from './usagePage'

const theme = createHarnessTheme({ getColorMode: () => 'truecolor' } as Theme)

const totals: UsageTotals = {
  requests: 12, inputTokens: 1_200_000, cacheReadTokens: 200_000, cacheWriteTokens: 10_000,
  outputTokens: 80_000, reasoningTokens: 5_000, costUsd: 7.8, estimatedCostUsd: 0,
  unpricedRequests: 0, avgTtftMs: 1_800, avgDurationMs: 4_000, cacheHitPercent: 14.2
}
const summary: UsageSummary = {
  scope: 'account', period: '7d', from: '2026-03-04T00:00:00.000Z', to: '2026-03-10T12:00:00.000Z',
  timezoneOffsetMinutes: 0, generatedAt: '2026-03-10T12:00:00.000Z', totals,
  byDay: [
    { day: '2026-03-09', requests: 6, inputTokens: 600_000, cacheReadTokens: 100_000, outputTokens: 40_000, costUsd: 3.9 },
    { day: '2026-03-10', requests: 6, inputTokens: 600_000, cacheReadTokens: 100_000, outputTokens: 40_000, costUsd: 3.9 }
  ],
  byModel: [{ key: 'anthropic/claude-opus-5-5', label: 'anthropic/claude-opus-5-5', detail: null, ...totals }],
  byProvider: [{ key: 'anthropic', label: 'anthropic', detail: null, ...totals }],
  byAccount: [{ key: 'account-a', label: 'Work', detail: null, ...totals }],
  bySession: [{ key: 'session-a', label: 'session-a', detail: null, ...totals }],
  truncated: false, lastIndexedAt: '2026-03-10T12:00:00.000Z'
}
const limits: UsageLimitsReport = {
  generatedAt: '2026-03-10T12:00:00.000Z',
  accounts: [{
    accountId: 'account-a', label: 'Work', plan: 'Subscription: anthropic', health: 'ok',
    providers: [{
      provider: 'anthropic', source: 'headers', reason: null, observedAt: '2026-03-10T11:55:00.000Z',
      limits: [{ id: 'anthropic:window-5h', label: '5-hour window', provider: 'anthropic', kind: 'window', unit: 'percent', usedPercent: 62, resetsAt: '2099-03-10T15:00:00.000Z', status: 'allowed', source: 'headers' }]
    }, {
      provider: 'mistral', source: 'unavailable', reason: 'No documented usage endpoint for this provider.', observedAt: '2026-03-10T11:55:00.000Z', limits: []
    }]
  }]
}

const plain = (lines: string[]): string => lines.map(stripTerminalSequences).join('\n')

function setup() {
  const call = vi.fn(async (method: string) => method === 'terminal.usage.summary' ? structuredClone(summary) : structuredClone(limits))
  const changed = vi.fn()
  const page = new UsagePage({ theme: () => theme, call, changed })
  return { page, call, changed }
}

describe('Usage terminal page', () => {
  it('reads the account analysis and shows totals, models and days', async () => {
    const { page, call } = setup()
    page.activate()
    await vi.waitFor(() => expect(plain(page.render(100, 30))).toContain('anthropic/claude-opus-5-5'))
    expect(call).toHaveBeenCalledWith('terminal.usage.summary', expect.objectContaining({ scope: 'account', period: '7d' }))
    const text = plain(page.render(100, 30))
    expect(page.presentation).toBe('centered')
    expect(text).toContain('1.2M in')
    expect(text).toContain('$7.80')
    expect(text).toContain('Work')
    expect(text).toContain('14.2% cache hits')
    expect(text).not.toContain('BY MODEL')
    expect(text).not.toContain('Ledger updated')
    page.dispose()
  })

  it('changes period and scope from the keyboard', async () => {
    const { page, call } = setup()
    page.activate()
    await vi.waitFor(() => expect(call).toHaveBeenCalled())
    expect(page.handleInput('3')).toBe(true)
    await vi.waitFor(() => expect(call).toHaveBeenLastCalledWith('terminal.usage.summary', expect.objectContaining({ period: '30d' })))
    expect(page.handleInput('a')).toBe(true)
    await vi.waitFor(() => expect(call).toHaveBeenLastCalledWith('terminal.usage.summary', expect.objectContaining({ scope: 'all' })))
    expect(page.handleInput('x')).toBe(false)
    page.dispose()
  })

  it('reads provider limits on the Limits tab and names an unavailable provider', async () => {
    const { page, call } = setup()
    page.selectTab('limits')
    await vi.waitFor(() => expect(plain(page.render(100, 30))).toContain('5-hour window'))
    expect(call).toHaveBeenCalledWith('terminal.usage.limits', { refresh: true })
    const rendered = page.render(100, 30).join('\n')
    const text = plain(page.render(100, 30))
    expect(text).toContain('38% left')
    expect(rendered).toContain(theme.fg('warning', '38% left'))
    expect(text).not.toContain('62% used')
    expect(text).not.toContain('Provider limits')
    expect(text).not.toContain('Bars show quota left')
    expect(text).toContain('resets in')
    expect(text).toContain('\n\n')
    expect(text).toContain('No documented usage endpoint')
    expect(text).toContain('Subscription: anthropic')
    page.handleInput('r')
    await vi.waitFor(() => expect(call).toHaveBeenCalledWith('terminal.usage.limits', { refresh: true }))
    page.dispose()
  })

  it('stays inside the width at a narrow size', async () => {
    const { page } = setup()
    page.activate()
    await vi.waitFor(() => expect(plain(page.render(40, 20))).toContain('anthropic'))
    for (const width of [40, 24]) {
      for (const line of page.render(width, 20)) expect(visibleWidth(line)).toBeLessThanOrEqual(width)
    }
    page.dispose()
  })
})

it('shows quota left for a provider window with no usage, never an empty 0% bar', async () => {
  const empty: UsageLimitsReport = {
    generatedAt: '2026-03-10T12:00:00.000Z',
    accounts: [{
      accountId: 'account-a', label: 'Work', plan: 'ChatGPT plus', health: 'ok',
      providers: [{
        provider: 'openai-codex', source: 'provider', reason: null, observedAt: '2026-03-10T12:00:00.000Z',
        limits: [{ id: 'openai-codex:window-primary', label: '5-hour window', provider: 'openai-codex', kind: 'window', unit: 'percent', usedPercent: 0, resetsAt: '2099-03-10T15:00:00.000Z', status: 'allowed' }]
      }]
    }]
  }
  const page = new UsagePage({
    theme: () => theme,
    call: async (method) => method === 'terminal.usage.summary' ? structuredClone(summary) : structuredClone(empty),
    changed: () => {}
  })
  page.selectTab('limits')
  await vi.waitFor(() => expect(plain(page.render(100, 30))).toContain('5-hour window'))
  const rendered = page.render(100, 30).join('\n')
  const text = plain(page.render(100, 30))
  expect(text).toContain('100% left')
  expect(rendered).toContain(theme.fg('success', '█'.repeat(16)))
  expect(text).not.toContain('0% used')
  expect(text).toContain('7d ·')
  expect(text).not.toContain('Provider limits')
  page.dispose()
})

it('colors a nearly exhausted window red', async () => {
  const nearly: UsageLimitsReport = {
    generatedAt: '2026-03-10T12:00:00.000Z',
    accounts: [{
      accountId: 'account-a', label: 'Work', plan: 'ChatGPT plus', health: 'ok',
      providers: [{
        provider: 'openai-codex', source: 'provider', reason: null, observedAt: '2026-03-10T12:00:00.000Z',
        limits: [{ id: 'openai-codex:window-primary', label: '5-hour window', provider: 'openai-codex', kind: 'window', unit: 'percent', usedPercent: 90, remainingPercent: 10, resetsAt: '2099-03-10T15:00:00.000Z', status: 'allowed' }]
      }]
    }]
  }
  const page = new UsagePage({
    theme: () => theme,
    call: async (method) => method === 'terminal.usage.summary' ? structuredClone(summary) : structuredClone(nearly),
    changed: () => {}
  })
  page.selectTab('limits')
  await vi.waitFor(() => expect(plain(page.render(100, 30))).toContain('10% left'))
  expect(page.render(100, 30).join('\n')).toContain(theme.fg('error', '10% left'))
  page.dispose()
})
