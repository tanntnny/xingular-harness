// Provider responses carry the only free, always-fresh limit signal there is. This wraps each
// provider of an account's model runtime so that `onResponse` sees the headers, without changing
// the request, the stream, or any other provider behaviour.
import type { ProviderResponseLike } from './types'

interface ProviderLike {
  id: string
  stream?: (...args: never[]) => unknown
  streamSimple?: (...args: never[]) => unknown
}

interface MutableModelsLike {
  getProviders(): readonly ProviderLike[]
  setProvider(provider: ProviderLike): void
}

const WRAPPED = Symbol('xingular-usage-observed')

type Observe = (provider: string, response: ProviderResponseLike) => void

function wrap(provider: ProviderLike, method: unknown, observe: Observe): unknown {
  if (typeof method !== 'function') return method
  return function observed(this: unknown, model: { provider?: string }, context: unknown, options?: Record<string, unknown>): unknown {
    const previous = options?.onResponse
    const next = {
      ...(options ?? {}),
      onResponse: async (response: ProviderResponseLike) => {
        try {
          if (typeof previous === 'function') await (previous as (value: unknown, model: unknown) => unknown)(response, model)
        } finally {
          try { observe(String(model?.provider ?? provider.id), response) } catch { /* observation is best effort */ }
        }
      }
    }
    return (method as (...args: unknown[]) => unknown).call(this, model, context, next)
  }
}

/**
 * Wraps every provider once so responses reach `observe`. Repeated calls do nothing, and a runtime
 * that cannot be wrapped is used unchanged.
 */
export function observeProviderResponses(models: unknown, observe: Observe): void {
  const target = models as MutableModelsLike | null
  if (!target || typeof target.getProviders !== 'function' || typeof target.setProvider !== 'function') return
  for (const provider of target.getProviders()) {
    if ((provider as unknown as Record<symbol, unknown>)[WRAPPED]) continue
    try {
      const clone = Object.create(Object.getPrototypeOf(provider), Object.getOwnPropertyDescriptors(provider)) as ProviderLike
      clone.stream = wrap(provider, provider.stream, observe) as ProviderLike['stream']
      clone.streamSimple = wrap(provider, provider.streamSimple, observe) as ProviderLike['streamSimple']
      ;(clone as unknown as Record<symbol, unknown>)[WRAPPED] = true
      target.setProvider(clone)
    } catch {
      // An unusual provider is left as it is; limits simply stay unavailable for it.
    }
  }
}
