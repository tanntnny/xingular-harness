// What a request's context window was made of: one figure per contributor, in tokens, reconciled to
// the size the provider reported for that request. Nothing here formats text: every surface draws
// these rows its own way.
//
// The split is measured where it can be and estimated where it must be. `context.snapshot` records
// the prompt, the update and every tool schema the run sent; `context.json` records what each
// section contributed; `usage.updated` records the provider's own figure for the request. Rows are
// estimated at four characters per token — the ratio Pi, opencode and DeepSeek Harness all use — so
// the page and the session's own status line cannot disagree by more than rounding.

/** Who owns the text: the released half, the mutably half, the host, or the conversation itself. */
export type ContextGroup = 'foundation' | 'variant' | 'application' | 'conversation' | 'reserved'

/** Where a row's characters came from, when the compiler recorded it. */
export interface ContextRowSource {
  id: string
  kind: string
  revision?: string | null
  chars?: number
}

/** One contributor to the context window. */
export interface ContextRow {
  id: string
  title: string
  group: ContextGroup
  /** Estimated tokens this row occupied in the described request. */
  tokens: number
  /** Characters the estimate came from; null for a remainder or a reservation. */
  chars: number | null
  /** Share of the model's window, 0–100; null when the window is unknown. */
  share: number | null
  /** True when it is part of the stable prefix of every request. */
  always: boolean
  /** False only for a figure the provider reported rather than one this module derived. */
  estimated: boolean
  /** Its character budget, when it has one. */
  budget?: number
  /** The compiler shortened this section to meet its budget. */
  cut?: boolean
  sources?: ContextRowSource[]
  /** For a tool-schema row: the groups it counts, and how many tools each holds. */
  tools?: { group: string; count: number }[]
  /** Why this figure is not exact, when it is not. */
  note?: string
}

/** Context that is not in this request but arrives when it is used. */
export interface ContextOnDemand {
  id: string
  title: string
  /** How many items of this kind the variant offers. */
  items: number
  /** Estimated tokens one item costs when it is loaded; null when it loads in its own context. */
  tokensEach: number | null
  note?: string
}

/** One measured request in the run, as the window filled. */
export interface ContextPoint {
  /** 1-based model request, as `usage.updated` numbers it. */
  request: number
  used: number
  share: number | null
  at: string
}

/** A compaction the run went through, and the window it started and ended with. */
export interface ContextCompaction {
  at: string
  before: number | null
  after: number | null
}

/** One run's attribution: the rows, their totals, and how much of the window they account for. */
export interface ContextAttribution {
  runId: string
  model: string | null
  provider: string | null
  /** The model's context window; null when nothing reported one. */
  window: number | null
  /** The provider-measured size of the latest request, or the estimate when it measured none. */
  used: number
  /** Used as a share of the window, 0–100; null when the window is unknown. */
  share: number | null
  source: 'measured' | 'estimate'
  /** Which request the measured total describes (1-based), when the run reported one. */
  request: number | null
  /** Pi's compaction headroom for this run, when the session exposed it. */
  compaction: { enabled: boolean; reserveTokens: number } | null
  /** The window the request may still grow into, excluding the reserve; null when unknown. */
  free: number | null
  rows: ContextRow[]
  /** The window at each measured request, oldest first: what grew, which one snapshot cannot show. */
  history: ContextPoint[]
  /** Compactions the run went through, oldest first. */
  compactions: ContextCompaction[]
  onDemand: ContextOnDemand[]
  totals: Record<ContextGroup, number>
  /** When the run's pack was compiled. */
  recordedAt: string | null
  /** Why the split is approximate, when it is. */
  note: string | null
}
