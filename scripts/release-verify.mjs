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
for (let attempt = 0; attempt < 6; attempt++) {
  try {
    const metadata = await read('https://registry.npmjs.org/@xingular%2fharness')
    const published = metadata.versions?.[candidate.version]
    assert.ok(published)
    assert.equal(metadata['dist-tags'].latest, candidate.version)
    assert.equal(published.dist.integrity, candidate.integrity)
    assert.ok(published.dist.attestations?.url, 'Published provenance is missing.')
    console.log(`Verified @xingular/harness@${candidate.version}, latest, tarball integrity and provenance.`)
    process.exit(0)
  } catch (error) { last = error; if (attempt < 5) await new Promise(resolve => setTimeout(resolve, 5000)) }
}
throw last
