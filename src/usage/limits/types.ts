// How a provider's limit reading reaches an account: a provider response's headers, or a small
// documented endpoint read with the account's own credential. Nothing here invents a ceiling.
import type { Limit } from '../../accounts/store'

export interface ProviderResponseLike {
  status: number
  headers: Record<string, string>
}

/** The credential Pi resolved for this provider: an API key, request headers, or both. */
export interface LimitAuth {
  apiKey?: string
  headers?: Record<string, string | null>
  baseUrl?: string
}

export interface LimitReadout {
  provider: string
  limits: Limit[]
  source: 'headers' | 'provider' | 'estimate' | 'unavailable'
  reason: string | null
  observedAt: string
  plan?: string | null
}

export type FetchLike = (url: string, init?: {
  headers?: Record<string, string>
  signal?: AbortSignal
  redirect?: 'error' | 'follow' | 'manual'
}) => Promise<{ status: number; text(): Promise<string> }>

export interface AdapterContext {
  provider: string
  credentialType: 'api_key' | 'oauth'
  auth: LimitAuth
  /** The provider's base URL, reflected from a `models.json` override when one exists. */
  baseUrl: string | null
  fetch: FetchLike
  signal: AbortSignal
  now: Date
}

export interface AdapterReading {
  limits: Limit[]
  plan?: string | null
  reason?: string | null
}

export interface ProviderLimitAdapter {
  id: string
  providers: readonly string[]
  /** `documented` reads the provider's own usage API; `experimental` is off until a person allows it. */
  stability: 'documented' | 'experimental'
  read(context: AdapterContext): Promise<AdapterReading>
}

export interface UsageLimitsReport {
  generatedAt: string
  accounts: {
    accountId: string
    label: string
    plan: string | null
    health: string
    providers: {
      provider: string
      source: 'headers' | 'provider' | 'estimate' | 'unavailable'
      reason: string | null
      observedAt: string
      limits: Limit[]
    }[]
  }[]
}
