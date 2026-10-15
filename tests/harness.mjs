// Test harness for workflows/pipeline.js. It loads the script the way the Workflow runtime does (a
// literal `meta` export followed by an async body) and runs it against a simulated runtime in which
// every agent call is answered by a responder function instead of a model. Zero dependencies.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const PIPELINE_PATH = join(ROOT, 'workflows', 'pipeline.js')
const META_RE = /^export const meta = (\{[\s\S]*?\n\})\n/
const PARAMS = ['args', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'budget', 'workflow']
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

// The runtime reads `meta` without running the script, so it must be a plain literal: strings,
// numbers, booleans, null, arrays and objects with plain keys. No references, calls, spreads or
// template substitutions.
export function assertPureLiteral(src) {
  let out = ''
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      for (; j < src.length && src[j] !== c; j++) {
        if (src[j] === '\\') j++
        else if (c === '`' && src[j] === '$' && src[j + 1] === '{') throw new Error('meta contains a template substitution')
        else if (c !== '`' && src[j] === '\n') throw new Error('meta contains an unterminated string')
      }
      if (j >= src.length) throw new Error('meta contains an unterminated string')
      out += '""'
      i = j
    } else out += c
  }
  if (/\/[/*]/.test(out)) throw new Error('meta contains a comment')
  if (/[()=`]|\.\.\./.test(out)) throw new Error(`meta is not a plain literal: ${out.match(/[()=`]|\.\.\./)[0]}`)
  for (const m of out.matchAll(/(?<![\w$.])[A-Za-z_$][\w$]*/g)) {
    if (['true', 'false', 'null'].includes(m[0])) continue
    if (/^\s*:/.test(out.slice(m.index + m[0].length))) continue // a property key
    throw new Error(`meta refers to the identifier ${m[0]}, so it is not a literal`)
  }
  return true
}

let loaded = null
// Returns { meta, fn, source }: fn is the script body compiled as an async function of PARAMS.
export function loadPipeline() {
  if (loaded) return loaded
  const source = readFileSync(PIPELINE_PATH, 'utf8')
  const m = META_RE.exec(source)
  if (!m) throw new Error('workflows/pipeline.js must open with `export const meta = {` and close it with a `}` line')
  assertPureLiteral(m[1])
  const meta = Function('return ' + m[1])()
  const rest = source.slice(m[0].length)
  const stray = /^(?:import|export)\s.*$/m.exec(rest)
  if (stray) throw new Error(`only meta may be exported; found: ${stray[0].slice(0, 80)}`)
  // Pad with newlines so stack traces point at the real line numbers of pipeline.js (the function
  // wrapper adds two lines of its own).
  const pad = '\n'.repeat(Math.max(0, m[0].split('\n').length - 3))
  const fn = new AsyncFunction(...PARAMS, `${pad}${rest}\n//# sourceURL=workflows/pipeline.js`)
  loaded = { meta, fn, source }
  return loaded
}

// Runs the workflow once. responder(label, prompt, opts) answers each agent call (sync or async).
export async function runPipeline(args, responder = happy(), opts = {}) {
  const { fn } = loadPipeline()
  const calls = [], logs = [], phases = []
  const agent = async (prompt, o = {}) => {
    calls.push({ label: o.label, opts: o, prompt })
    return await responder(o.label, prompt, o)
  }
  const parallel = thunks => Promise.all(thunks.map(t => Promise.resolve().then(t).catch(() => null)))
  const phase = title => { phases.push(title) }
  const log = msg => { logs.push(String(msg)) }
  const budget = opts.budget || { total: null, spent: () => 0, remaining: () => Infinity }
  const unsupported = name => () => { throw new Error(`${name}() is not simulated by the test harness`) }
  const result = await fn(args, agent, parallel, unsupported('pipeline'), phase, log, budget, unsupported('workflow'))
  return { result, calls, logs, phases }
}

// ── Canned world: issue acme/widget#42, workspace /tmp/ws, main clone /tmp/ws/widget.
export const OWNER = 'acme', REPO = 'widget', ISSUE = '42', LOGIN = 'octo-dev'
export const ISSUE_URL = `https://github.com/${OWNER}/${REPO}/issues/${ISSUE}`
export const WORKSPACE = '/tmp/ws'
export const CLONE = `${WORKSPACE}/${REPO}`
export const WORKTREE = `${CLONE}-issue-${ISSUE}`
export const STATE_DIR = `${WORKTREE}/.resolve-issue`
export const BRANCH = `fix/issue-${ISSUE}`
export const sha = seed => createHash('sha1').update(`resolve-issue:${seed}`).digest('hex')
export const BASE_SHA = sha('base')
export const implSha = n => sha(`impl-${n}`)
export const POLISH_SHA = sha('polish')
export const runArgs = (extra = {}) => ({ issueUrl: ISSUE_URL, workspace: WORKSPACE, ...extra })

// Happy-path agent counts per mode (default attempts, every node answered on the first try).
// The README and the skill cite these numbers.
export const HAPPY_AGENT_COUNTS = Object.freeze({ triage: 2, quick: 10, standard: 14, thorough: 19 })

// 'R6:impl#2~retry' -> 'R6:impl'
export const baseLabel = label => String(label || '').replace(/~retry$/, '').replace(/#\d+$/, '')

const scope = () => ({
  filesTouched: ['src/widget/ranges.py', 'tests/test_ranges.py'], apisTouched: ['widget.ranges.parse_range'], siblingsCovered: [],
  recentCommits: 4, outOfScope: ['parse_list keeps its own bounds handling; it does not share this code path'], sharedMechanism: '',
})
const verifyOk = () => ({
  passing: true, build: true, tests: true, reproductionFixed: true, needsRescope: false, ignoredFailures: [], failures: [], errorLog: '',
  commands: ['python -m pytest tests/test_ranges.py -q: 14 passed', 'python -m pytest .resolve-issue/test_acceptance_42.py -q: 1 passed'],
})
const confirmOk = () => ({
  redOnBase: true, intreeRedOnBase: true, greenWithFix: true, testGuardsBug: true, testPinsSemantics: true, behaviorPreserved: true, reproShowsNewOutput: true,
  codeChanged: true, changeKindConfirmed: 'behavior', preExistingDefects: [], treeIntact: true, introducedDefects: [],
  reason: 'evidence/base-acceptance.txt: 1 failed (assert [1, 2] == [1, 2, 3]); evidence/head-acceptance.txt: 1 passed.',
})
const headFrom = (prompt, fallback) => (/[Ee]xpected head ([0-9a-f]{40})/.exec(prompt) || [])[1] || fallback

// The default answer for a node, shaped like its schema in pipeline.js. `n` counts earlier calls
// with the same base label (retries included).
export function canned(base, prompt = '', n = 0) {
  switch (base) {
    case 'U1:repo': return {
      clonePath: CLONE, isPrimaryClone: true, cloned: false, defaultBranch: 'main', baseRef: 'upstream/main', behindBy: 3, baseSha: BASE_SHA,
      login: LOGIN, canPush: false, noMistakes: { installed: false, gated: false, forkUrl: '' },
      testCmd: 'python -m pytest -q', lintCmd: 'ruff check', buildCmd: 'python -c "import widget"', minimalVerifyCmd: 'python -m pytest tests/test_ranges.py -q',
      interpreter: `${CLONE}/.venv/bin/python`, envNotes: 'Python 3.12 virtualenv in .venv; no editable installs outside the clone.', services: '',
      subsystemPath: 'src/widget', structureSummary: 'src layout; tests in tests/; CI runs pytest and ruff.',
    }
    case 'U2:issue': return {
      rootCause: 'parse_range builds range(start, end), so the end bound is exclusive.', symptom: 'parse_range("1-3") returns [1, 2] instead of [1, 2, 3].',
      maintainerIntent: 'Ranges are inclusive, as the docs say; a fix with a regression test is welcome.', status: 'OPEN', labels: ['bug'], linkedRefs: [],
      issueNumber: ISSUE, title: 'parse_range drops the last element', size: 'small', sizeWhy: 'One function and its test.', blocked: false, blockedReason: '',
    }
    case 'U3:prior-art': return {
      hasPriorArt: false, whatItDoes: '', whatItMisses: '', url: '', blocked: false, blockedReason: '',
      triage: { state: 'OPEN', stateReason: '', labels: ['bug'], archived: false, daysSinceLastCommit: 2, relatedPRs: [], claims: [],
        aiPolicy: 'none-found', aiPolicyEvidence: '', disclosureText: '', warnings: [] },
    }
    case 'GATE-0': return {
      summary: '- Add a regression test for every bug fix.\n- Run ruff on changed files.\n- Use conventional commit subjects.', styleNotes: 'Line width 100; double quotes.',
      testRequirements: 'pytest; tests live next to the module tests.', dcoRequired: false, claRequired: false, prTemplate: '', prRequirements: [],
      commitConvention: 'fix(<area>): <subject>', mergeStyle: 'squash', draftRequired: false, humanTestingRequired: false, memoryConflicts: [],
    }
    case 'W1:worktree': {
      const m = /worktree add --no-track -b (\S+) '([^']+)' ([0-9a-f]{40})/.exec(prompt) || []
      return { worktreePath: m[2] || WORKTREE, branch: m[1] || BRANCH, headSha: m[3] || BASE_SHA, created: true, resumed: false }
    }
    case 'W1:discard': return { removed: true, note: 'Removed the worktree and the branch: neither held any work.' }
    case 'R1:validate': return {
      valid: true, reproducible: true, stale: false, reproSteps: 'python .resolve-issue/repro.py prints [1, 2]; it should print [1, 2, 3].',
      reproPath: `${STATE_DIR}/repro.py`, acceptanceIntent: 'parse_range("1-3") == [1, 2, 3]', acceptancePath: `${STATE_DIR}/test_acceptance_42.py`,
      acceptanceCmd: 'python -m pytest .resolve-issue/test_acceptance_42.py -q', acceptanceTargetPath: '',
      acceptanceTest: 'def test_inclusive():\n    assert parse_range("1-3") == [1, 2, 3]', acceptanceRedOnBase: true, changeKindHint: 'behavior',
      env: { interpreter: `${CLONE}/.venv/bin/python`, runPrefix: `PYTHONPATH='${WORKTREE}/src'`, verifyCmd: 'python -m pytest tests/test_ranges.py -q', installed: [] },
      draftComment: '', reason: 'Reproduced at the base: the last element is missing.',
    }
    case 'R2:plan': return {
      approach: 'Make the end bound inclusive in parse_range.', rootCauseFix: 'range(start, end + 1)', keyFiles: ['src/widget/ranges.py'],
      steps: ['Change range(start, end) to range(start, end + 1) in parse_range.', 'Add a regression test to tests/test_ranges.py.'],
      decisionsTaken: [{ question: 'Also change parse_list?', choice: 'No', why: 'It does not share this code path.' }],
    }
    case 'R2:plan+scope': return { ...canned('R2:plan'), scope: scope(), divergesFromLiteralAsk: false, decision: { question: '', options: [], recommendation: '' }, reason: '' }
    case 'R3:scope': return scope()
    case 'R4:feasibility': return 'Spiked the change in .resolve-issue/spike: tests/test_ranges.py passes at the base and with the change; no caller relies on the exclusive bound.'
    case 'R5:rescope': return { feasible: true, scopeWidened: false, divergesFromLiteralAsk: false, decision: { question: '', options: [], recommendation: '' }, finalScope: scope(), reason: 'The spike confirmed the scope.' }
    case 'R5:rescope-impl': return {
      feasible: true, scopeWidened: true, divergesFromLiteralAsk: false, decision: { question: '', options: [], recommendation: '' },
      finalScope: { ...scope(), filesTouched: ['src/widget/bounds.py', 'tests/test_ranges.py'] }, reason: 'Fix the shared bounds helper instead of parse_range.',
    }
    case 'R6:impl': return {
      headSha: implSha(n), filesChanged: ['src/widget/ranges.py', 'tests/test_ranges.py', 'CHANGELOG.md'],
      summary: 'parse_range now includes its end bound; a regression test pins [1, 2, 3].', referenceRead: 'src/widget/ranges.py parse_list, read in full: it already treats bounds as inclusive.',
      divergencesFromReference: [], changeKind: 'behavior', adjacentDefects: [],
      prIntent: 'parse_range("1-3") dropped the last element. The end bound is now inclusive, as the docs describe.',
      deferred: [{ what: 'parse_list', why: 'it already handles bounds correctly' }],
    }
    case 'R6:verify': return verifyOk()
    case 'R6.5:confirm': case 'R6.5:confirm-polish': return confirmOk()
    case 'R6:check': return { ...verifyOk(), ...confirmOk(), part2Ran: true }
    case 'P1:polish-review': return {
      items: [{ file: 'tests/test_ranges.py', line: '41', kind: 'convention', what: 'The test name does not follow test_<function>_<case>.', fix: 'Rename it to test_parse_range_inclusive_end.' }],
      prNotes: 'Show parse_range("1-3") before and after the fix.',
    }
    case 'P2:polish-apply': return { merged: true, finalHead: POLISH_SHA, appliedItems: ['Renamed the test.'], skippedItems: [], checks: 'Acceptance test and tests/test_ranges.py pass.' }
    case 'FINAL:check': return {
      ran: true, headSha: headFrom(prompt, implSha(0)),
      tests: { commands: ['python -m pytest tests/test_ranges.py -q'], passed: true, newFailures: [], preExisting: [], notRun: [] },
      lint: { command: 'ruff check src/widget/ranges.py tests/test_ranges.py', issues: [] },
      findings: [{ id: 'F1', severity: 'nit', file: 'src/widget/ranges.py', line: '17', description: 'The docstring example could show an inclusive range.', recommendation: 'note', why: 'Informational only.' }],
      prTitle: 'fix(ranges): include the end bound in parse_range', diffstat: ' 3 files changed, 11 insertions(+), 2 deletions(-)',
      summary: 'Affected tests pass; lint is clean on the changed lines.',
    }
    case 'REVIEW:correctness': case 'REVIEW:conventions': return { findings: [] }
    case 'R7:no-mistakes': {
      const head = headFrom(prompt, implSha(0))
      const steps = ['intent', 'rebase', 'review', 'test', 'document', 'lint'].map(name => ({ name, status: 'completed' }))
      return {
        handedOff: true, outcome: 'parked_at_gate', runId: 'run_0042', steps: [...steps, ...['push', 'pr', 'ci'].map(name => ({ name, status: 'skipped' }))],
        findings: [], gateCommits: '', diffstat: ' 3 files changed, 11 insertions(+), 2 deletions(-)', prTitle: 'fix(ranges): include the end bound in parse_range',
        setupCommands: [], summary: 'Review, test and lint passed; push, pr and ci were skipped.', evidenceDir: '', screenshots: [],
        headSha: head, runHeadSha: head, gatePath: '/tmp/nm/repos/widget.git', branchSync: { code: 'recover_custody', command: 'no-mistakes axi sync --recover' },
      }
    }
    default: throw new Error(`happy(): no canned answer for node ${base}`)
  }
}

// A responder that answers every node with canned(). Overrides are keyed by base label; each is a
// value or a function (label, prompt, opts, callIndex, defaultValue) => value. A function that
// returns undefined falls back to the default; null means "no result", as from a failed agent.
export function happy(overrides = {}) {
  const seen = Object.create(null)
  return async (label, prompt, opts) => {
    const base = baseLabel(label)
    const n = seen[base] = base in seen ? seen[base] + 1 : 0
    if (!(base in overrides)) return canned(base, prompt, n)
    const o = overrides[base]
    if (typeof o !== 'function') return o
    const def = (() => { try { return canned(base, prompt, n) } catch { return undefined } })()
    const v = await o(label, prompt, opts, n, def)
    return v === undefined ? def : v
  }
}

// A responder that replays results the way a resumed run does: a call with the same label and prompt as
// an earlier one that returned a result gets that result again; any other call asks `world`.
export function journaled(world) {
  const journal = new Map()
  return async (label, prompt, opts) => {
    const k = `${label}\u0000${prompt}`
    if (journal.has(k)) return journal.get(k)
    const v = await world(label, prompt, opts)
    if (v != null) journal.set(k, v)
    return v
  }
}
// recorded(world) answers with world and keeps each call's label, prompt, opts and result in log, in call order.
export function recorded(world) {
  const log = []
  const respond = async (label, prompt, opts) => { const entry = { label, prompt, opts: JSON.stringify(opts) }; log.push(entry); entry.result = await world(label, prompt, opts); return entry.result }
  return { respond, log }
}
// prefixReplay(log, world) resumes a recorded run the way the workflow runtime does: calls that match the log in order
// (same label, prompt and opts) replay its results until the first call that differs; that call and every later one
// ask world, and their labels go to live.
export function prefixReplay(log, world) {
  const live = []
  let i = 0
  const respond = async (label, prompt, opts) => {
    const e = log[i]
    if (!live.length && e && e.label === label && e.prompt === prompt && e.opts === JSON.stringify(opts)) { i++; return e.result }
    live.push(label)
    return world(label, prompt, opts)
  }
  return { respond, live }
}
// The map a resume text names, e.g. args.retryNodes={"R4:feasibility#0":1} -> { 'R4:feasibility#0': 1 }.
export const resumeArg = (result, name) => { const m = new RegExp(`args\\.${name}=(\\{[^}]*\\})`).exec((result && result.resume) || ''); return m ? JSON.parse(m[1]) : undefined }

// ── Shorthands for the scenario tests.
export const run = (extra = {}, overrides = {}) => runPipeline(runArgs(extra), happy(overrides))
export const labels = calls => calls.map(c => c.label)
export const count = (calls, base) => calls.filter(c => baseLabel(c.label) === base).length
export const find = (calls, label) => calls.find(c => c.label === label)
// Merge a patch into a node's default answer. p is an object, or a function (callIndex, default) that
// returns a patch, undefined (keep the default) or null (no result).
export const patch = (base, p) => ({
  [base]: (l, pr, o, n, def) => { const v = typeof p === 'function' ? p(n, def) : p; return v == null ? (v === null ? null : def) : { ...def, ...v } },
})
export const withTriage = t => ({ 'U3:prior-art': (l, p, o, n, def) => ({ ...def, triage: { ...def.triage, ...t } }) })
export const withRepo = r => patch('U1:repo', r)
export const GATED = withRepo({ noMistakes: { installed: true, gated: true, forkUrl: '' } })
