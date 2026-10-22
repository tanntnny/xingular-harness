import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const [cli, scratch] = process.argv.slice(2)
const child = spawn(process.execPath, [cli, 'serve', '--state', join(scratch, 'server-state'), '--data', join(scratch, 'server-data')], { stdio: ['pipe', 'pipe', 'inherit'] })
const waiting = new Map()
let ready
const started = new Promise(resolve => { ready = resolve })
const timeout = setTimeout(() => { child.kill(); throw new Error('Packaged server timed out.') }, 30_000)
createInterface({ input: child.stdout }).on('line', line => {
  const value = JSON.parse(line)
  if (value.notice?.type === 'ready') ready()
  const pending = waiting.get(value.id)
  if (pending) {
    waiting.delete(value.id)
    if (value.error) pending.reject(new Error(value.error.message))
    else pending.resolve(value.result)
  }
})
let sequence = 0
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = `release-${++sequence}`
  waiting.set(id, { resolve, reject })
  child.stdin.write(`${JSON.stringify({ v: 1, id, method, params })}\n`)
})
try {
  await started
  const context = { caller: {}, cwd: scratch, accountId: null, model: null, tools: [] }
  const report = await call('doctor.start', { context, checks: ['runtime.storage'] })
  const snapshot = await call('doctor.read', { id: report.id })
  assert.equal(snapshot.id, report.id)
  assert.ok(['completed', 'cancelled'].includes((await call('doctor.cancel', { id: report.id })).state))
  await call('harness.shutdown')
  console.log('Packaged server protocol passed.')
} finally {
  clearTimeout(timeout)
  child.stdin.end()
  child.kill()
}
