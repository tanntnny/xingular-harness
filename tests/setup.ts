// Pi looks for skills in the home folder's `.agents`. Tests get an empty home, so what a
// session or terminal loads never depends on the machine the tests run on.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HOME = mkdtempSync(join(tmpdir(), 'harness-home-'))
