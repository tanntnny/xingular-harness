import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { Harness, type HarnessOptions } from '../harness'

export const HUB_USAGE = `Usage: xharness hub <list | show | install> [id@version] [options]

  list [--refresh]             Browse the curated catalog and locally installed versions
  show <id@version>            Show publisher, license, source, and delivery details
  install <id@version>         Install the exact reviewed version, disabled and untrusted

  --data <dir>                 Target data library (default: ~/.xingular-harness/data)
  --state <dir>                Target device state (default: ~/.xingular-harness/state)
  --refresh                    Refresh the public catalog; cached items remain usable offline
`

export async function runHubCli(argv: string[], dependencies: { home?: string; write?: (text: string) => void; createHarness?: (options: HarnessOptions) => Harness } = {}): Promise<number> {
  const write = dependencies.write ?? ((text: string) => void process.stdout.write(text))
  const args: string[] = []
  const values: Record<string, string> = {}
  let refresh = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--refresh') refresh = true
    else if (arg === '--data' || arg === '--state') {
      const value = argv[++index]
      if (!value || value.startsWith('--')) { write(`${arg} needs a directory.\n`); return 2 }
      values[arg.slice(2)] = resolve(value)
    } else if (arg.startsWith('--')) { write(`Unknown option ${arg}.\n`); return 2 }
    else args.push(arg)
  }
  const [command, target] = args
  if (!command || command === 'help') { write(HUB_USAGE); return 0 }
  if (!['list', 'show', 'install'].includes(command)) { write(HUB_USAGE); return 2 }
  const root = join(dependencies.home ?? homedir(), '.xingular-harness')
  const options: HarnessOptions = { dataRoot: values.data ?? join(root, 'data'), stateDir: values.state ?? join(root, 'state') }
  const harness = dependencies.createHarness?.(options) ?? new Harness(options)
  try {
    const overview = await harness.hub.list(refresh)
    if (overview.error) write(`Catalog refresh failed: ${overview.error} Using ${overview.origin} content.\n`)
    if (command === 'list') {
      write(`Library: ${options.dataRoot}\n${overview.entries.map((entry) => `${entry.id}@${entry.version}  ${entry.category}  ${entry.title}${overview.installed.some((receipt) => receipt.entry.id === entry.id && receipt.entry.version === entry.version) ? ' · installed' : ''}`).join('\n')}\n`)
      return 0
    }
    const split = target?.lastIndexOf('@') ?? -1
    if (!target || split < 1) throw new Error('Name an exact item as publisher/name@version. Run hub list to see versions.')
    const id = target.slice(0, split)
    const version = target.slice(split + 1)
    const entry = await harness.hub.get(id, version)
    if (command === 'show') {
      const { bundled: _bundled, ...delivery } = entry.delivery.kind === 'pi-package' ? { ...entry.delivery, bundled: undefined } : entry.delivery
      write(`${entry.title} (${target})\n${entry.description}\nPublisher: ${entry.publisher}\nLicense: ${entry.license}\nSource: ${entry.sourceUrl}\nDelivery: ${JSON.stringify(delivery)}\n`)
    } else {
      const receipt = await harness.hub.install(id, version)
      write(receipt.document ? `Saved ${target} in ${options.dataRoot}/hub/documents/${receipt.document}. Open this library in a compatible application to apply it.\n` : `Installed ${target}, switched off. Attach it separately${entry.delivery.kind === 'pi-package' ? ' and review/trust any code' : ''} before using it.\n`)
    }
    return 0
  } catch (error) { write(`${error instanceof Error ? error.message : String(error)}\n`); return 1 }
  finally { await harness.close() }
}
