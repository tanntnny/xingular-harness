// Pi looks for skills in the home folder's `.agents`. Tests get an empty home, so what a
// session or terminal loads never depends on the machine the tests run on.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HOME = mkdtempSync(join(tmpdir(), 'harness-home-'))

// The completion check (ADR-0071) is one more model request at the end of a reply that did work. A
// scripted model would have to answer it in every test that runs real Pi, so it is off here; the
// tests that are about it switch it on with vi.stubEnv('XINGULAR_COMPLETION_CHECK', 'on').
process.env.XINGULAR_COMPLETION_CHECK = 'off'
