import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

type SiteAccess = {
  originOf(address: string): string | null
  permissionFor(address: string): string | null
  allowed(address: string): Promise<boolean>
  grant(address: string): Promise<boolean>
  revoke(address: string): Promise<void>
  forgetRemoved(permissions: { origins?: string[] }): Promise<void>
}

type PermissionRequest = { origins: string[] }

function harness(allowedOrigins: string[] = []) {
  const state = { allowedOrigins: [...allowedOrigins] }
  const requested: PermissionRequest[] = []
  const removed: PermissionRequest[] = []
  const checked: PermissionRequest[] = []
  const api = {
    storage: {
      local: {
        get: async () => ({ allowedOrigins: state.allowedOrigins }),
        set: async (value: { allowedOrigins: string[] }) => { state.allowedOrigins = [...value.allowedOrigins] }
      }
    },
    permissions: {
      contains: async (value: PermissionRequest) => { checked.push(value); return true },
      request: async (value: PermissionRequest) => { requested.push(value); return true },
      remove: async (value: PermissionRequest) => { removed.push(value); return true }
    }
  }
  const sandbox: Record<string, unknown> = { chrome: api, URL }
  const source = readFileSync(join(process.cwd(), 'browser-extension', 'site-access.js'), 'utf8')
  runInNewContext(source, sandbox)
  return { access: sandbox.XingularSiteAccess as SiteAccess, state, requested, removed, checked }
}

describe('Brave extension site access', () => {
  it('requires the exact stored origin even when the browser grants a broader host', async () => {
    const { access, checked } = harness(['http://127.0.0.1:8123'])

    expect(access.originOf('http://127.0.0.1:8123/private')).toBe('http://127.0.0.1:8123')
    expect(access.permissionFor('http://127.0.0.1:8123/private')).toBe('http://127.0.0.1/*')
    expect(await access.allowed('http://127.0.0.1:8123/private')).toBe(true)
    expect(await access.allowed('http://127.0.0.1:8124/private')).toBe(false)
    expect(await access.allowed('https://127.0.0.1:8123/private')).toBe(false)
    expect(checked).toEqual([{ origins: ['http://127.0.0.1/*'] }])
  })

  it('requests host permission but records the exact origin including its port', async () => {
    const { access, state, requested } = harness()

    expect(await access.grant('https://example.test:3443/account')).toBe(true)
    expect(requested).toEqual([{ origins: ['https://example.test/*'] }])
    expect(state.allowedOrigins).toEqual(['https://example.test:3443'])
  })

  it('keeps shared host permission while another allowed port remains', async () => {
    const { access, state, removed } = harness(['http://127.0.0.1:8123', 'http://127.0.0.1:8124'])

    await access.revoke('http://127.0.0.1:8123')
    expect(state.allowedOrigins).toEqual(['http://127.0.0.1:8124'])
    expect(removed).toEqual([])

    await access.revoke('http://127.0.0.1:8124')
    expect(state.allowedOrigins).toEqual([])
    expect(removed).toEqual([{ origins: ['http://127.0.0.1/*'] }])
  })

  it('forgets exact-origin grants when the browser removes their host permission', async () => {
    const { access, state } = harness(['https://example.test:8443', 'http://example.test:8080'])

    await access.forgetRemoved({ origins: ['https://example.test/*'] })
    expect(state.allowedOrigins).toEqual(['http://example.test:8080'])
  })
})
