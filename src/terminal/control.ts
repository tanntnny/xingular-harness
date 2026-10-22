import { connectionFromEnv, socketCall, type SocketConnection } from './client'

const claims = new Map<string, Promise<string>>()

/** A process owns the claim across native session replacement; it never enters the environment. */
export function claimTerminalControl(connection: SocketConnection = connectionFromEnv()): Promise<string> {
  const identity = JSON.stringify([connection.socket, connection.token])
  let claim = claims.get(identity)
  if (!claim) {
    claim = socketCall<{ key: string }>(connection, 'control.claim', {}, 15_000).then(({ key }) => {
      if (!key) throw new Error('The terminal controller returned no control key.')
      return key
    }).catch((error: unknown) => {
      // A failed claim is retried by the next call; only a claim that succeeded is kept.
      claims.delete(identity)
      throw error
    })
    claims.set(identity, claim)
  }
  return claim
}

export async function controlCall<T = unknown>(call: string, params: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<T> {
  const connection = connectionFromEnv()
  const control = await claimTerminalControl(connection)
  return socketCall<T>(connection, call, params, timeoutMs, control)
}
