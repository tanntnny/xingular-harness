import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url))
const result = spawnSync(process.execPath, [
  vitest, 'run',
  'src/terminal/terminal.test.ts',
  '--no-file-parallelism',
  '--disableConsoleIntercept',
  '--testNamePattern', 'terminal input profile'
], {
  stdio: 'inherit',
  env: { ...process.env, XINGULAR_PROFILE_TERMINAL_INPUT: '1' }
})

if (result.error) throw result.error
process.exitCode = result.status ?? 1
