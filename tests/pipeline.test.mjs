// Scenario tests for workflows/pipeline.js: every stop, the loops, the scope gate, the confirmation
// rules, polish and reviewers and the approval packet, driven by canned agent answers (see harness.mjs).
// What each argument changes and the final-check gate are in args.test.mjs; prompt hygiene in prompts.test.mjs.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  loadPipeline, assertPureLiteral, canned, baseLabel, run, labels, count, find, patch, withTriage, withRepo, GATED, HAPPY_AGENT_COUNTS,
  CLONE, WORKTREE, STATE_DIR, BRANCH, BASE_SHA, POLISH_SHA, implSha, LOGIN,
} from './harness.mjs'

const PR = (extra = {}) => ({ url: 'https://github.com/acme/widget/pull/50', author: 'someone', state: 'OPEN', isDraft: false, isMine: false, targetsIssue: true, updatedDaysAgo: 5, ...extra })
const CLAIM = (extra = {}) => ({ who: 'someone', daysAgo: 3, url: 'https://github.com/acme/widget/issues/42#issuecomment-1', hasOpenPrOrBranch: false, maintainerAcknowledged: false, ...extra })
const WIP = (extra = {}) => ({ who: 'someone', url: 'https://github.com/someone/widget/tree/fix-42', kind: 'branch', daysAgo: 10, isMaintainer: false, ...extra })
const FAIL = { passing: false, tests: false, reproductionFixed: false, failures: ['tests/test_ranges.py::test_bounds: assert [1, 2] == [1, 2, 3]'] }
const once = p => n => (n === 0 ? p : undefined) // patch only the first call of a node

describe('script shape', () => {
  test('meta is a plain literal the runtime can read without running the script', () => {
    const { meta } = loadPipeline()
    assert.equal(meta.name, 'pipeline')
    assert.ok(meta.description.length > 40 && meta.whenToUse.includes('/resolve-issue'))
    assert.ok(meta.phases.length >= 6 && meta.phases.every(p => typeof p.title === 'string' && typeof p.detail === 'string'))
  })
  test('the literal check rejects references, calls, spreads and substitutions', () => {
    assert.ok(assertPureLiteral("{ a: 'x', b: [1, true, null], c: { 'd-e': \"it's\" } }"))
    for (const src of ['{ a: b }', '{ a: f() }', '{ a: `${x}` }', '{ ...x }', '{ a: 1 + b }', '{ a: x => 1 }']) assert.throws(() => assertPureLiteral(src), src)
  })
  test('every phase the script enters or tags is declared in meta.phases', async () => {
    const titles = new Set(loadPipeline().meta.phases.map(p => p.title))
    for (const mode of Object.keys(HAPPY_AGENT_COUNTS)) {
      const { calls, phases } = await run({ mode })
      for (const p of phases) assert.ok(titles.has(p), `phase('${p}') is not in meta.phases`)
      for (const c of calls) assert.ok(titles.has(c.opts.phase), `${c.label} is tagged with undeclared phase ${c.opts.phase}`)
    }
  })
  test('every stop code and status the script can return is documented in results.md', () => {
    const { source } = loadPipeline()
    const doc = readFileSync(new URL('../skills/resolve-issue/results.md', import.meta.url), 'utf8')
    const codes = new Set([...source.matchAll(/stopped: '([a-z-]+)'/g), ...source.matchAll(/stop\('([a-z-]+)'/g)].map(m => m[1]))
    assert.ok(codes.size >= 20)
    for (const code of codes) assert.ok(doc.includes(`\`${code}\``), `results.md does not document ${code}`)
    for (const status of ['triaged', 'awaiting-approval', 'awaiting-scope-decision', 'went-remote-without-approval']) assert.ok(source.includes(`'${status}'`) && doc.includes(status), status)
  })
})

describe('viability stops', () => {
  const cases = [
    ['an archived repo', { archived: true }, 'repo-archived', false],
    ['a repo that rejects AI-assisted work', { aiPolicy: 'reject-agentic', aiPolicyEvidence: 'We do not accept AI-generated pull requests.' }, 'repo-rejects-ai-contributions', false],
    ['your own open PR', { relatedPRs: [PR({ author: LOGIN, isMine: true, state: 'open' })] }, 'already-have-pr', false],
    ['a closed issue', { state: 'CLOSED', stateReason: 'COMPLETED' }, 'issue-closed', true],
    ['a wontfix label', { labels: ['bug', 'wontfix'] }, 'not-viable-label', true],
    ["a won't fix label", { labels: ["won't fix"] }, 'not-viable-label', true],
    ['an invalid label', { labels: ['invalid'] }, 'not-viable-label', true],
    ['a duplicate label', { labels: ['Duplicate'] }, 'not-viable-label', true],
    ['a competing PR updated 5 days ago', { relatedPRs: [PR()] }, 'competing-pr', true],
    ['a competing PR updated 30 days ago', { relatedPRs: [PR({ updatedDaysAgo: 30 })] }, 'competing-pr', true],
    ['a claim backed by a PR or branch', { claims: [CLAIM({ hasOpenPrOrBranch: true })] }, 'claimed', true],
    ['a claim a maintainer acknowledged 14 days ago', { claims: [CLAIM({ daysAgo: 14, maintainerAcknowledged: true })] }, 'claimed', true],
    ['a bare claim 7 days old', { claims: [CLAIM({ daysAgo: 7 })] }, 'claimed', true],
    ['a fix branch touched 10 days ago', { workInProgress: [WIP()] }, 'work-in-progress', true],
    ["a maintainer's fix commit 60 days old", { workInProgress: [WIP({ kind: 'commit', daysAgo: 60, isMaintainer: true })] }, 'work-in-progress', true],
  ]
  for (const [what, t, code, soft] of cases) {
    test(`${what} stops with ${code} before the worktree; force ${soft ? 'overrides' : 'does not override'} it`, async () => {
      const { result, calls } = await run({}, withTriage(t))
      assert.equal(result.stopped, code)
      assert.equal(result.reasons[0].overridable, soft)
      assert.deepEqual(labels(calls), ['U1:repo', 'U2:issue', 'U3:prior-art'])
      assert.match(result.resume, soft ? /force=true/ : /Not overridable/)
      const forced = (await run({ force: true }, withTriage(t))).result
      if (!soft) return assert.equal(forced.stopped, code)
      assert.equal(forced.status, 'awaiting-approval')
      assert.ok(forced.warnings.some(w => w.startsWith(`Overridden with force: ${code}`)))
    })
  }
  test('a hard stop is reported first: a closed issue plus your own open PR stops as already-have-pr', async () => {
    const both = withTriage({ state: 'CLOSED', relatedPRs: [PR({ author: LOGIN, isMine: true })] })
    for (const force of [false, true]) assert.deepEqual(((r) => [r.stopped, r.reasons[0].code, r.resume])((await run({ force }, both)).result), ['already-have-pr', 'already-have-pr', 'Not overridable.'])
    const triage = (await run({ mode: 'triage' }, both)).result
    assert.deepEqual([triage.blockers.map(b => b.code), triage.next], [['already-have-pr', 'issue-closed'], 'Not takeable: a hard stop applies.'])
  })
  test('an unknown claim or work age counts as fresh and says so; a PR with no updatedDaysAgo still stops', async () => {
    for (const daysAgo of [undefined, null, '', 'recently', NaN]) {
      for (const [t, code] of [[{ claims: [CLAIM({ daysAgo, maintainerAcknowledged: true })] }, 'claimed'], [{ claims: [CLAIM({ daysAgo })] }, 'claimed'], [{ workInProgress: [WIP({ daysAgo })] }, 'work-in-progress']]) {
        const { why } = (await run({}, withTriage(t))).result.reasons[0]
        assert.match(why, /an unknown number of days ago/, `${code} ${String(daysAgo)}`)
        assert.doesNotMatch(why, /undefined|null|NaN/)
      }
    }
    assert.equal((await run({}, withTriage({ relatedPRs: [PR({ updatedDaysAgo: undefined })] }))).result.stopped, 'competing-pr')
  })
  test('stale PRs, old or unbacked claims, old work and an idle repo only warn', async () => {
    const { result } = await run({}, withTriage({
      relatedPRs: [PR({ updatedDaysAgo: 31 }), PR({ url: 'https://github.com/acme/widget/pull/51', targetsIssue: false }), PR({ url: 'https://github.com/acme/widget/pull/52', state: 'MERGED' })],
      claims: [CLAIM({ daysAgo: 8 }), CLAIM({ who: 'old', daysAgo: 15, hasOpenPrOrBranch: true })], workInProgress: [WIP({ daysAgo: 61 })],
      daysSinceLastCommit: 400, warnings: ['Agent PRs must be opened as drafts.'],
    }))
    assert.equal(result.status, 'awaiting-approval')
    const w = result.warnings.join('\n')
    for (const re of [/Stale competing PR \(31 days idle\): https:\/\/github\.com\/acme\/widget\/pull\/50/, /Claim by someone 8 days ago without/, /Claim by old 15 days ago/,
      /Older unmerged work on this issue \(branch, 61 days idle\)/, /no default-branch commit in 400 days/, /Agent PRs must be opened as drafts/]) assert.match(w, re)
    assert.doesNotMatch(w, /pull\/51|pull\/52/)
  })
  test('a disclosure policy warns and puts the disclosure in the PR text', async () => {
    const { result, calls } = await run({}, withTriage({ aiPolicy: 'disclosure-required', disclosureText: 'State which AI tool you used.' }))
    assert.ok(result.warnings.includes('AI disclosure required: State which AI tool you used.'))
    const final = find(calls, 'FINAL:check').prompt
    assert.ok(final.includes('State which AI tool you used.') && final.includes('AI disclosure: prepared with Claude Code'))
    assert.match(final, /The PR description carries the AI-assistance disclosure/)
    assert.doesNotMatch(find((await run()).calls, 'FINAL:check').prompt, /AI disclosure/)
  })
  test('a ban on autonomous submissions warns and requires the disclosure', async () => {
    const { result, calls } = await run({}, withTriage({ aiPolicy: 'no-autonomous', aiPolicyEvidence: 'Autonomous agents may not open PRs.' }))
    assert.ok(result.warnings.some(w => /bans autonomous agent submissions.*Autonomous agents may not open PRs\./.test(w)))
    assert.match(find(calls, 'FINAL:check').prompt, /AI disclosure: prepared with Claude Code/)
  })
})

describe('recon failures', () => {
  for (const [what, o, reason] of [
    ['U2 cannot read the issue', patch('U2:issue', { blocked: true, blockedReason: 'HTTP 404' }), /U2 could not read the issue: HTTP 404/],
    ['U3 cannot look', patch('U3:prior-art', { blocked: true, blockedReason: 'rate limited' }), /U3 could not review prior art: rate limited/],
    ['U2 reports another issue number', patch('U2:issue', { issueNumber: '41' }), /Cross-check failed: U2 reported issue "41"/],
    ['U1 returns a relative clone path', withRepo({ clonePath: 'ws/widget' }), /U1 did not establish/],
    ['U1 returns a clone path with a quote', withRepo({ clonePath: "/tmp/ws/wid'get" }), /U1 did not establish/],
    ['U1 returns a worktree, not the main clone', withRepo({ isPrimaryClone: false }), /U1 did not establish/],
    ['U1 omits isPrimaryClone', withRepo({ isPrimaryClone: undefined }), /U1 did not establish/],
    ['U1 returns a short SHA', withRepo({ baseSha: 'abc1234' }), /U1 did not establish/],
  ]) {
    test(`${what}: recon-failed, no worktree`, async () => {
      const { result, calls } = await run({}, o)
      assert.equal(result.stopped, 'recon-failed')
      assert.match(result.reason, reason)
      assert.ok(!calls.some(c => c.label === 'W1:worktree'))
    })
  }
  test('an issue number given as "#42" or 42 passes the cross-check; a trailing slash on the clone path is dropped', async () => {
    for (const issueNumber of ['#42', 42]) assert.equal((await run({}, patch('U2:issue', { issueNumber }))).result.status, 'awaiting-approval')
    assert.ok(find((await run({}, withRepo({ clonePath: `${CLONE}/` }))).calls, 'W1:worktree').prompt.includes(`'${WORKTREE}'`))
  })
})

describe('agent failures', () => {
  for (const [extra, base, node] of [
    [{}, 'U1:repo', 'U1:repo'], [{}, 'U2:issue', 'U2:issue'], [{}, 'U3:prior-art', 'U3:prior-art'], [{}, 'GATE-0', 'GATE-0'], [{}, 'W1:worktree', 'W1:worktree'],
    [{}, 'R1:validate', 'R1:validate'], [{}, 'R2:plan', 'R2:plan'], [{}, 'R3:scope', 'R3:scope'], [{}, 'R4:feasibility', 'R4:feasibility#0'], [{}, 'R5:rescope', 'R5:rescope#0'],
    [{}, 'R6:impl', 'R6:impl#0'], [{}, 'R6:verify', 'R6:verify#0'], [{}, 'R6.5:confirm', 'R6.5:confirm#0'], [{}, 'FINAL:check', 'FINAL:check'],
    [{ mode: 'quick' }, 'R2:plan+scope', 'R2:plan+scope'], [{ mode: 'quick' }, 'R6:check', 'R6:check#0'], [{ gate: 'no-mistakes' }, 'R7:no-mistakes', 'R7:no-mistakes'],
  ]) {
    test(`${base} returning nothing twice stops with agent-failed naming ${node}`, async () => {
      const { result, calls } = await run(extra, { ...(extra.gate ? GATED : {}), [base]: null })
      assert.deepEqual([result.stopped, result.node], ['agent-failed', node])
      assert.match(result.reason, /returned no result twice/)
      assert.ok(result.resume.includes(`args.retryNodes=${JSON.stringify({ [node]: 1 })}`), 'the resume names the step to retry')
      const own = labels(calls).filter(l => baseLabel(l) === base)
      assert.deepEqual(own, [own[0], `${own[0]}~retry`])
    })
  }
  test('an empty reply counts as no result', async () => assert.equal((await run({}, { 'R4:feasibility': '' })).result.node, 'R4:feasibility#0'))
  test('a single failure is retried once with a ~retry label', async () => {
    const { result, calls, logs } = await run({}, { 'R1:validate': (l, p, o, n) => (n === 0 ? null : undefined) })
    assert.equal(result.status, 'awaiting-approval')
    assert.deepEqual(labels(calls).filter(l => l.startsWith('R1')), ['R1:validate', 'R1:validate~retry'])
    assert.ok(logs.some(l => /^R1:validate: no result .* retrying once$/.test(l)))
    assert.equal(result.run.agentsUsed, HAPPY_AGENT_COUNTS.standard + 1)
  })
  test('an optional step that returns nothing (or was skipped) is not retried', async () => {
    for (const node of ['P1:polish-review', 'P2:polish-apply', 'REVIEW:correctness', 'REVIEW:conventions']) {
      const { result, calls, logs } = await run({ mode: 'thorough' }, { [node]: null })
      assert.deepEqual([result.status, labels(calls).filter(l => baseLabel(l) === node)], ['awaiting-approval', [node]], node)
      assert.ok(logs.includes(`${node}: no result (API error or skipped)`), node)
    }
  })
  test('an agent error other than the cap is logged and retried', async () => {
    const { result, logs } = await run({}, { 'R3:scope': (l, p, o, n) => { if (n === 0) throw new Error('stream reset') } })
    assert.equal(result.status, 'awaiting-approval')
    assert.ok(logs.includes('R3:scope: stream reset'))
  })
})

describe('worktree and validation', () => {
  test('W1 branches from the freshly fetched base SHA and never destroys work', async () => {
    const p = find((await run()).calls, 'W1:worktree').prompt
    assert.ok(p.includes(`worktree add --no-track -b ${BRANCH} '${WORKTREE}' ${BASE_SHA}`))
    assert.match(p, /Never detach, reset, force, stash, rename or delete anything/)
  })
  test('a branch outside resolve-issue stops with prior-branch-exists', async () => {
    const { result, calls } = await run({}, { 'W1:worktree': { worktreePath: '', branch: '', priorBranch: BRANCH, priorBranchLog: 'a1b2c3d wip', priorPrUrl: 'https://github.com/acme/widget/pull/7' } })
    assert.equal(result.stopped, 'prior-branch-exists')
    assert.match(result.reason, /pull\/7/)
    assert.equal(result.priorBranchLog, 'a1b2c3d wip')
    assert.ok(!calls.some(c => c.label === 'R1:validate'))
  })
  for (const [what, w] of [['another branch', { branch: 'main' }], ['another path', { worktreePath: '/tmp/ws/elsewhere' }], ['no path and no prior branch', { worktreePath: '' }]]) {
    test(`W1 returning ${what} stops with worktree-failed`, async () => {
      const { result } = await run({}, patch('W1:worktree', w))
      assert.equal(result.stopped, 'worktree-failed')
      assert.match(result.resume, /Not resumable/)
    })
  }
  test('a refs/heads/ prefix and a trailing slash from W1 are accepted', async () => {
    const { result } = await run({}, patch('W1:worktree', { branch: `refs/heads/${BRANCH}`, worktreePath: `${WORKTREE}/` }))
    assert.deepEqual([result.status, result.worktreePath], ['awaiting-approval', WORKTREE])
  })
  test('an invalid or stale issue stops with invalid-issue, passes the draft comment through and removes the new worktree', async () => {
    const { result, calls } = await run({}, patch('R1:validate', { valid: false, reason: 'Works as documented.', draftComment: 'This is the documented behavior.' }))
    assert.equal(result.stopped, 'invalid-issue')
    assert.equal(result.draftComment, 'This is the documented behavior.')
    assert.equal(count(calls, 'W1:discard'), 1)
    assert.match(result.cleanup, /^removed the worktree /)
    assert.deepEqual([result.worktreePath, result.branch], [null, null], 'a removed worktree is not reported as live')
    assert.ok(!calls.some(c => c.label.startsWith('R2')))
    const d = find(calls, 'W1:discard').prompt
    assert.ok(d.includes('status --porcelain prints nothing') && d.includes(`${BASE_SHA}..${BRANCH}`))
    assert.equal((await run({}, patch('R1:validate', { stale: true }))).result.stopped, 'invalid-issue', 'a stale issue stops the same way')
  })
  test('a worktree this run did not create is kept, and R1 reproduces in a scratch checkout', async () => {
    const { result, calls } = await run({}, { ...patch('W1:worktree', { created: false, resumed: true }), ...patch('R1:validate', { valid: false }) })
    assert.equal(count(calls, 'W1:discard'), 0)
    assert.equal(result.cleanup, 'kept: not created by this run')
    assert.match(find(calls, 'R1:validate').prompt, /worktree add --detach '.*\/\.resolve-issue\/base'/)
  })
  test('a failed discard is reported, not fatal', async () => {
    const { result } = await run({}, { ...patch('R1:validate', { valid: false }), 'W1:discard': null })
    assert.equal(result.stopped, 'invalid-issue')
    assert.match(result.cleanup, /not removed/)
  })
})

describe('scope gate', () => {
  const DIVERGE = { divergesFromLiteralAsk: true, reason: 'The responsible fix changes a public signature.',
    decision: { question: 'Change parse_range to return a tuple?', options: ['Keep the list', 'Return a tuple'], recommendation: 'Keep the list' } }
  const r5 = extra => patch('R5:rescope', once({ ...DIVERGE, ...extra }))
  const key = async () => (await run({}, r5())).result.gateKey
  test('a divergent re-scope halts with a keyed question and no implementation', async () => {
    const { result, calls } = await run({}, r5())
    assert.deepEqual([result.status, result.node, result.question, result.why], ['awaiting-scope-decision', 'R5#0', DIVERGE.decision.question, DIVERGE.reason])
    assert.match(result.gateKey, /^R5#0:[0-9a-f]+$/)
    assert.deepEqual([result.options, result.alternatives], [['proceed', 'abort'], DIVERGE.decision.options])
    assert.ok(result.resume.includes(result.gateKey))
    assert.ok(!calls.some(c => c.label.startsWith('R6')))
  })
  test('proceed with the matching key continues to approval and records the approved scope', async () => {
    const gateKey = await key()
    const { result } = await run({ scopeDecision: { key: gateKey, answer: 'proceed' } }, r5())
    assert.equal(result.status, 'awaiting-approval')
    assert.deepEqual(result.approvedScopes, [{ node: 'R5#0', key: gateKey, question: DIVERGE.decision.question, filesTouched: canned('R3:scope').filesTouched }])
    assert.equal((await run({ scopeDecision: 'Proceed' }, r5())).result.status, 'awaiting-approval', 'a bare answer applies to the first gate')
  })
  test('abort stops with user-declined-wider-scope', async () => {
    const { result } = await run({ scopeDecision: { key: await key(), answer: 'abort' } }, r5())
    assert.deepEqual([result.stopped, result.node], ['user-declined-wider-scope', 'R5#0'])
  })
  test('a decision for another key or another proposal does not apply', async () => {
    const gateKey = await key()
    const other = (await run({ scopeDecision: { key: 'R5#0:deadbeef', answer: 'proceed' } }, r5())).result
    assert.deepEqual([other.status, other.gateKey], ['awaiting-scope-decision', gateKey])
    const changed = (await run({ scopeDecision: { key: gateKey, answer: 'proceed' } }, r5({ finalScope: { filesTouched: ['src/widget/api.py'], outOfScope: [] } }))).result
    assert.equal(changed.status, 'awaiting-scope-decision')
    assert.notEqual(changed.gateKey, gateKey)
  })
  test('quick mode halts from the combined R2:plan+scope node', async () => {
    const o = patch('R2:plan+scope', DIVERGE)
    const { result, calls } = await run({ mode: 'quick' }, o)
    assert.deepEqual([result.status, result.node, calls.at(-1).label], ['awaiting-scope-decision', 'R2', 'R2:plan+scope'])
    assert.match(result.gateKey, /^R2:/)
    const next = (await run({ mode: 'quick', scopeDecision: { key: result.gateKey, answer: 'proceed' } }, o)).result
    assert.deepEqual([next.status, next.approvedScopes[0].node], ['awaiting-approval', 'R2'])
  })
  test('a divergent re-scope after a failed implementation halts too', async () => {
    const o = { ...patch('R6:verify', once({ ...FAIL, needsRescope: true })), ...patch('R5:rescope-impl', DIVERGE) }
    const { result } = await run({}, o)
    assert.deepEqual([result.status, result.node], ['awaiting-scope-decision', 'R6→R5#0'])
    assert.equal((await run({ scopeDecision: { key: result.gateKey, answer: 'proceed' } }, o)).result.status, 'awaiting-approval')
  })
  test('two divergent gates in one run can both be approved by resuming with every answer', async () => {
    const o = patch('R5:rescope', n => (n === 0 ? { ...DIVERGE, scopeWidened: true } : n === 1 ? { ...DIVERGE, decision: { ...DIVERGE.decision, question: 'Also widen the parser?' } } : undefined))
    const first = (await run({}, o)).result
    const second = (await run({ scopeDecision: { key: first.gateKey, answer: 'proceed' } }, o)).result
    assert.equal(second.node, 'R5#1')
    assert.deepEqual(second.earlierDecisions, [{ key: first.gateKey, answer: 'proceed' }])
    assert.ok(second.resume.includes(first.gateKey) && second.resume.includes(second.gateKey))
    // Only the newest answer re-halts at the first gate; every answer so far gets through both.
    assert.equal((await run({ scopeDecision: { key: second.gateKey, answer: 'proceed' } }, o)).result.node, 'R5#0')
    const done = (await run({ scopeDecisions: [{ key: first.gateKey, answer: 'proceed' }, { key: second.gateKey, answer: 'proceed' }] }, o)).result
    assert.equal(done.status, 'awaiting-approval')
    assert.deepEqual(done.approvedScopes.map(a => a.node), ['R5#0', 'R5#1'])
  })
})

describe('feasibility loop', () => {
  const WIDE = { scopeWidened: true, reason: 'The bounds helper is shared.', finalScope: { filesTouched: ['src/widget/ranges.py', 'src/widget/bounds.py'], outOfScope: [] } }
  test('a widened scope gets a second feasibility round on the new scope', async () => {
    const { result, calls } = await run({}, patch('R5:rescope', once(WIDE)))
    assert.equal(result.status, 'awaiting-approval')
    assert.deepEqual(labels(calls).filter(l => /^R[45]/.test(l)), ['R4:feasibility#0', 'R5:rescope#0', 'R4:feasibility#1', 'R5:rescope#1'])
    assert.ok(find(calls, 'R4:feasibility#1').prompt.includes('src/widget/bounds.py'))
    assert.ok(!result.warnings.some(w => /re-scope cap/.test(w)))
  })
  for (const [mode, rounds] of [['standard', 2], ['thorough', 3]]) {
    test(`${mode} caps the loop at ${rounds} rounds and notes the unchecked widening`, async () => {
      const { result, calls } = await run({ mode }, patch('R5:rescope', WIDE))
      assert.equal(result.status, 'awaiting-approval')
      assert.deepEqual([count(calls, 'R4:feasibility'), count(calls, 'R5:rescope')], [rounds, rounds])
      assert.ok(result.warnings.some(w => w.startsWith('The scope widened at the re-scope cap')))
    })
  }
  test('feasible=false stops with infeasible and removes the new worktree', async () => {
    const { result, calls } = await run({}, patch('R5:rescope', { feasible: false, reason: 'Needs a parser rewrite.' }))
    assert.deepEqual([result.stopped, result.reason], ['infeasible', 'Needs a parser rewrite.'])
    assert.match(result.findings, /Spiked the change/)
    assert.equal(count(calls, 'W1:discard'), 1)
    assert.ok(!calls.some(c => c.label.startsWith('R6')))
  })
})

describe('implementation loop', () => {
  test('a commit SHA that is not 40-hex triggers an informed retry without a check', async () => {
    const { result, calls } = await run({}, patch('R6:impl', once({ headSha: 'abc1234' })))
    assert.equal(result.status, 'awaiting-approval')
    assert.ok(!calls.some(c => c.label === 'R6:verify#0'))
    const retry = find(calls, 'R6:impl#1').prompt
    assert.ok(retry.includes('Your PREVIOUS attempt FAILED') && retry.includes('No full commit SHA returned'))
    assert.equal(result.headSha, implSha(1))
    assert.match(result.attempts[0].problem, /No full commit SHA/)
  })
  test('a failed verify feeds its failures into the next attempt', async () => {
    const { result, calls } = await run({}, patch('R6:verify', once(FAIL)))
    assert.equal(result.status, 'awaiting-approval')
    const retry = find(calls, 'R6:impl#1').prompt
    assert.ok(retry.includes('Your PREVIOUS attempt FAILED') && retry.includes(FAIL.failures[0]))
    assert.ok(!find(calls, 'R6:impl#0').prompt.includes('PREVIOUS attempt'))
    assert.deepEqual(result.attempts[0], { attempt: 0, headSha: implSha(0), verifyPassing: false, failures: FAIL.failures })
  })
  test('needsRescope re-plans without consuming an attempt', async () => {
    const { result, calls } = await run({ attempts: 1 }, patch('R6:verify', once({ ...FAIL, needsRescope: true })))
    assert.equal(result.status, 'awaiting-approval')
    assert.deepEqual(labels(calls).slice(10, 15), ['R6:impl#0', 'R6:verify#0', 'R5:rescope-impl#0', 'R6:impl#1', 'R6:verify#1'])
    const retry = find(calls, 'R6:impl#1').prompt
    assert.ok(retry.includes('attempt 1)') && retry.includes('SCOPE CHANGED after a failed approach') && retry.includes('git revert --no-edit'))
    assert.ok(find(calls, 'R6:verify#1').prompt.includes('src/widget/bounds.py'))
  })
  for (const [mode, rescopes, attempts] of [['quick', 0, 2], ['standard', 1, 3], ['thorough', 2, 4]]) {
    test(`${mode} allows ${rescopes} re-scope(s) and ${attempts} attempts, then stops with verify-failed`, async () => {
      const { result, calls } = await run({ mode }, patch(mode === 'quick' ? 'R6:check' : 'R6:verify', { ...FAIL, needsRescope: true }))
      assert.equal(result.stopped, 'verify-failed')
      assert.deepEqual([count(calls, 'R5:rescope-impl'), count(calls, 'R6:impl')], [rescopes, attempts + rescopes])
      assert.match(result.resume, new RegExp(`args\\.attempts above ${attempts}`))
      assert.equal(result.lastFailure.failures[0], FAIL.failures[0])
    })
  }
  test('an infeasible re-scope after implementation stops with infeasible-after-impl', async () => {
    const { result } = await run({}, { ...patch('R6:verify', { ...FAIL, needsRescope: true }), ...patch('R5:rescope-impl', { feasible: false, reason: 'No safe fix.' }) })
    assert.equal(result.stopped, 'infeasible-after-impl')
  })
  test('quick: a passing check whose differential did not run is not a failed attempt', async () => {
    const { result, calls } = await run({ mode: 'quick' }, patch('R6:check', { part2Ran: false }))
    assert.equal(result.stopped, 'unconfirmed')
    assert.match(result.reason, /the independent differential \(PART 2\) did not run/)
    assert.deepEqual(result.attempts, [0, 1].map(attempt => ({ attempt, headSha: implSha(attempt), verifyPassing: true, part2Ran: false })))
    const next = find(calls, 'R6:impl#1').prompt
    assert.ok(!next.includes('PREVIOUS attempt FAILED') && next.includes('keep the code and commit nothing unless you find a real problem'), next.slice(-400))
  })
  test('quick: when an earlier differential ran and did not confirm, the stop reports that one', async () => {
    const { result } = await run({ mode: 'quick' }, patch('R6:check', n => (n === 0 ? { redOnBase: false, reason: 'The acceptance test passes on the base.' } : { part2Ran: false })))
    assert.equal(result.stopped, 'unconfirmed')
    assert.match(result.reason, /did not confirm the fix for its change kind/)
    assert.deepEqual([result.lastFailure.stage, result.lastFailure.reason, result.confirm.redOnBase], ['confirm', 'The acceptance test passes on the base.', false])
  })
  test('a passing verify that never confirms stops with unconfirmed', async () => {
    const { result, calls } = await run({}, patch('R6.5:confirm', { redOnBase: false }))
    assert.equal(result.stopped, 'unconfirmed')
    assert.equal(count(calls, 'R6:impl'), 3)
    assert.equal(result.lastFailure.stage, 'confirm')
    assert.ok(find(calls, 'R6:impl#2').prompt.includes('"stage":"confirm"'))
  })
})

describe('confirmation by change kind, judged in code', () => {
  const NONE = { redOnBase: false, testGuardsBug: false, testPinsSemantics: false, behaviorPreserved: false, reproShowsNewOutput: false }
  const cases = [
    ['behavior with every proof', {}, 'behavior'],
    ['behavior without testPinsSemantics', { testPinsSemantics: false }, null],
    ['behavior without testGuardsBug', { testGuardsBug: false }, null],
    ['behavior that is not red on the base', { redOnBase: false }, null],
    ['any kind without greenWithFix', { greenWithFix: false }, null],
    ['diagnostics with preserved behavior and new output', { ...NONE, changeKindConfirmed: 'diagnostics', behaviorPreserved: true, reproShowsNewOutput: true }, 'diagnostics'],
    ['diagnostics without new output', { ...NONE, changeKindConfirmed: 'diagnostics', behaviorPreserved: true }, null],
    ['diagnostics without preserved behavior', { ...NONE, changeKindConfirmed: 'diagnostics', reproShowsNewOutput: true }, null],
    ['docs with preserved behavior', { ...NONE, changeKindConfirmed: 'docs', codeChanged: false, behaviorPreserved: true }, 'docs'],
    ['docs without preserved behavior', { ...NONE, changeKindConfirmed: 'docs', codeChanged: false }, null],
    ['docs that changed code, judged as behavior and failing', { ...NONE, changeKindConfirmed: 'docs', codeChanged: true, behaviorPreserved: true }, null],
    ['docs that changed code, judged as behavior and passing', { changeKindConfirmed: 'docs', codeChanged: true }, 'behavior'],
    ['a check that omits treeIntact', { treeIntact: undefined }, null],
    ['docs that omits codeChanged, judged as behavior and failing', { ...NONE, changeKindConfirmed: 'docs', codeChanged: undefined, behaviorPreserved: true }, null],
  ]
  for (const mode of ['standard', 'quick']) {
    for (const [what, c, kind] of cases) {
      test(`${mode}: ${what} is ${kind ? `confirmed as ${kind}` : 'not confirmed'}`, async () => {
        const { result } = await run({ mode, attempts: 1 }, patch(mode === 'quick' ? 'R6:check' : 'R6.5:confirm', c))
        if (!kind) return assert.equal(result.stopped, 'unconfirmed')
        assert.deepEqual([result.status, result.changeKind], ['awaiting-approval', kind])
      })
    }
  }
  test("without changeKindConfirmed the implementer's kind is used", async () => {
    const { result } = await run({ attempts: 1 }, { ...patch('R6:impl', { changeKind: 'docs' }), ...patch('R6.5:confirm', { ...NONE, changeKindConfirmed: undefined, codeChanged: false, behaviorPreserved: true }) })
    assert.equal(result.changeKind, 'docs')
  })
  test('quick: a check that omits every confirmation field never counts as confirmed', async () => {
    const o = { ...patch('R6:impl', { changeKind: 'docs' }), ...patch('R6:check', { treeIntact: undefined, codeChanged: undefined, changeKindConfirmed: undefined }) }
    const { result, calls } = await run({ mode: 'quick' }, o)
    assert.deepEqual([result.stopped, count(calls, 'R6:check')], ['unconfirmed', 2])
  })
  test('a non-behavior change says so in the intent', async () => {
    const { calls } = await run({}, patch('R6.5:confirm', { ...NONE, changeKindConfirmed: 'diagnostics', behaviorPreserved: true, reproShowsNewOutput: true }))
    assert.match(find(calls, 'FINAL:check').prompt, /This is a diagnostics-only change: runtime behavior is intentionally unchanged\./)
  })
  for (const [mode, node] of [['standard', 'R6.5:confirm'], ['quick', 'R6:check']]) {
    test(`${mode}: a check that leaves the tree dirty stops with tree-damaged`, async () => {
      const { result, calls } = await run({ mode }, patch(node, { treeIntact: false }))
      assert.equal(result.stopped, 'tree-damaged')
      assert.ok(result.resume.endsWith('args.confirmAttempts={"0":1}.'), result.resume)
      assert.equal(calls.at(-1).label, `${node}#0`)
      assert.deepEqual((await run({ mode, confirmAttempt: 1 }, patch(node, { treeIntact: false }))).result.confirmAttempts, { 0: 2 })
    })
  }
})

describe('polish and reviewers (thorough mode)', () => {
  const thorough = o => run({ mode: 'thorough' }, o)
  test('a merged polish with a valid SHA moves the head', async () => {
    const { result, calls } = await thorough()
    assert.equal(result.polish.merged, true)
    assert.ok(find(calls, 'FINAL:check').prompt.includes(`Expected head ${POLISH_SHA}`))
    assert.equal(result.headSha, POLISH_SHA)
    assert.ok(find(calls, 'P2:polish-apply').prompt.includes(`git switch -c ${BRANCH}-polish`))
  })
  test('a claimed merge without a valid SHA keeps the confirmed head and warns', async () => {
    const { result, calls } = await thorough(patch('P2:polish-apply', { finalHead: 'abc123' }))
    assert.equal(result.polish.merged, false)
    assert.ok(find(calls, 'FINAL:check').prompt.includes(`Expected head ${implSha(0)}`))
    assert.ok(result.warnings.includes('P2 claimed a merge without a valid head SHA, so the polished head was not re-checked.'))
    assert.ok(!result.warnings.some(w => /the final check verifies/.test(w)))
    assert.equal((await thorough(patch('P2:polish-apply', { merged: false, finalHead: implSha(0) }))).result.headSha, implSha(0))
  })
  test('a clean polish review skips the apply step; a failed polish never blocks the run', async () => {
    const clean = await thorough(patch('P1:polish-review', { items: [] }))
    assert.equal(count(clean.calls, 'P2:polish-apply'), 0)
    assert.equal(clean.result.polish.note, 'Reviewer found nothing to polish.')
    const p1 = (await thorough({ 'P1:polish-review': null })).result
    assert.equal(p1.status, 'awaiting-approval')
    assert.match(p1.polish.skipped, /polish review returned no result/)
    const p2 = (await thorough({ 'P2:polish-apply': null })).result
    assert.equal(p2.status, 'awaiting-approval')
    assert.match(p2.polish.skipped, /^polish apply returned no result/)
    assert.doesNotMatch(p2.polish.skipped, /confirmed head is unchanged/)
  })
  // Head adoption after polish and the findings merge are in args.test.mjs, beside the final-check gate.
})

describe('approval packet', () => {
  test('carries the run, the publish target, the PR text paths and the change kind', async () => {
    const { result } = await run()
    assert.deepEqual(result.run, { mode: 'standard', effort: 'medium', model: 'session', gate: 'auto', agentsUsed: 14, maxAgents: 40 })
    assert.deepEqual({ ...result.publish }, { owner: 'acme', repo: 'widget', defaultBranch: 'main', login: LOGIN, canPush: false, forkUrl: `https://github.com/${LOGIN}/widget.git`, aiPolicy: 'none-found' })
    assert.deepEqual([result.prTitlePath, result.prBodyPath, result.intentPath], [`${STATE_DIR}/pr-title.txt`, `${STATE_DIR}/pr-body.md`, undefined])
    assert.deepEqual([result.status, result.changeKind, result.gate.kind, result.prTitle], ['awaiting-approval', 'behavior', 'builtin', canned('FINAL:check').prTitle])
    assert.deepEqual([result.clonePath, result.worktreePath, result.branch, result.baseRef, result.baseSha, result.headSha], [CLONE, WORKTREE, BRANCH, 'upstream/main', BASE_SHA, implSha(0)])
    assert.equal(result.evidence.outputDir, `${STATE_DIR}/evidence`)
    assert.match(result.cleanup, new RegExp(`worktree remove '${WORKTREE}'`))
    assert.deepEqual([result.issue, result.approvedScopes], ['acme/widget#42', []])
  })
  test('the fork URL comes from no-mistakes when known; canPush accepts "true"', async () => {
    const { result } = await run({}, withRepo({ canPush: 'true', noMistakes: { installed: true, gated: false, forkUrl: 'https://github.com/me/widget-fork.git' } }))
    assert.deepEqual([result.publish.canPush, result.publish.forkUrl], [true, 'https://github.com/me/widget-fork.git'])
  })
  test('repo rules and risks become warnings and constraints', async () => {
    const { result } = await run({}, { ...patch('GATE-0', { draftRequired: true, humanTestingRequired: true, dcoRequired: true, memoryConflicts: ['The note says tests live in test/.'] }),
      ...withRepo({ services: 'PostgreSQL; DB tests self-skip.' }), ...patch('R5:rescope', (n, def) => ({ finalScope: { ...def.finalScope, recentCommits: 0 } })) })
    const w = result.warnings.join('\n')
    for (const re of [/draft PR/, /human to test/, /contradicted by the current code: The note says/, /Services\/limits: PostgreSQL/, /No commits touched these files in 6 months/]) assert.match(w, re)
    assert.equal(result.constraints.dcoRequired, true)
  })
  test('the commit rule asks for a sign-off only when DCO is required', async () => {
    assert.match(find((await run({}, patch('GATE-0', { dcoRequired: true }))).calls, 'R6:impl#0').prompt, /sign off with git commit -s/)
    assert.doesNotMatch(find((await run()).calls, 'R6:impl#0').prompt, /git commit -s/)
  })
})
