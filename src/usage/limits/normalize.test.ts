import { expect, test } from 'vitest'

import { limitHeaders, normalizeHeaders, toIso, toNumber } from './normalize'

const now = new Date('2026-03-10T12:00:00.000Z')

test('reads a remaining/limit pair as a percentage and reset', () => {
  const { limits } = normalizeHeaders('anthropic', {
    status: 200,
    headers: {
      'anthropic-ratelimit-requests-limit': '1000',
      'anthropic-ratelimit-requests-remaining': '250',
      'anthropic-ratelimit-requests-reset': '2026-03-10T12:01:00Z'
    }
  }, now)
  expect(limits).toHaveLength(1)
  expect(limits[0]).toMatchObject({
    id: 'anthropic:requests',
    provider: 'anthropic',
    used: 750,
    limit: 1000,
    remaining: 250,
    usedPercent: 75,
    remainingPercent: 25,
    status: 'allowed',
    source: 'headers'
  })
  expect(limits[0]!.resetsAt).toBe('2026-03-10T12:01:00.000Z')
})

test('reads Anthropic unified plan windows, as fractions or percentages', () => {
  const { limits } = normalizeHeaders('anthropic', {
    status: 200,
    headers: {
      'anthropic-ratelimit-unified-5h-utilization': '0.42',
      'anthropic-ratelimit-unified-5h-reset': '2026-03-10T15:00:00Z',
      'anthropic-ratelimit-unified-7d-utilization': '88',
      'anthropic-ratelimit-unified-status': 'allowed'
    }
  }, now)
  expect(limits.find((limit) => limit.id === 'anthropic:window-5h')?.usedPercent).toBeCloseTo(42)
  expect(limits.find((limit) => limit.id === 'anthropic:window-7d')?.usedPercent).toBe(88)
  expect(limits.find((limit) => limit.id === 'anthropic:window-7d')?.status).toBe('warning')
})

test('reads Codex plan windows', () => {
  const { limits } = normalizeHeaders('openai-codex', {
    status: 200,
    headers: {
      'x-codex-primary-used-percent': '97',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-at': '2026-03-10T17:00:00Z',
      'x-codex-secondary-used-percent': '12'
    }
  }, now)
  const primary = limits.find((limit) => limit.id === 'openai-codex:codex-primary')
  expect(primary).toMatchObject({ usedPercent: 97, windowMinutes: 300, status: 'warning' })
  expect(primary!.resetsAt).toBe('2026-03-10T17:00:00.000Z')
  expect(limits.find((limit) => limit.id === 'openai-codex:codex-secondary')?.status).toBe('allowed')
})

test('reads the common x-ratelimit headers and duration resets', () => {
  const { limits } = normalizeHeaders('groq', {
    status: 200,
    headers: {
      'x-ratelimit-limit-requests': '30',
      'x-ratelimit-remaining-requests': '29',
      'x-ratelimit-reset-requests': '6m0s',
      'x-ratelimit-limit-tokens': '15000',
      'x-ratelimit-remaining-tokens': '15000'
    }
  }, now)
  const requests = limits.find((limit) => limit.id === 'groq:rate-requests')
  expect(requests).toMatchObject({ limit: 30, remaining: 29, unit: 'requests' })
  expect(requests!.resetsAt).toBe('2026-03-10T12:06:00.000Z')
  expect(limits.find((limit) => limit.id === 'groq:rate-tokens')?.usedPercent).toBe(0)
})

test('a 429 retry hint becomes a rejected reading when nothing else was sent', () => {
  const { limits } = normalizeHeaders('openrouter', { status: 429, headers: { 'retry-after': '30' } }, now)
  expect(limits).toEqual([expect.objectContaining({ id: 'openrouter:retry', status: 'rejected', resetsAt: '2026-03-10T12:00:30.000Z' })])
})

test('unknown headers and missing values produce nothing', () => {
  expect(normalizeHeaders('mistral', { status: 200, headers: { 'content-type': 'application/json' } }, now).limits).toEqual([])
})

test('numbers and reset times are parsed defensively', () => {
  expect(toNumber('1,000')).toBe(1000)
  expect(toNumber('42%')).toBe(42)
  expect(toNumber('n/a')).toBeNull()
  expect(toIso('1h30m', now)).toBe('2026-03-10T13:30:00.000Z')
  expect(toIso('1741608000', now)).toBe('2025-03-10T12:00:00.000Z')
  expect(toIso('2026-03-10T15:00:00Z', now)).toBe('2026-03-10T15:00:00.000Z')
  expect(toIso('later', now)).toBeNull()
})

test('only limit-bearing headers are relayed from a session runtime', () => {
  expect(limitHeaders({
    'anthropic-ratelimit-requests-limit': '10',
    'Retry-After': '30',
    'set-cookie': 'secret',
    'content-type': 'application/json'
  })).toEqual({ 'anthropic-ratelimit-requests-limit': '10', 'retry-after': '30' })
})
