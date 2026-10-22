import solidPlugin from '@opentui/solid/bun-plugin'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const result = await Bun.build({
  entrypoints: [join(root, 'src/terminal/opentui/entry.tsx')],
  outdir: join(root, 'dist'),
  naming: 'terminal-opentui.js',
  target: 'bun',
  packages: 'external',
  format: 'esm',
  plugins: [solidPlugin],
  external: [
    '@earendil-works/pi-coding-agent',
    '@earendil-works/pi-tui',
    '@earendil-works/pi-agent-core',
    '@earendil-works/pi-ai',
    '@opentui/core',
    '@opentui/solid',
    'solid-js'
  ]
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
