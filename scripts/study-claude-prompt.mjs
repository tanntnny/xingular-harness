// Measures the two prompts compared in docs/study/STUDY-0007.
//
// Claude Code side: the leaked v2.1.88 source in external/claude-code-src. The section functions in
// src/constants/prompts.ts build their text from template literals; this reads the literals, then
// selects the ones an external (3P) build ships. The ant-only literals are excluded by index, so
// each row below says what it leaves out.
//
// This harness's side: the pack a real session recorded (runs/<id>/context.json), rendered the way
// src/prompt/compile.ts renders it.
//
// Usage: node scripts/study-claude-prompt.mjs [outDir]
// Output: <outDir>/claude-code-prompt.txt, <outDir>/measurements.json
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const out = process.argv[2] ?? 'artifacts/prompt-comparison'
const source = 'external/claude-code-src/src/constants/prompts.ts'
const dataRoot = process.env.HARNESS_DATA ?? join(process.env.HOME ?? '', '.xingular-harness-dev', 'data')

/** The top-level function blocks of a TypeScript file. */
function blocks(text) {
  const starts = []
  const re = /^(?:export )?(?:async )?function (\w+)/gm
  let match
  while ((match = re.exec(text))) starts.push({ name: match[1], index: match.index })
  return starts.map((entry, i) => ({
    name: entry.name,
    body: text.slice(entry.index, i + 1 < starts.length ? starts[i + 1].index : text.length)
  }))
}

/** Every backtick literal in a block, with `${...}` kept so the names can be resolved. */
function literals(text) {
  const found = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '`') continue
    let body = ''
    let j = i + 1
    for (; j < text.length; j++) {
      const c = text[j]
      if (c === '\\') {
        const unicode = /^u([0-9a-fA-F]{4})/.exec(text.slice(j + 1, j + 6))
        if (unicode) { body += String.fromCharCode(parseInt(unicode[1], 16)); j += 5; continue }
        const next = text[j + 1] ?? ''
        body += next === 'n' ? '\n' : next
        j++
        continue
      }
      if (c === '$' && text[j + 1] === '{') {
        let depth = 1
        let k = j + 2
        let expr = ''
        for (; k < text.length; k++) {
          const ch = text[k]
          if (ch === '{') depth++
          if (ch === '}') { depth--; if (depth === 0) break }
          expr += ch
        }
        body += '${' + expr + '}'
        j = k
        continue
      }
      if (c === '`') break
      body += c
    }
    found.push(body)
    i = j
  }
  return found
}

// Tool names the prompt interpolates, so the extracted text reads as the model sees it. Anything
// still unresolved is shown as ⟨expr⟩ rather than silently dropped.
const TOOL_NAMES = {
  BASH_TOOL_NAME: 'Bash',
  FILE_READ_TOOL_NAME: 'Read',
  FILE_EDIT_TOOL_NAME: 'Edit',
  FILE_WRITE_TOOL_NAME: 'Write',
  GLOB_TOOL_NAME: 'Glob',
  GREP_TOOL_NAME: 'Grep',
  TASK_CREATE_TOOL_NAME: 'TaskCreate',
  TODO_WRITE_TOOL_NAME: 'TodoWrite',
  AGENT_TOOL_NAME: 'Agent',
  SKILL_TOOL_NAME: 'Skill',
  ASK_USER_QUESTION_TOOL_NAME: 'AskUserQuestion',
  DISCOVER_SKILLS_TOOL_NAME: 'DiscoverSkills'
}

function named(text) {
  return text.replace(/\$\{([^}]*)\}/g, (whole, expr) => {
    const name = expr.trim()
    if (TOOL_NAMES[name]) return TOOL_NAMES[name]
    // A runtime value (cwd, model id, a session-conditional branch). Shown short so it does not
    // inflate a section's size; the wording around it is exact.
    return '⟨…⟩'
  })
}

const cyberRisk = /export const CYBER_RISK_INSTRUCTION = `([^`]*)`/.exec(
  readFileSync('external/claude-code-src/src/constants/cyberRiskInstruction.ts', 'utf8')
)?.[1]
if (cyberRisk) TOOL_NAMES.CYBER_RISK_INSTRUCTION = cyberRisk

const byName = new Map(blocks(readFileSync(source, 'utf8')).map((b) => [b.name, literals(b.body)]))

// The always-on text of an external (3P) build. Indices are literal positions inside the function.
const CLAUDE_EXTERNAL = [
  ['intro', 'getSimpleIntroSection', 'all'],
  ['system', 'getSimpleSystemSection', 'all'],
  // 3-6, 11, 18, 19 are ant-only: comment policy, assertiveness, false-claims, /issue routing.
  ['doing tasks', 'getSimpleDoingTasksSection', [0, 1, 2, 7, 8, 9, 10, 12, 13, 14, 15, 16, 17, 20, 21]],
  ['executing actions with care', 'getActionsSection', 'all'],
  // 0 and 1 belong to the REPL-mode branch, 12 is its heading.
  ['using your tools', 'getUsingYourToolsSection', [9, 3, 4, 5, 6, 7, 8, 10, 11, 12]],
  ['tone and style', 'getSimpleToneAndStyleSection', [0, 1, 2, 3, 4, 5]],
  // 0 is the ant-only "# Communicating with the user"; 1 is the external "# Output efficiency".
  ['output efficiency', 'getOutputEfficiencySection', [1]],
  // 7 is the ant-only verification-agent contract.
  ['session-specific guidance', 'getSessionSpecificGuidanceSection', [2, 3, 4, 5, 6]],
  // 0 is the fork-mode wording, behind isForkSubagentEnabled(); 1 is the ordinary branch.
  ['agent tool', 'getAgentToolSection', [1]],
  ['env info', 'computeSimpleEnvInfo', 'all']
]

const claude = CLAUDE_EXTERNAL.map(([name, fn, indices]) => {
  const found = byName.get(fn) ?? []
  const picked = indices === 'all' ? found : indices.map((i) => found[i] ?? '')
  const text = named(picked.join('\n'))
  return { name, chars: text.length, text }
})

/** The newest run that recorded a pack, and that pack. */
function newestPack(root) {
  const dir = join(root, 'runs')
  const runs = readdirSync(dir)
    .flatMap((id) => {
      try {
        return [{ id, at: statSync(join(dir, id, 'context.json')).mtimeMs }]
      } catch {
        return []
      }
    })
    .sort((left, right) => right.at - left.at)
  for (const run of runs) {
    const pack = JSON.parse(readFileSync(join(dir, run.id, 'context.json'), 'utf8'))
    if (pack.sections?.length) return { run: run.id, pack }
  }
  return null
}

const recorded = newestPack(dataRoot)
if (!recorded) throw new Error(`No recorded pack under ${dataRoot}/runs`)
const harness = recorded.pack.sections.map((s) => ({ name: s.title, id: s.id, chars: s.size, budget: s.budget, cut: s.cut }))
const framing = '# Xingular Agent context\n'.length + recorded.pack.sections.reduce((sum, s) => sum + (s.id === 'identity' ? 2 : `\n## ${s.title}\n\n`.length + 2), 0)
const harnessTotal = harness.reduce((sum, s) => sum + s.chars, 0) + framing

mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'claude-code-prompt.txt'), claude.map((s) => `########## ${s.name} (${s.chars} chars)\n\n${s.text.trim()}`).join('\n\n'))
writeFileSync(join(out, 'measurements.json'), JSON.stringify({
  measuredAt: new Date().toISOString(),
  claudeCode: { version: '2.1.88', build: 'external (3P)', sections: claude.map(({ name, chars }) => ({ name, chars })), total: claude.reduce((sum, s) => sum + s.chars, 0) },
  harness: { run: recorded.run, sections: harness, framing, renderedTotal: harnessTotal }
}, null, 2))

console.log('Claude Code 2.1.88, external build (always-on static text)')
for (const s of claude) console.log(`  ${s.name.padEnd(30)} ${String(s.chars).padStart(6)}`)
const claudeTotal = claude.reduce((sum, s) => sum + s.chars, 0)
console.log(`  ${'total'.padEnd(30)} ${String(claudeTotal).padStart(6)}  (~${Math.round(claudeTotal / 4)} tokens)`)
console.log(`\nThis harness, run ${recorded.run}`)
for (const s of harness) console.log(`  ${s.name.padEnd(30)} ${String(s.chars).padStart(6)}  budget ${s.budget}`)
console.log(`  ${'framing'.padEnd(30)} ${String(framing).padStart(6)}`)
console.log(`  ${'rendered total'.padEnd(30)} ${String(harnessTotal).padStart(6)}  (~${Math.round(harnessTotal / 4)} tokens)`)
console.log(`\nratio ${(harnessTotal / claudeTotal).toFixed(2)}x`)
