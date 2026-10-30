import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const candidate = JSON.parse(readFileSync(resolve(process.argv[2]), 'utf8'))
const read = async url => {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`Registry verification returned HTTP ${response.status}.`)
  return response.json()
}
let last
// The registry announces a fresh version before its packument serves it, so wait rather than fail:
// publication itself has already succeeded by the time this runs.
const deadline = Date.now() + 5 * 60_000
while (Date.now() < deadline) {
  try {
    // A cache-buster keeps a CDN copy of the old packument from looking like a missing version. The
    // dist-tags come from the packument, which is the slowest to catch up; the version's own document
    // is read separately so a stale packument cannot hide the integrity and provenance it lacks.
    const metadata = await read(`https://registry.npmjs.org/@xingular%2fharness?ts=${Date.now()}`)
    const npmTag = candidate.version.includes('-unstable.') ? 'unstable' : 'latest'
    assert.equal(candidate.npmTag, npmTag)
    assert.equal(metadata['dist-tags']?.[npmTag], candidate.version)
    const published = await read(`https://registry.npmjs.org/@xingular%2fharness/${candidate.version}?ts=${Date.now()}`)
    assert.equal(published.version, candidate.version)
    assert.equal(published.dist.integrity, candidate.integrity)
    assert.ok(published.dist.attestations?.url, 'Published provenance is missing.')
    console.log(`Verified @xingular/harness@${candidate.version}, ${npmTag}, tarball integrity and provenance.`)
    process.exit(0)
  } catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, 10_000)) }
}
throw last
