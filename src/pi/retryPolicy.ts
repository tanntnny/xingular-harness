// Pi retries a failed model request three times, 2, 4 and 8 seconds apart: about fourteen seconds
// of patience, so a half-minute network drop ended the whole reply. A reply that is working should
// ride out a short outage on its own (the working row shows the countdown), and stop for the person
// only when the outage outlasts several minutes or the error is not one a retry can fix.

/** Eight attempts at 2, 4, 8, 16, 32, 60, 60 and 60 seconds: about four minutes in all. */
export const TRANSIENT_RETRY = { enabled: true, maxRetries: 8, baseDelayMs: 2_000, maxAgentDelayMs: 60_000 } as const

interface RetrySettings {
  getGlobalSettings(): { retry?: Record<string, unknown> }
  getProjectSettings(): { retry?: Record<string, unknown> }
  applyOverrides(overrides: Record<string, unknown>): void
}

/** Raises the retry budget on a settings manager; anything the person set themselves still wins. */
export function withTransientRetry<T extends RetrySettings>(manager: T): T {
  manager.applyOverrides({ retry: { ...TRANSIENT_RETRY, ...manager.getGlobalSettings().retry, ...manager.getProjectSettings().retry } })
  return manager
}
