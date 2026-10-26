// The `usage` family of server methods. They belong to the usage plugin module, so the public
// method table stays one contract assembled by `server/methods.ts` (PROP-0020).
import type { Harness } from '../harness'
import type { Handler } from '../server/rpc'
import type { UsagePeriod, UsageScope } from './types'

const text = (params: Record<string, unknown>, name: string): string | undefined =>
  typeof params[name] === 'string' && params[name] ? params[name] as string : undefined

const scopeOf = (value: unknown): UsageScope | undefined =>
  value === 'session' || value === 'account' || value === 'project' || value === 'all' ? value : undefined

const periodOf = (value: unknown): UsagePeriod | undefined =>
  value === 'today' || value === '7d' || value === '30d' || value === 'all' ? value : undefined

export function usageServerMethods(harness: Harness): Record<string, Handler> {
  return {
    'usage.summary': (params) => harness.usage.summary({
      scope: scopeOf(params.scope),
      sessionId: text(params, 'sessionId'),
      accountId: text(params, 'accountId'),
      projectId: text(params, 'projectId'),
      period: periodOf(params.period),
      ...(typeof params.timezoneOffsetMinutes === 'number' ? { timezoneOffsetMinutes: params.timezoneOffsetMinutes } : {})
    }),
    'usage.limits': async (params) => {
      const accountId = text(params, 'accountId')
      return params.refresh === true
        ? harness.usageLimits.refresh(accountId ?? null, { force: true })
        : harness.usageLimits.read(accountId ?? null)
    },
    'usage.sync': () => harness.usage.sync()
  }
}
