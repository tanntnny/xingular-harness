// Where remote control may listen: a Tailscale address or a private LAN address, never a public
// one, never every interface (INV-RC-1).
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'

import { HarnessError } from '../core/errors'

export type RemoteAddressKind = 'tailscale' | 'lan'
export type RemoteInterfaceChoice = 'auto' | RemoteAddressKind

export interface RemoteAddress {
  kind: RemoteAddressKind
  address: string
  family: 'IPv4' | 'IPv6'
  interface: string
}

const octets = (address: string): number[] => address.split('.').map(Number)

/** Tailscale hands out 100.64.0.0/10 and fd7a:115c:a1e0::/48. */
export function isTailscale(address: string): boolean {
  if (address.includes(':')) return address.toLowerCase().startsWith('fd7a:115c:a1e0:')
  const [a, b] = octets(address)
  return a === 100 && b >= 64 && b <= 127
}

/** RFC 1918 private IPv4 ranges. */
export function isPrivateLan(address: string): boolean {
  if (address.includes(':')) return false
  const [a, b] = octets(address)
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/** Every address remote control may bind, Tailscale first. */
export function remoteAddresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): RemoteAddress[] {
  const found: RemoteAddress[] = []
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue
      const family = entry.family === 'IPv6' ? 'IPv6' : 'IPv4'
      if (isTailscale(entry.address)) found.push({ kind: 'tailscale', address: entry.address, family, interface: name })
      else if (isPrivateLan(entry.address)) found.push({ kind: 'lan', address: entry.address, family, interface: name })
    }
  }
  // IPv4 first within a kind: it is what a person can type and what every phone resolves.
  const rank = (address: RemoteAddress) => (address.kind === 'tailscale' ? 0 : 2) + (address.family === 'IPv4' ? 0 : 1)
  return found.sort((a, b) => rank(a) - rank(b))
}

/** The one address to listen on for a choice, or a clear error when there is none. */
export function pickRemoteAddress(choice: RemoteInterfaceChoice, candidates: readonly RemoteAddress[]): RemoteAddress {
  const pick = choice === 'auto' ? candidates[0] : candidates.find((candidate) => candidate.kind === choice)
  if (pick) return pick
  if (choice === 'tailscale') throw new HarnessError('remote_unavailable', 'No Tailscale address found. Start Tailscale on this computer, or use the Wi-Fi address instead.')
  if (choice === 'lan') throw new HarnessError('remote_unavailable', 'No private Wi-Fi or LAN address found. Join a network, or use Tailscale instead.')
  throw new HarnessError('remote_unavailable', 'No Tailscale or private network address found. Join a Wi-Fi network or start Tailscale, then try /remote-control again.')
}

/** How a URL names the address. */
export function hostPart(address: RemoteAddress): string {
  return address.family === 'IPv6' ? `[${address.address}]` : address.address
}
