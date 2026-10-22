import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { Harness } from '../harness'
import { defaultAssets, type TerminalAssets } from '../terminal/terminals'
import { loadPi, PINNED_PI_VERSION } from '../pi/runtime'
import { list as listPlugins } from '../plugins/api'
import { compile } from '../prompt/compile'
import { materialise } from '../variant/materialise'
import { validate } from '../variant/variant'
import { PI_SURFACE } from '../variant/surface'
import { allowed } from '../mcp/connections'
import { BRAVE, TAVILY, EXA } from '../web/search'
import { KEYLESS_SEARCH, WEB_PLUGIN } from '../web/tools'
import type { SecretStore } from '../accounts/secrets'
import type { CheckResult, DoctorCheck, DoctorContext } from './types'

const pass = (evidence: string): CheckResult => ({ status: 'pass', evidence })
const fail = (evidence: string, remedy: string): CheckResult => ({ status: 'fail', evidence, remedy })

function executable(name: string): boolean {
  const paths = isAbsolute(name) ? [name] : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => join(dir, name))
  return paths.some(path => {
    try { accessSync(path, constants.X_OK); return statSync(path).isFile() } catch { return false }
  })
}

export async function builtinChecks(harness: Harness, context: DoctorContext, secrets: SecretStore, assets: TerminalAssets = defaultAssets()): Promise<DoctorCheck[]> {
  const check = (id: string, category: string, title: string, local: DoctorCheck['local']): DoctorCheck => ({ id, category, title, local })
  const account = () => context.accountId ? harness.accounts.find(context.accountId) : null
  const checks: DoctorCheck[] = [
    check('account', 'account', 'Selected account', async signal => {
      const selected = account()
      if (!selected) return fail('No account is selected.', 'Choose an account with /accounts.')
      const saved = harness.accounts.overview().accounts.find(item => item.id === selected.id)!
      const inspected = await harness.accounts.inspect(selected.id, signal)
      if (!inspected.credentials) return fail('The pinned account has no saved provider credentials.', 'Sign in or add a key in /accounts.')
      return { status: saved.state.health === 'ok' || saved.state.health === 'unknown' ? 'pass' : 'warning', evidence: `Credentials are configured. Saved health: ${saved.state.health}; checked ${saved.state.lastCheckedAt ?? 'never'}. ${saved.state.limits.map(limit => `${limit.label || limit.id}: ${limit.usedPercent}% used; resets ${limit.resetsAt ?? 'unknown'}`).join('; ')} ${saved.state.lastError ? `Saved issue: ${saved.state.lastError.category}.` : ''} This does not verify authentication with the provider.`, remedy: saved.state.health === 'ok' ? undefined : 'Use the model live probe to verify current provider access.' }
    }),
    check('accounts.inventory', 'account', 'Other saved accounts', async () => {
      const others = harness.accounts.overview().accounts.filter(item => item.id !== context.accountId)
      return pass(others.length ? others.map(item => `${item.label}: ${item.state.health}; checked ${item.state.lastCheckedAt ?? 'never'}`).join('\n') : 'No other saved accounts.')
    }),
    {
      ...check('model', 'account', 'Selected model', async signal => {
        if (!context.accountId || !context.model) return fail('No account/model is selected.', 'Choose an account and /model.')
        const model = (await harness.accounts.inspect(context.accountId, signal)).models.find(item => item.id === context.model)
        return model ? pass(`${model.id} is available locally; images: ${model.supportsImages}; reasoning: ${model.reasoning}. Provider access is unverified.`) : fail('The selected model is absent from the account model catalogue.', 'Choose an available model with /model.')
      }),
      live: {
        notice: 'One provider request on the selected account/model, up to 64 output tokens; charges may apply. Only synthetic diagnostic content is sent.',
        run: async ({ signal, run }) => {
          const selected = account()
          if (!selected || !context.model) return fail('No account/model is selected.', 'Choose an account and /model.')
          const runtime = await harness.accounts.runtime(selected)
          const model = (await runtime.getAvailable()).find(item => `${item.provider}/${item.id}` === context.model)
          if (!model) return fail('The selected model is unavailable.', 'Choose an available model with /model.')
          signal.throwIfAborted()
          const result = await runtime.completeSimple(model, { messages: [{ role: 'user', content: 'Reply with OK.', timestamp: Date.now() }] }, { maxTokens: 64, signal })
          const usage = result.usage
          run.emit('usage.updated', {
            inputTokens: usage.input, outputTokens: usage.output, cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite,
            costUsd: usage.cost.total, costSource: 'harness', requests: 1, model: result.model, provider: result.provider,
            request: { index: 1, model: result.model, provider: result.provider, stopReason: result.stopReason }
          })
          return result.stopReason === 'error' || result.stopReason === 'aborted'
            ? fail(`The provider request ended with ${result.stopReason}.`, 'Review account authentication, limits, and model configuration.')
            : pass('The selected provider/model completed a real request. Usage is recorded on the diagnostic run.')
        }
      }
    },
    check('runtime.pi', 'runtime', 'Pi runtime', async () => { await loadPi(); return pass(`Pi ${PINNED_PI_VERSION} loaded with its required dispatcher.`) }),
    check('runtime.launcher', 'runtime', 'Terminal launcher', async () => {
      if (!executable(assets.node)) return fail('The configured Node executable cannot be accessed.', 'Check the host launch configuration.')
      return executable(process.env.XINGULAR_HARNESS_BUN || 'bun')
        ? pass('Node and Bun executables are accessible. No process was launched for this check.')
        : { status: 'warning', evidence: 'Bun was not found on the inherited PATH or at XINGULAR_HARNESS_BUN. The terminal launcher may resolve an additional login-shell path.', remedy: 'Verify the terminal Bun launch path.' }
    }),
    {
      ...check('native.files', 'tools', 'Native file tools', async () => {
        accessSync(context.cwd, constants.R_OK)
        if (context.tools.some(name => name === 'write' || name === 'edit')) {
          try { accessSync(context.cwd, constants.W_OK) }
          catch { return { status: 'blocked', evidence: 'The working directory is readable but not writable.', remedy: 'Choose a writable working directory for edits.' } }
        }
        return pass('The working directory is accessible for enabled native file tools. Per-call policy and actual file operations are unverified.')
      }), tools: ['read', 'grep', 'find', 'ls', 'write', 'edit']
    },
    {
      ...check('native.bash', 'tools', 'Native shell tool', async () => process.platform === 'win32'
        ? { status: 'unverified', evidence: 'Windows shell resolution is delegated to Pi; no shell was launched.' }
        : executable('bash') ? pass('Bash is executable on the inherited PATH. No shell command was run.') : fail('Bash was not found on the inherited PATH.', 'Verify the shell executable used by Pi.')),
      tools: ['bash']
    },
    check('runtime.storage', 'runtime', 'State and data storage', async () => {
      accessSync(harness.stateDir, constants.R_OK | constants.W_OK)
      if (!harness.dataRoot) return fail('No data root is open.', 'Open a data location before starting runs.')
      accessSync(harness.dataRoot, constants.R_OK | constants.W_OK)
      accessSync(context.cwd, constants.R_OK)
      return pass('State/data directories are accessible and the working directory is readable. Write access is checked without writing files.')
    }),
    check('runtime.assets', 'runtime', 'Terminal assets', async () => {
      const files = [assets.cli, assets.openTui, assets.piExtension]
      const missing = files.filter(file => !existsSync(file))
      return missing.length ? { status: 'warning', evidence: `Configured terminal assets are missing: ${missing.join(', ')}.`, remedy: 'Build the Harness or verify the host-supplied assets.' } : pass('Configured terminal assets are present.')
    }),
    check('runtime.recovery', 'runtime', 'Startup recovery', async () => harness.recovery.migrationError
      ? fail('Startup recorded a storage migration error.', 'Review the recovery diagnostics before starting work.')
      : { status: harness.recovery.interruptedRuns ? 'warning' : 'pass', evidence: `${harness.recovery.interruptedRuns} interrupted runs recovered; no recorded migration error.` }),
    check('variant', 'variant', 'Pinned variant and prompt', async () => {
      if (!harness.dataRoot) return { status: 'blocked', evidence: 'Variant and prompt inspection needs an open data root.', remedy: 'Open a data location.' }
      if (!context.variant) { compile(harness.env, context.caller, {}); return pass('No variant is selected; the foundation prompt compiles.') }
      const variant = materialise(harness.env.root, context.variant, { trust: harness.trust })
      validate(PI_SURFACE, variant.files)
      compile(harness.env, context.caller, { tools: [...context.tools] }, variant)
      return { status: variant.untrustedPlugins.length ? 'warning' : 'pass', evidence: `Variant ${variant.fingerprint} validates and its prompt compiles; ${variant.untrustedPlugins.length} code resources withheld for trust.` }
    }),
    check('plugins', 'plugins', 'Plugins, skills and resources', async () => {
      if (!harness.dataRoot) return { status: 'blocked', evidence: 'Plugin inspection needs an open data root.', remedy: 'Open a data location.' }
      const plugins = await listPlugins(harness, { ...context.caller, cwd: context.cwd, accountId: context.accountId })
      const contributions = plugins.flatMap(plugin => plugin.contributions)
      const problems: string[] = []
      for (const item of contributions.filter(item => item.state === 'on')) {
        if (item.problem) problems.push(`${item.name}: recorded resource error`)
        if (item.path) {
          try { accessSync(item.path, constants.R_OK); if (item.kind === 'skill') readFileSync(item.path, 'utf8') }
          catch { problems.push(`${item.name}: resource cannot be read`) }
        }
      }
      const names = contributions.filter(item => item.kind === 'tool' && item.state === 'on').map(item => item.name)
      const duplicates = [...new Set(names.filter((name, index) => names.indexOf(name) !== index))]
      if (duplicates.length) problems.push(`Overlapping tool contributions: ${duplicates.join(', ')}`)
      const withheld = contributions.filter(item => item.state === 'untrusted').length
      return problems.length ? fail(problems.join('\n'), 'Review /plugins and the resource configuration.') : { status: withheld ? 'warning' : 'pass', evidence: `${plugins.length} plugins inspected; ${withheld} untrusted resources withheld. No plugin code was executed for diagnostics. Transitive dependencies are unverified until loaded normally.` }
    })
  ]
  const providers = [BRAVE, TAVILY, EXA]
  checks.push({
    ...check('web.search', 'web', 'Web search', async () => {
      const configured = (await Promise.all(providers.map(async provider => await secrets.get(provider.key!) ? provider.title : null))).filter(Boolean)
      const keyless = harness.dataRoot !== null && harness.world.setting(WEB_PLUGIN.id, KEYLESS_SEARCH) === 1
      return configured.length || keyless ? pass(`Configured: ${[...configured, ...(keyless ? ['DuckDuckGo (keyless)'] : [])].join(', ')}. Keys have not been authenticated.`) : fail('No search provider key is saved and keyless search is disabled.', 'Configure Web in /plugins.')
    }), tools: ['web_search'],
    live: { notice: 'Search the public web for “example domain” through configured Brave, Tavily, Exa, or DuckDuckGo endpoints; search API charges may apply.', run: async probe => {
      const result = await probe.call('web_search', { queries: ['example domain'] })
      const details = typeof result === 'string' ? undefined : result.details
      return details?.provider && Array.isArray(details.sources) && details.sources.length ? pass(`Search completed through ${String(details.provider)}.`) : fail('Search did not return verified results.', 'Review configured search providers and limits.')
    } }
  })
  checks.push({
    ...check('web.fetch', 'web', 'Public web fetch', async () => pass('Checked public HTTP reader is installed; network access is unverified.')),
    tools: ['web_fetch'], live: { notice: 'Fetch https://example.com/ through the enabled web_fetch tool.', run: async probe => {
      const result = await probe.call('web_fetch', { url: 'https://example.com/' })
      return typeof result !== 'string' && result.details?.status === 200 ? pass('The public page returned HTTP 200 and readable text.') : fail('The public page could not be read.', 'Check network access and retry.')
    } }
  })
  for (const connection of harness.dataRoot ? harness.apps.connections.list() : []) {
    const inScope = allowed(connection, context.caller) && (!context.capabilities || context.capabilities.connectors.includes(connection.id))
    checks.push({
      ...check(`mcp.${connection.id}`, 'mcp', `MCP: ${connection.name}`, async () => {
        if (!connection.enabled) return { status: 'disabled', evidence: 'The connection is disabled.' }
        if (!inScope) return { status: 'blocked', evidence: 'The connection is outside this diagnostic scope.' }
        if (connection.auth === 'oauth' && connection.authState !== 'signed_in') return { status: 'warning', evidence: `Saved authentication state: ${connection.authState ?? 'unknown'}.`, remedy: 'Check connector authentication in the host.' }
        return { status: connection.error ? 'warning' : 'pass', evidence: `Configured; last checked ${connection.checkedAt ?? 'never'}; ${connection.tools.length} cached tools. Live connectivity is unverified.` }
      }),
      tools: ['mcp_list_tools'],
      live: { notice: `Connect to configured MCP server “${connection.name}” and list its tools. A configured local server process may start. No connector tools are invoked.`, run: async probe => {
        if (!connection.enabled || !inScope) return { status: 'blocked', evidence: 'This connection is disabled or outside the selected scope.' }
        const result = await probe.call('mcp_list_tools', { connectionId: connection.id })
        const details = typeof result === 'string' ? undefined : result.details
        return details?.doctorOk === true ? pass(`${String(details.toolCount)} tools listed.`) : fail('The MCP server could not list tools.', 'Review its transport, authentication, and scope.')
      } }
    })
  }
  // A tool without diagnostics is present in the report without claiming its backend works.
  const supplied = await harness.sessions.diagnostics(context)
  const covered = new Set([...checks, ...supplied].flatMap(item => item.tools ?? []))
  for (const tool of context.tools.filter(tool => !covered.has(tool))) checks.push(check(`tool.${tool}`, 'tools', tool, async () => ({ status: 'unverified', evidence: 'Enabled in this session; this provider has no readiness check.', remedy: 'Use the tool normally or add provider diagnostics.' })))
  return [...checks, ...supplied]
}
