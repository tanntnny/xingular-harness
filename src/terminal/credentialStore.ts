// The credential store a terminal's Pi uses: the host's account store over the control socket. The
// terminal keeps no `auth.json`, so a refresh token has one copy and one cross-process lock; with a
// second copy, whichever side refreshed second sent a spent token and got `invalid_grant`.
import type { CredentialStore } from '@earendil-works/pi-ai'

import { controlCall } from './control'

type Call = <T>(call: string, params?: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal) => Promise<T>
type Credential = Awaited<ReturnType<CredentialStore['read']>>

/** Long enough to wait for another holder's lease and the lock, as the host bounds both. */
const LEASE_CALL_MS = 60_000

export function terminalCredentialStore(call: Call = controlCall): CredentialStore {
  return {
    async read(providerId, options) {
      const result = await call<{ credential: Credential | null }>('accounts.credentials.read', { provider: providerId }, undefined, options?.signal)
      return result.credential ?? undefined
    },
    async list(options) {
      const result = await call<{ credentials?: Awaited<ReturnType<CredentialStore['list']>> }>('accounts.credentials.list', {}, undefined, options?.signal)
      return result.credentials ?? []
    },
    async modify(providerId, fn, options) {
      // The host holds the provider's lock from the lease until the commit, so this read-modify-write
      // (a refresh or a sign-in) is serialized with every other process on the account.
      const lease = await call<{ leaseId: string; current: Credential | null }>('accounts.credentials.lease', { provider: providerId }, LEASE_CALL_MS, options?.signal)
      let next: Credential
      try {
        next = await fn(lease.current ?? undefined)
      } catch (error) {
        await call('accounts.credentials.commit', { leaseId: lease.leaseId }).catch(() => undefined)
        throw error
      }
      const result = await call<{ credential: Credential | null }>('accounts.credentials.commit', { leaseId: lease.leaseId, ...(next === undefined ? {} : { credential: next }) })
      return result.credential ?? undefined
    },
    async delete(providerId, options) {
      await call('accounts.credentials.delete', { provider: providerId }, undefined, options?.signal)
    }
  }
}
