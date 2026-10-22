// `xharness web` and `xharness browser`: the settings a person keeps for the world tools on this
// device. Keys are read from standard input, never from the command line, so they stay out of
// shell history.
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { fileSecretStore, type SecretStore } from '../accounts/secrets'
import * as attachments from '../plugins/attachments'
import { settingValue } from '../plugins/firstParty'
import { readBrowserConfig, writeBrowserConfig, type BrowserConfig } from '../browser/config'
import { SEARCH_PROVIDERS } from '../web/search'
import { KEYLESS_SEARCH, WEB_PLUGIN, WEB_SETTINGS } from '../web/tools'

export const WEB_USAGE = `Usage: xharness web <status | key <provider> [--remove] | keyless on|off> [--state <dir>] [--data <dir>]

  status                 Which search services are ready
  key <provider>         Save a key for brave, tavily or exa, read from standard input
  key <provider> --remove
                         Forget that key
  keyless on|off         Search DuckDuckGo's public results page when no key is saved
                         (default off; it often answers automated requests with a bot check)
`

export const BROWSER_USAGE = `Usage: xharness browser [status | set <options>] [--state <dir>]

  status                       How the browser runs
  set --headed | --headless    Show the browser window, or not (default: headless)
  set --allow-private | --public-only
                               Let pages reach this machine and private networks (local
                               development), or only public addresses (default)
  set --domains a.com,b.org | --any-domain
                               Only these sites (and their subdomains), or any
  set --attach <http://127.0.0.1:9222> | --launch
                               Use a browser you already run (its DevTools address, on this
                               machine), or launch one (default: Chrome, Edge, then Chromium)
  set --executable <path> | --default-executable
`

interface CliDependencies {
  home?: string
  write?: (text: string) => void
  read?: () => Promise<string>
  secrets?: SecretStore
}

function stateOf(argv: string[], home: string): { args: string[]; stateDir: string; dataRoot: string } {
  const args: string[] = []
  let stateDir = join(home, '.xingular-harness', 'state')
  let dataRoot = join(home, '.xingular-harness', 'data')
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--state') stateDir = resolve(argv[++index] ?? stateDir)
    else if (argv[index] === '--data') dataRoot = resolve(argv[++index] ?? dataRoot)
    else args.push(argv[index])
  }
  return { args, stateDir, dataRoot }
}

const keylessSetting = WEB_SETTINGS.find((setting) => setting.key === KEYLESS_SEARCH)!
const keylessOn = (dataRoot: string): boolean => settingValue(keylessSetting, attachments.load(dataRoot).settings[WEB_PLUGIN.id]) === 1

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

export async function runWebCli(argv: string[], dependencies: CliDependencies = {}): Promise<number> {
  const write = dependencies.write ?? ((text: string) => void process.stdout.write(text))
  const { args, stateDir, dataRoot } = stateOf(argv, dependencies.home ?? homedir())
  const secrets = dependencies.secrets ?? fileSecretStore(join(stateDir, 'secrets.json'))
  const [command, name] = args
  if (!command || command === 'help') {
    write(WEB_USAGE)
    return command ? 0 : 2
  }
  if (command === 'status') {
    for (const provider of SEARCH_PROVIDERS) {
      if (!provider.key) {
        write(`${provider.title.padEnd(22)} ${keylessOn(dataRoot) ? 'on' : 'off (xharness web keyless on)'}\n`)
        continue
      }
      write(`${provider.title.padEnd(22)} ${(await secrets.get(provider.key)) ? 'key saved' : 'no key'}\n`)
    }
    return 0
  }
  if (command === 'keyless') {
    if (name !== 'on' && name !== 'off') {
      write('Say on or off: xharness web keyless on\n')
      return 2
    }
    const choices = attachments.load(dataRoot)
    choices.settings[WEB_PLUGIN.id] = { ...choices.settings[WEB_PLUGIN.id], [KEYLESS_SEARCH]: name === 'on' ? 1 : 0 }
    attachments.save(dataRoot, choices)
    write(`Keyless search is ${name}. It applies from the next search.\n`)
    return 0
  }
  if (command === 'key') {
    const provider = SEARCH_PROVIDERS.find((candidate) => candidate.id === name && candidate.key)
    if (!provider?.key) {
      write(`Name a provider: ${SEARCH_PROVIDERS.filter((candidate) => candidate.key).map((candidate) => candidate.id).join(', ')}.\n`)
      return 2
    }
    if (args.includes('--remove')) {
      await secrets.delete(provider.key)
      write(`Forgot the ${provider.title} key.\n`)
      return 0
    }
    const key = (await (dependencies.read ?? readStdin)()).trim()
    if (!key || /\s/.test(key)) {
      write('Give the key on standard input, for example: pbpaste | xharness web key brave\n')
      return 2
    }
    await secrets.set(provider.key, key)
    write(`Saved the ${provider.title} key.\n`)
    return 0
  }
  write(WEB_USAGE)
  return 2
}

function describe(config: BrowserConfig): string {
  return [
    `Window:     ${config.headed ? 'shown' : 'headless'}`,
    `Browser:    ${config.cdpUrl ? `attached to ${config.cdpUrl}` : config.executablePath ?? 'Chrome, then Edge, then Chromium'}`,
    `Addresses:  ${config.allowPrivate ? 'public and private' : 'public only'}`,
    `Sites:      ${config.allowedDomains.length ? config.allowedDomains.join(', ') : 'any'}`
  ].join('\n') + '\n'
}

export async function runBrowserCli(argv: string[], dependencies: CliDependencies = {}): Promise<number> {
  const write = dependencies.write ?? ((text: string) => void process.stdout.write(text))
  const { args, stateDir } = stateOf(argv, dependencies.home ?? homedir())
  const [command, ...options] = args
  if (!command || command === 'status') {
    write(describe(readBrowserConfig(stateDir)))
    return 0
  }
  if (command !== 'set') {
    write(BROWSER_USAGE)
    return command === 'help' ? 0 : 2
  }
  const change: Partial<BrowserConfig> = {}
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index]
    if (option === '--headed') change.headed = true
    else if (option === '--headless') change.headed = false
    else if (option === '--allow-private') change.allowPrivate = true
    else if (option === '--public-only') change.allowPrivate = false
    else if (option === '--any-domain') change.allowedDomains = []
    else if (option === '--domains') change.allowedDomains = (options[++index] ?? '').split(',').map((domain) => domain.trim()).filter(Boolean)
    else if (option === '--launch') change.cdpUrl = null
    else if (option === '--attach') change.cdpUrl = options[++index] ?? null
    else if (option === '--default-executable') change.executablePath = null
    else if (option === '--executable') change.executablePath = options[++index] ?? null
    else {
      write(`Unknown option ${option}.\n${BROWSER_USAGE}`)
      return 2
    }
  }
  const saved = writeBrowserConfig(stateDir, change)
  if (change.cdpUrl && !saved.cdpUrl) {
    write('Only a DevTools address on this machine can be attached, such as http://127.0.0.1:9222.\n')
    return 2
  }
  write(describe(saved))
  write('Sessions already running keep their browser until it closes.\n')
  return 0
}
