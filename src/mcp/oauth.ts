// OAuth sign-in for a remote connection. State is kept with the connection's other secrets.
// Only an interactive provider (a sign-in a person started) may open a browser; a session that
// needs a new sign-in fails instead.
import { auth, UnauthorizedError } from '@modelcontextprotocol/client'
import type { OAuthClientInformationContext, OAuthClientMetadata, OAuthClientProvider, OAuthDiscoveryState, StoredOAuthClientInformation, StoredOAuthTokens } from '@modelcontextprotocol/client'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

import { HarnessError } from '../core/errors'
import { MCP_OAUTH_PORT, MCP_OAUTH_REDIRECT_URL, type HttpConfig } from './types'

interface Saved {
  client?: StoredOAuthClientInformation
  tokens?: StoredOAuthTokens
  discovery?: OAuthDiscoveryState
  staticClient?: StoredOAuthClientInformation
  staticIssuer?: string
}

/** Where a connection's OAuth state is read and written, and how a sign-in page is shown. */
export interface OAuthHost {
  load(connectionId: string): Promise<Record<string, unknown>>
  save(connectionId: string, state: Record<string, unknown>): Promise<void>
  openUrl(url: string): Promise<void> | void
  /** The name shown on the provider's consent page. */
  clientName: string
}

export class StoredOAuthProvider implements OAuthClientProvider {
  readonly expectedState = randomUUID()
  private verifier: string | null = null

  constructor(
    private readonly host: OAuthHost,
    private readonly config: Pick<HttpConfig, 'id' | 'scopes'>,
    private readonly interactive: boolean
  ) {}

  get redirectUrl(): string {
    return MCP_OAUTH_REDIRECT_URL
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.host.clientName,
      redirect_uris: [MCP_OAUTH_REDIRECT_URL],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(this.config.scopes.length ? { scope: this.config.scopes.join(' ') } : {})
    }
  }

  state(): string {
    return this.expectedState
  }

  private load(): Promise<Saved> {
    return this.host.load(this.config.id) as Promise<Saved>
  }

  private async change(edit: (saved: Saved) => Saved): Promise<void> {
    await this.host.save(this.config.id, edit(await this.load()) as Record<string, unknown>)
  }

  async clientInformation(context?: OAuthClientInformationContext): Promise<StoredOAuthClientInformation | undefined> {
    const saved = await this.load()
    if (!saved.staticClient) return saved.client
    // A client the user registered themselves (providers without dynamic registration) wins. It is
    // tied to the authorization server seen at sign-in, so a session never offers it to another one.
    if (this.interactive && context && saved.staticIssuer !== context.issuer) await this.change((current) => ({ ...current, staticIssuer: context.issuer }))
    const issuer = this.interactive ? context?.issuer : saved.staticIssuer
    return issuer ? { ...saved.staticClient, issuer } : saved.staticClient
  }

  async saveClientInformation(client: StoredOAuthClientInformation): Promise<void> {
    await this.change((saved) => ({ ...saved, client }))
  }

  async tokens(): Promise<StoredOAuthTokens | undefined> {
    return (await this.load()).tokens
  }

  async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
    await this.change((saved) => ({ ...saved, tokens }))
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.load()).discovery
  }

  async saveDiscoveryState(discovery: OAuthDiscoveryState): Promise<void> {
    await this.change((saved) => ({ ...saved, discovery }))
  }

  saveCodeVerifier(verifier: string): void {
    this.verifier = verifier
  }

  codeVerifier(): string {
    if (!this.verifier) throw new UnauthorizedError('Sign-in was not started from this app.')
    return this.verifier
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'verifier' || scope === 'all') this.verifier = null
    if (scope === 'verifier') return
    await this.change((saved) => (scope === 'all' ? {} : { ...saved, [scope]: undefined }))
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.interactive) throw new UnauthorizedError('Sign in again in Connections.')
    // Google only returns a refresh token when offline access is requested with a consent prompt.
    if (url.hostname === 'accounts.google.com') {
      url.searchParams.set('access_type', 'offline')
      url.searchParams.set('prompt', 'consent')
    }
    await this.host.openUrl(url.toString())
  }
}

const page = (title: string, message: string): string => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;margin:20vh auto;max-width:28rem;text-align:center"><p>${message}</p></body>`

// One sign-in owns the loopback port. Starting another ends the one still waiting, so a closed
// browser tab never blocks a retry.
let cancelActive: (() => Promise<void>) | null = null

/** Waits on the fixed loopback address for the provider to send the browser back. */
function listenForCallback(expectedState: string, clientName: string): Promise<{ result: Promise<{ code: string; iss?: string }>; close: () => Promise<void> }> {
  return new Promise((ready, failed) => {
    let settle: { resolve: (value: { code: string; iss?: string }) => void; reject: (error: Error) => void }
    const result = new Promise<{ code: string; iss?: string }>((resolve, reject) => {
      settle = { resolve, reject }
    })
    result.catch(() => undefined)
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', MCP_OAUTH_REDIRECT_URL)
      const reply = (status: number, message: string): void => {
        response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
        response.end(page(clientName, message))
      }
      if (url.pathname !== new URL(MCP_OAUTH_REDIRECT_URL).pathname) return reply(404, 'Not found.')
      // Anything on this machine can reach the port; only the request carrying this sign-in's state counts.
      if (url.searchParams.get('state') !== expectedState) return reply(400, `This sign-in link is not the one ${clientName} is waiting for.`)
      const code = url.searchParams.get('code')
      if (!code) {
        reply(400, 'Sign-in was not completed. You can close this window.')
        return settle.reject(new HarnessError('mcp_unauthorized', url.searchParams.get('error') === 'access_denied' ? 'Sign-in was cancelled.' : 'The provider did not complete the sign-in.'))
      }
      reply(200, `Signed in. You can close this window and return to ${clientName}.`)
      settle.resolve({ code, iss: url.searchParams.get('iss') ?? undefined })
    })
    const timer = setTimeout(() => settle.reject(new HarnessError('mcp_unauthorized', 'Sign-in timed out. Try again.')), 300000)
    server.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      failed(new HarnessError('invalid_request', error.code === 'EADDRINUSE' ? `Port ${MCP_OAUTH_PORT} is in use. Finish or cancel the other sign-in, or quit the program using that port, then try again.` : 'The sign-in listener could not start.'))
    })
    const closed = new Promise<void>((resolve) => server.once('close', resolve))
    const close = (): Promise<void> => {
      clearTimeout(timer)
      if (cancelActive === cancel) cancelActive = null
      server.close()
      server.closeAllConnections()
      return closed
    }
    const cancel = (): Promise<void> => {
      settle.reject(new HarnessError('mcp_unauthorized', 'Sign-in was cancelled.'))
      return close()
    }
    server.listen(MCP_OAUTH_PORT, '127.0.0.1', () => {
      cancelActive = cancel
      ready({ result, close })
    })
  })
}

/** Opens the provider's sign-in page and waits for the browser to return to the loopback address. */
export async function signIn(host: OAuthHost, config: HttpConfig): Promise<void> {
  const provider = new StoredOAuthProvider(host, config, true)
  const scope = config.scopes.join(' ') || undefined
  await cancelActive?.()
  const callback = await listenForCallback(provider.expectedState, host.clientName)
  try {
    if ((await auth(provider, { serverUrl: config.url, scope, forceReauthorization: true })) === 'REDIRECT') {
      const { code, iss } = await callback.result
      if ((await auth(provider, { serverUrl: config.url, scope, authorizationCode: code, iss })) !== 'AUTHORIZED') throw new HarnessError('mcp_unauthorized', 'The provider did not complete the sign-in.')
    }
  } catch (error) {
    if (error instanceof HarnessError) throw error
    // Provider responses can quote credentials; report only that it failed.
    throw new HarnessError('mcp_unauthorized', `${config.name} sign-in failed. Check the connection's address and OAuth client, then try again.`)
  } finally {
    await callback.close()
  }
}
