import type { NetworkInterfaceInfo } from 'node:os'
import { describe, expect, it } from 'vitest'

import { hostPart, isPrivateLan, isTailscale, pickRemoteAddress, remoteAddresses } from './addresses'

const entry = (address: string, family: 'IPv4' | 'IPv6' = 'IPv4', internal = false): NetworkInterfaceInfo => ({
  address, family, internal, netmask: '', mac: '00:00:00:00:00:00', cidr: null, ...(family === 'IPv6' ? { scopeid: 0 } : {})
} as NetworkInterfaceInfo)

describe('remote-control addresses', () => {
  it('recognizes Tailscale and private ranges and nothing else', () => {
    expect(isTailscale('100.64.0.1')).toBe(true)
    expect(isTailscale('100.127.255.254')).toBe(true)
    expect(isTailscale('100.128.0.1')).toBe(false)
    expect(isTailscale('fd7a:115c:a1e0::1')).toBe(true)
    expect(isPrivateLan('192.168.1.20')).toBe(true)
    expect(isPrivateLan('172.16.0.1')).toBe(true)
    expect(isPrivateLan('172.32.0.1')).toBe(false)
    expect(isPrivateLan('10.0.0.5')).toBe(true)
    expect(isPrivateLan('8.8.8.8')).toBe(false)
  })

  it('prefers Tailscale, then IPv4, and skips loopback and public addresses', () => {
    const found = remoteAddresses({
      lo0: [entry('127.0.0.1', 'IPv4', true)],
      en0: [entry('192.168.1.20'), entry('fe80::1', 'IPv6'), entry('203.0.113.9')],
      utun4: [entry('fd7a:115c:a1e0::5', 'IPv6'), entry('100.101.102.103')]
    })
    expect(found.map((address) => address.address)).toEqual(['100.101.102.103', 'fd7a:115c:a1e0::5', '192.168.1.20'])
    expect(pickRemoteAddress('auto', found).kind).toBe('tailscale')
    expect(pickRemoteAddress('lan', found).address).toBe('192.168.1.20')
    expect(hostPart(found[1]!)).toBe('[fd7a:115c:a1e0::5]')
  })

  it('explains what to do when there is no usable address', () => {
    expect(() => pickRemoteAddress('auto', [])).toThrow('Join a Wi-Fi network or start Tailscale')
    expect(() => pickRemoteAddress('tailscale', remoteAddresses({ en0: [entry('192.168.1.20')] }))).toThrow('No Tailscale address')
  })
})
