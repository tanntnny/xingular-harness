// List-price cost of token usage, for when a provider reports tokens but no cost.
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'

/** Dollars per million tokens. */
export interface PriceRates {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** The highest tier whose threshold the request's whole input exceeds replaces the base rates. */
  tiers?: Array<{ input: number; output: number; cacheRead: number; cacheWrite: number; inputTokensAbove: number }>
}

export interface PricedTokens {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** The cost of one request at `rates`. Same arithmetic as Pi's own `calculateCost`. */
export function costAt(rates: PriceRates, usage: PricedTokens): number {
  const input = usage.inputTokens ?? 0
  const cacheRead = usage.cacheReadTokens ?? 0
  const cacheWrite = usage.cacheWriteTokens ?? 0
  const whole = input + cacheRead + cacheWrite
  let applied: Omit<PriceRates, 'tiers'> = rates
  let threshold = -1
  for (const tier of rates.tiers ?? []) {
    if (whole > tier.inputTokensAbove && tier.inputTokensAbove > threshold) {
      applied = tier
      threshold = tier.inputTokensAbove
    }
  }
  return (applied.input * input + applied.output * (usage.outputTokens ?? 0) + applied.cacheRead * cacheRead + applied.cacheWrite * cacheWrite) / 1_000_000
}

type Catalogue = { getModel(provider: string, model: string): { cost?: PriceRates } | undefined }
let catalogue: Promise<Catalogue> | null = null

async function loadCatalogue(): Promise<Catalogue> {
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent')
  const none = { read: async () => undefined, list: async () => [], modify: async () => undefined, delete: async () => undefined }
  return (await ModelRuntime.create({ credentials: none, modelsPath: null, refreshOnCreate: false })) as ModelRuntime as unknown as Catalogue
}

/**
 * The list rates Pi's catalogue has for a model, or null when it has none. A dated model id
 * (`…-20250929`) also matches its undated entry. Rates of zero are "unknown", not "free".
 */
export async function modelRates(provider: string | undefined, model: string | undefined, lookup: Promise<Catalogue> = (catalogue ??= loadCatalogue())): Promise<PriceRates | null> {
  if (!provider || !model) return null
  const models = await lookup.catch(() => null)
  if (!models) return null
  for (const id of new Set([model, model.replace(/-\d{8}$/, '')])) {
    const cost = models.getModel(provider, id)?.cost
    if (cost && (cost.input > 0 || cost.output > 0)) return cost
  }
  return null
}
