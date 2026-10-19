// Budget accounting: R = 4k rollouts and P = 3k improvement stages per mode. Base executions
// count toward each mode; retries are separate attempt counts; selection and reflection are
// recorded outside this ledger.
//
// Ported from Harness² (Apache-2.0, Google LLC; `harness2/core/ledger.py`).

/** R = 4k: k shared base + 2k candidates + k finals. */
export const expectedRollouts = (k: number): number => 4 * k
/** P = 3k: k INV + k DOM + k compositions. */
export const expectedSessions = (k: number): number => 3 * k

export class BudgetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BudgetError'
  }
}

export interface LedgerEntry {
  kind: 'rollout' | 'session'
  label: string
  usd: number
  cached: boolean
  attempts: number
}

export interface LedgerRecord {
  mode: string
  taskId: string
  k: number
  R: number
  expectedR: number
  P: number
  expectedP: number
  sessionAttempts: number
  usd: number
  rolloutUsd: number
  sessionUsd: number
  rollouts: string[]
  sessions: string[]
}

const round = (value: number): number => Math.round(value * 1e6) / 1e6

export class Ledger {
  readonly entries: LedgerEntry[] = []

  constructor(readonly mode: string, readonly taskId: string, readonly k: number) {}

  rollout(label: string, usd = 0, cached = false): void {
    this.entries.push({ kind: 'rollout', label, usd, cached, attempts: 1 })
  }

  session(label: string, usd = 0, options: { cached?: boolean; attempts?: number } = {}): void {
    this.entries.push({ kind: 'session', label, usd, cached: options.cached ?? false, attempts: options.attempts ?? 1 })
  }

  labels(kind: LedgerEntry['kind']): string[] {
    return this.entries.filter((entry) => entry.kind === kind).map((entry) => entry.label)
  }

  get R(): number {
    return this.labels('rollout').length
  }

  get P(): number {
    return this.labels('session').length
  }

  usd(kind?: LedgerEntry['kind']): number {
    return round(this.entries.filter((entry) => !kind || entry.kind === kind).reduce((sum, entry) => sum + entry.usd, 0))
  }

  /** Throws unless the entries show exactly R=4k and P=3k with no repeated label. */
  assertIdentity(): void {
    const wantR = expectedRollouts(this.k)
    const wantP = expectedSessions(this.k)
    const rl = this.labels('rollout')
    const sl = this.labels('session')
    const dupes = [...new Set([...rl.filter((label, i) => rl.indexOf(label) !== i), ...sl.filter((label, i) => sl.indexOf(label) !== i)])].sort()
    if (!dupes.length && this.R === wantR && this.P === wantP) return
    const detail = [`${this.mode}-${this.k} ${this.taskId}: R=${this.R} (want ${wantR}), P=${this.P} (want ${wantP})`, `  rollouts: ${rl.join(', ') || '(none)'}`, `  sessions: ${sl.join(', ') || '(none)'}`]
    if (dupes.length) detail.push(`  DUPLICATE labels: ${dupes.join(', ')} -- two stages wrote the same run id and one overwrote the other`)
    throw new BudgetError(detail.join('\n'))
  }

  toRecord(): LedgerRecord {
    return {
      mode: this.mode,
      taskId: this.taskId,
      k: this.k,
      R: this.R,
      expectedR: expectedRollouts(this.k),
      P: this.P,
      expectedP: expectedSessions(this.k),
      sessionAttempts: this.entries.filter((entry) => entry.kind === 'session').reduce((sum, entry) => sum + entry.attempts, 0),
      usd: this.usd(),
      rolloutUsd: this.usd('rollout'),
      sessionUsd: this.usd('session'),
      rollouts: this.labels('rollout'),
      sessions: this.labels('session')
    }
  }
}
