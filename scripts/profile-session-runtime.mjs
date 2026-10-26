#!/usr/bin/env node
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const SCRIPT_VERSION = 1
const MAX_ITERATIONS = 10
const MAX_WARMUPS = 2
const MAX_TIMEOUT_MS = 10_000
const MAX_BENCHMARK_DURATION_MS = 120_000
const TOOL_NAME = 'runtime_benchmark_echo'
const TOOL_REQUEST = 'profile-tool-case'
const RESPONSE_TEXT = 'deterministic benchmark reply'

function usage() {
  return `Usage: node scripts/profile-session-runtime.mjs [options]

Options:
  --output <file>       Write JSON here (exclusive create; never overwrites). An existing
                        directory gets a uniquely named JSON file inside it.
  --iterations <count>  Measured samples per case (1-${MAX_ITERATIONS}, default 3).
  --warmup <count>      Unreported warmups per case (0-${MAX_WARMUPS}, default 1).
  --timeout-ms <ms>     Maximum time per operation (100-${MAX_TIMEOUT_MS}, default 5000).
  --help                Show this help.

The script uses an injected deterministic session and temporary data/state roots. It never
starts a real model or launches the interactive terminal process. It loads dist/sdk/index.js;
run npm run build:sdk first if that file is missing.`
}

function parseArgs(argv) {
  const options = { output: null, iterations: 3, warmups: 1, timeoutMs: 5000 }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') return { ...options, help: true }
    if (!['--output', '--iterations', '--warmup', '--timeout-ms'].includes(argument)) {
      throw new Error(`Unknown option: ${argument}`)
    }
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error(`${argument} needs a value.`)
    if (argument === '--output') options.output = value
    else {
      const number = Number(value)
      if (!Number.isSafeInteger(number)) throw new Error(`${argument} must be an integer.`)
      if (argument === '--iterations') options.iterations = number
      else if (argument === '--warmup') options.warmups = number
      else options.timeoutMs = number
    }
  }
  if (options.iterations < 1 || options.iterations > MAX_ITERATIONS) throw new Error(`--iterations must be between 1 and ${MAX_ITERATIONS}.`)
  if (options.warmups < 0 || options.warmups > MAX_WARMUPS) throw new Error(`--warmup must be between 0 and ${MAX_WARMUPS}.`)
  if (options.timeoutMs < 100 || options.timeoutMs > MAX_TIMEOUT_MS) throw new Error(`--timeout-ms must be between 100 and ${MAX_TIMEOUT_MS}.`)
  return options
}

function outputFilename() {
  const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  return `profile-session-runtime-${timestamp}-${randomUUID().slice(0, 8)}.json`
}

function reserveOutput(requested) {
  let outputPath
  if (!requested) {
    const resultDirectory = mkdtempSync(join(tmpdir(), 'xingular-session-runtime-results-'))
    outputPath = join(resultDirectory, outputFilename())
  } else {
    const candidate = resolve(requested)
    const isDirectory = (existsSync(candidate) && statSync(candidate).isDirectory()) || requested.endsWith(sep)
    outputPath = isDirectory ? join(candidate, outputFilename()) : candidate
    mkdirSync(dirname(outputPath), { recursive: true })
  }
  const descriptor = openSync(outputPath, 'wx', 0o600)
  return { outputPath, descriptor }
}

function writeReservedOutput(descriptor, payload) {
  writeFileSync(descriptor, `${JSON.stringify(payload, null, 2)}\n`)
  closeSync(descriptor)
}

function roundMs(value) {
  return Math.round(value * 1000) / 1000
}

function errorInfo(error) {
  const value = error instanceof Error ? error : new Error(String(error))
  return {
    name: value.name,
    message: value.message.slice(0, 4000),
    ...(typeof value.code === 'string' ? { code: value.code } : {}),
    ...(value.stack ? { stack: value.stack.slice(0, 8000) } : {})
  }
}

function stats(samples, field) {
  const values = samples.filter(sample => sample.ok).map(sample => sample[field] ?? sample.metrics?.[field]).filter(Number.isFinite).sort((a, b) => a - b)
  if (!values.length) return null
  const middle = Math.floor(values.length / 2)
  const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2
  return {
    count: values.length,
    minMs: roundMs(values[0]),
    medianMs: roundMs(median),
    meanMs: roundMs(values.reduce((sum, value) => sum + value, 0) / values.length),
    p95Ms: roundMs(values[Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1)]),
    maxMs: roundMs(values.at(-1))
  }
}

function makeOutcomeWaiter(harness, runId, startAt) {
  const timings = { firstDeltaMs: null, toolStartedMs: null, toolCompletedMs: null, outcomeMs: null }
  let resolveOutcome
  const outcome = new Promise(resolve => { resolveOutcome = resolve })
  const unlisten = harness.runs.listen(event => {
    if (event.runId !== runId) return
    const elapsed = roundMs(performance.now() - startAt)
    if (event.type === 'message.delta' && timings.firstDeltaMs === null) timings.firstDeltaMs = elapsed
    if (event.type === 'tool.started' && timings.toolStartedMs === null) timings.toolStartedMs = elapsed
    if (event.type === 'tool.completed' && timings.toolCompletedMs === null) timings.toolCompletedMs = elapsed
    if (event.type === 'completed' || event.type === 'failed' || (event.type === 'status.changed' && event.payload?.status === 'interrupted')) {
      if (timings.outcomeMs === null) timings.outcomeMs = elapsed
      resolveOutcome(event)
    }
  })
  return { outcome, timings, unlisten }
}

function remainingMs(deadline, requested) {
  const left = Math.floor(deadline - performance.now())
  if (left <= 0) throw new Error('Benchmark-wide 120-second time budget expired.')
  return Math.max(1, Math.min(requested, left))
}

async function within(promise, timeoutMs, description) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${description} exceeded ${timeoutMs} ms.`)), timeoutMs) })
    ])
  } finally {
    clearTimeout(timer)
  }
}

function makeFakeSessionFactory() {
  return async ({ params, tools, gate }) => {
    let listener = () => undefined
    let aborted = false
    const emit = event => listener(event)
    return {
      sessionId: `synthetic-${params.runId}`,
      systemPrompt: params.system,
      subscribe(callback) {
        listener = callback
        return () => { listener = () => undefined }
      },
      async sendCustomMessage() {},
      async prompt() {
        if (aborted) return
        if (params.text === TOOL_REQUEST) {
          const tool = tools.find(candidate => candidate.name === TOOL_NAME)
          if (!tool) throw new Error(`Injected tool ${TOOL_NAME} was not registered.`)
          const input = { value: 'fixed-input' }
          const refusal = await gate.check(TOOL_NAME, input)
          if (refusal) throw new Error(`Injected tool was blocked: ${refusal}`)
          const toolCallId = `${params.runId}:tool-1`
          emit({ type: 'tool_execution_start', toolCallId, toolName: TOOL_NAME, args: input })
          const result = await tool.execute(input)
          emit({ type: 'tool_execution_end', toolCallId, toolName: TOOL_NAME, isError: false, result })
        }
        emit({ type: 'message_start', message: { role: 'assistant' } })
        emit({ type: 'message_update', message: { role: 'assistant' }, assistantMessageEvent: { type: 'text_delta', delta: RESPONSE_TEXT } })
        emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: RESPONSE_TEXT }], stopReason: 'stop' } })
      },
      async abort() { aborted = true },
      dispose() {}
    }
  }
}

function makeRunInput({ id, sessionId, cwd, sessionDir, accountId, toolCase }) {
  return {
    run: { id, sessionId },
    accountId,
    cwd,
    sessionDir,
    text: toolCase ? TOOL_REQUEST : 'profile-session-runtime',
    caller: { agentId: `benchmark-${sessionId}`, actor: 'Benchmark' },
    tools: { allow: toolCase ? [TOOL_NAME] : [] },
    providers: true,
    harnessTools: false,
    connections: false,
    subagents: null
  }
}

async function runSample({ harness, dataRoot, accountId, sequence, toolCase, timeoutMs, deadline }) {
  const sessionId = `profile-session-${sequence}`
  const runId = `profile-run-${sequence}`
  const sessionDir = join(dataRoot, 'native-history', sessionId)
  const input = makeRunInput({ id: runId, sessionId, cwd: dataRoot, sessionDir, accountId, toolCase })
  const startedAt = performance.now()
  const waiter = makeOutcomeWaiter(harness, runId, startedAt)
  let runResult
  let runReturnedAt
  try {
    const runPromise = harness.sessions.run(input)
    runResult = await within(runPromise, remainingMs(deadline, timeoutMs), 'sessions.run')
    runReturnedAt = performance.now()
    const outcome = await within(waiter.outcome, remainingMs(deadline, timeoutMs), 'Run completion')
    if (outcome.type !== 'completed') {
      const reason = outcome.payload?.message ?? outcome.payload?.reason ?? outcome.payload?.status ?? outcome.type
      throw new Error(`Run ended as ${outcome.type}: ${String(reason)}`)
    }
    if (!runResult.nativeSessionId) throw new Error('sessions.run returned no native session id.')
    if (waiter.timings.firstDeltaMs === null) throw new Error('The injected session completed without a persisted message.delta event.')
    if (toolCase && (waiter.timings.toolStartedMs === null || waiter.timings.toolCompletedMs === null)) {
      throw new Error('The tool case did not persist both tool.started and tool.completed.')
    }
    const eventPath = join(dataRoot, 'runs', runId, 'events.jsonl')
    const eventText = readFileSync(eventPath, 'utf8')
    const persisted = eventText.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line))
    const persistedTypes = persisted.map(event => event.type)
    const requiredTypes = toolCase ? ['tool.started', 'tool.completed', 'message.delta', 'completed'] : ['message.delta', 'completed']
    const missing = requiredTypes.filter(type => !persistedTypes.includes(type))
    if (missing.length) throw new Error(`Run event log is missing persisted events: ${missing.join(', ')}.`)
    const metrics = {
      runReturnMs: roundMs(runReturnedAt - startedAt),
      invocationToFirstDeltaMs: waiter.timings.firstDeltaMs,
      invocationToCompletionMs: waiter.timings.outcomeMs,
      ...(toolCase ? {
        invocationToToolStartedMs: waiter.timings.toolStartedMs,
        invocationToToolCompletedMs: waiter.timings.toolCompletedMs
      } : {}),
      persistence: {
        verified: true,
        eventCount: persisted.length,
        eventLogBytes: Buffer.byteLength(eventText),
        eventTypes: persistedTypes
      }
    }
    return { ok: true, runId, metrics }
  } catch (error) {
    await harness.runs.interrupt(runId).catch(() => undefined)
    return { ok: false, runId, error: errorInfo(error) }
  } finally {
    waiter.unlisten()
  }
}

async function terminalPrepareSample({ harness, dataRoot, accountId, sequence, timeoutMs, deadline }) {
  const sessionId = `profile-terminal-${sequence}`
  const startedAt = performance.now()
  let preparation
  try {
    preparation = harness.terminals.prepare({
      sessionId,
      accountId,
      cwd: dataRoot,
      sessionFolder: join(dataRoot, 'terminal-sessions', sessionId),
      connections: false,
      subagents: null
    })
    await within(preparation, remainingMs(deadline, timeoutMs), 'terminal.prepare')
    return { ok: true, prepareMs: roundMs(performance.now() - startedAt) }
  } catch (error) {
    return { ok: false, error: errorInfo(error) }
  } finally {
    await harness.terminals.dispose(sessionId).catch(() => undefined)
    if (preparation) void preparation.then(() => harness.terminals.dispose(sessionId)).catch(() => undefined)
  }
}

async function collectSamples({ count, warmups, operation, timeoutMs, deadline, onError }) {
  const warmupErrors = []
  for (let index = 0; index < warmups; index += 1) {
    if (performance.now() >= deadline) break
    const sample = await operation(`warmup-${index + 1}`, timeoutMs, deadline)
    if (!sample.ok) {
      warmupErrors.push(sample.error)
      onError(`warmup-${index + 1}`, sample.error)
    }
  }
  const samples = []
  for (let index = 0; index < count; index += 1) {
    if (performance.now() >= deadline) break
    const sample = await operation(`sample-${index + 1}`, timeoutMs, deadline)
    samples.push({ index: index + 1, ...sample })
    if (!sample.ok) onError(`sample-${index + 1}`, sample.error)
  }
  return { warmupErrors, samples }
}

function phaseError(errors, phase, sample, error) {
  errors.push({ phase, sample, ...error })
}

function summarizePhase(samples, fields) {
  return Object.fromEntries(fields.map(field => [field, stats(samples, field)]))
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    console.error(`\n${usage()}`)
    process.exitCode = 2
    return
  }
  if (options.help) {
    console.log(usage())
    return
  }

  let reserved
  try {
    reserved = reserveOutput(options.output)
  } catch (error) {
    console.error(`Cannot reserve output without overwriting: ${error.message}`)
    process.exitCode = 2
    return
  }

  const benchmarkStartedAt = performance.now()
  const deadline = benchmarkStartedAt + MAX_BENCHMARK_DURATION_MS
  let scratchRoot = null
  let dataRoot
  let stateDir
  const results = {
    schemaVersion: 1,
    benchmark: 'harness-session-runtime-overhead',
    status: 'failed',
    metadata: {
      generatedAt: new Date().toISOString(),
      scriptVersion: SCRIPT_VERSION,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      iterations: options.iterations,
      warmups: options.warmups,
      operationTimeoutMs: options.timeoutMs,
      maxBenchmarkDurationMs: MAX_BENCHMARK_DURATION_MS,
      isolation: {
        dataAndStateRootsAreTemporary: true,
        homeIsRedirectedToTemporaryRoot: true,
        userPiCodexClaudeProfilesUsed: false,
        credentialsUsed: false,
        modelProvider: null,
        sessionImplementation: 'injected deterministic fake session'
      },
      outputPath: reserved.outputPath
    },
    measurements: {},
    limitations: [
      'Terminal timing covers Harness Terminals.prepare and its launch specification only; it does not spawn Bun/OpenTUI or measure interactive terminal process startup.',
      'Session timings include Harness preparation, event validation, synchronous run-event persistence, and the injected fake-session seam; they exclude model/provider latency and real Pi initialization.',
      'The tool case executes one deterministic local ToolSpec through the injected session, then verifies tool.started/tool.completed/message.delta/completed in the on-disk run event log.'
    ],
    errors: []
  }

  let harness = null
  try {
    scratchRoot = mkdtempSync(join(tmpdir(), 'xingular-session-runtime-data-'))
    dataRoot = join(scratchRoot, 'data')
    stateDir = join(scratchRoot, 'state')
    process.env.HOME = scratchRoot
    if (process.platform === 'win32') process.env.USERPROFILE = scratchRoot
    for (const name of Object.keys(process.env)) {
      const upper = name.toUpperCase()
      if (['PI_CODING_AGENT_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'].includes(upper)
        || ['_API_KEY', '_AUTH_TOKEN', '_OAUTH_TOKEN', '_ACCESS_TOKEN'].some(suffix => upper.endsWith(suffix))) delete process.env[name]
    }
    delete process.env.XINGULAR_HARNESS_BUN

    const importStartedAt = performance.now()
    const sdk = await within(import(new URL('../dist/sdk/index.js', import.meta.url).href), remainingMs(deadline, options.timeoutMs), 'SDK import')
    const sdkImportMs = roundMs(performance.now() - importStartedAt)
    const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
    results.metadata.harnessVersion = packageJson.version
    results.measurements.sdkModuleImport = { ok: true, elapsedMs: sdkImportMs, entrypoint: 'dist/sdk/index.js' }

    const harnessStartedAt = performance.now()
    harness = sdk.createHarness({
      dataRoot,
      stateDir,
      secrets: sdk.memorySecretStore(),
      browser: false,
      resolver: async () => [],
      sessionFactory: makeFakeSessionFactory(),
      assets: {
        node: process.execPath,
        cli: '/benchmark/not-launched/cli.js',
        piExtension: '/benchmark/not-launched/terminal-pi.js',
        openTui: '/benchmark/not-launched/terminal-opentui.js'
      }
    })
    await within(harness.ready, remainingMs(deadline, options.timeoutMs), 'Harness initialization')
    results.measurements.harnessInitialization = { ok: true, elapsedMs: roundMs(performance.now() - harnessStartedAt) }

    const account = harness.accounts.create('Temporary benchmark account', 'apiKey').accounts[0]
    harness.sessions.provide(() => [{
      name: TOOL_NAME,
      label: 'Runtime benchmark echo',
      description: 'A deterministic local tool used only by this benchmark.',
      parameters: type => type.Object({ value: type.String() }),
      execute: async input => `persisted:${String(input.value)}`
    }])

    const errors = results.errors
    const recordPhaseError = (phase) => (sample, error) => phaseError(errors, phase, sample, error)

    const coldTerminal = await terminalPrepareSample({ harness, dataRoot, accountId: account.id, sequence: 'cold', timeoutMs: options.timeoutMs, deadline })
    if (!coldTerminal.ok) recordPhaseError('terminalPrepareCold')('cold', coldTerminal.error)
    results.measurements.terminalPreparation = {
      cold: coldTerminal,
      description: 'First terminal.prepare call in this Harness process, including first socket-listener setup.',
      ...await collectSamples({
        count: options.iterations,
        warmups: options.warmups,
        timeoutMs: options.timeoutMs,
        deadline,
        operation: (label, timeoutMs, sharedDeadline) => terminalPrepareSample({ harness, dataRoot, accountId: account.id, sequence: `steady-${label}`, timeoutMs, deadline: sharedDeadline }),
        onError: recordPhaseError('terminalPrepare')
      })
    }
    results.measurements.terminalPreparation.summary = summarizePhase(results.measurements.terminalPreparation.samples, ['prepareMs'])

    let sequence = 0
    const runOperation = toolCase => async (label, timeoutMs, sharedDeadline) => runSample({
      harness,
      dataRoot,
      accountId: account.id,
      sequence: `${toolCase ? 'tool' : 'run'}-${label}-${++sequence}`,
      toolCase,
      timeoutMs,
      deadline: sharedDeadline
    })

    const sessions = await collectSamples({
      count: options.iterations,
      warmups: options.warmups,
      timeoutMs: options.timeoutMs,
      deadline,
      operation: runOperation(false),
      onError: recordPhaseError('sessionsRun')
    })
    results.measurements.sessionsRun = {
      description: 'sessions.run invocation through first persisted message.delta and terminal completed event.',
      ...sessions,
      summary: summarizePhase(sessions.samples, ['runReturnMs', 'invocationToFirstDeltaMs', 'invocationToCompletionMs'])
    }

    const toolCase = await collectSamples({
      count: options.iterations,
      warmups: options.warmups,
      timeoutMs: options.timeoutMs,
      deadline,
      operation: runOperation(true),
      onError: recordPhaseError('toolEventPersistence')
    })
    results.measurements.toolEventPersistence = {
      description: 'One synthetic tool execution and the validated, persisted tool/event stream.',
      ...toolCase,
      summary: summarizePhase(toolCase.samples, ['runReturnMs', 'invocationToFirstDeltaMs', 'invocationToToolStartedMs', 'invocationToToolCompletedMs', 'invocationToCompletionMs'])
    }
  } catch (error) {
    results.errors.push({ phase: 'benchmark', ...errorInfo(error) })
  } finally {
    if (harness) {
      try {
        await within(harness.close(), Math.max(1000, Math.min(options.timeoutMs, 10_000)), 'Harness shutdown')
      } catch (error) {
        results.errors.push({ phase: 'shutdown', ...errorInfo(error) })
      }
    }
    if (scratchRoot) {
      try {
        rmSync(scratchRoot, { recursive: true, force: true })
        results.metadata.temporaryRootsRemoved = true
      } catch (error) {
        results.metadata.temporaryRootsRemoved = false
        results.errors.push({ phase: 'temporaryCleanup', ...errorInfo(error) })
      }
    } else {
      results.metadata.temporaryRootsRemoved = true
    }
  }

  const sampleGroups = [
    results.measurements.terminalPreparation?.samples ?? [],
    results.measurements.sessionsRun?.samples ?? [],
    results.measurements.toolEventPersistence?.samples ?? []
  ]
  const hasSuccess = sampleGroups.some(samples => samples.some(sample => sample.ok))
  const hasFailure = results.errors.length > 0 || sampleGroups.some(samples => samples.some(sample => !sample.ok))
  results.status = hasFailure ? (hasSuccess ? 'partial' : 'failed') : 'ok'
  results.metadata.elapsedMs = roundMs(performance.now() - benchmarkStartedAt)

  try {
    writeReservedOutput(reserved.descriptor, results)
  } catch (error) {
    try { closeSync(reserved.descriptor) } catch {}
    console.error(`Could not write reserved output ${reserved.outputPath}: ${error.message}`)
    process.exitCode = 1
    return
  }

  const summary = {
    outputPath: reserved.outputPath,
    status: results.status,
    elapsedMs: results.metadata.elapsedMs,
    metrics: {
      terminalPrepareMedianMs: results.measurements.terminalPreparation?.summary?.prepareMs?.medianMs ?? null,
      sessionsRunToFirstDeltaMedianMs: results.measurements.sessionsRun?.summary?.invocationToFirstDeltaMs?.medianMs ?? null,
      sessionsRunToCompletionMedianMs: results.measurements.sessionsRun?.summary?.invocationToCompletionMs?.medianMs ?? null,
      toolEventPersistenceToCompletionMedianMs: results.measurements.toolEventPersistence?.summary?.invocationToCompletionMs?.medianMs ?? null
    },
    errors: results.errors.length
  }
  console.log(JSON.stringify(summary, null, 2))
  if (results.status !== 'ok') process.exitCode = 1
}

main().catch(error => {
  console.error(errorInfo(error))
  process.exitCode = 1
})
