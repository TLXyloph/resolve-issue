// What each workflow argument does: the input boundary (direct invocation, issue-URL normalization,
// validation) and the run configuration (mode, effort, model, attempts, maxAgents, polish), the
// final-check gate with its outcomes and merged findings, and the resume overrides (retryNodes,
// confirmAttempts). Every rejected input must stop before the first agent call.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  runPipeline, happy, canned, runArgs, baseLabel, run, labels, count, find, patch, withTriage, withRepo, GATED,
  journaled, recorded, prefixReplay, resumeArg, HAPPY_AGENT_COUNTS, ISSUE_URL, WORKSPACE, CLONE, WORKTREE, STATE_DIR, BRANCH, LOGIN, POLISH_SHA, implSha,
} from './harness.mjs'

const noAgents = async (args, expected) => {
  const { result, calls } = await runPipeline(args, happy())
  assert.equal(calls.length, 0, `no agent may run for ${JSON.stringify(args)}`)
  for (const [k, v] of Object.entries(expected)) assert.equal(result[k], v, `${k} for ${JSON.stringify(args)}`)
  return result
}

describe('input boundary', () => {
  test('direct invocation starts nothing and points to the skill', async () => {
    for (const args of [undefined, null, '', ISSUE_URL, '/resolve-issue acme/widget#42', [ISSUE_URL], { issueUrl: ISSUE_URL },
      { issueUrl: ISSUE_URL, workspace: '' }, JSON.stringify({ issueUrl: ISSUE_URL }), '{not json']) {
      assert.match((await noAgents(args, { started: false, reason: 'use-the-skill' })).next, /\/resolve-issue <issue-url>/)
    }
  })
  test('args given as a JSON string are accepted', async () => {
    const { result, calls } = await runPipeline(JSON.stringify(runArgs({ mode: 'triage' })), happy())
    assert.equal(result.status, 'triaged')
    assert.equal(calls.length, 2)
  })
  test('issue URLs are normalized before use', async () => {
    const url = ISSUE_URL
    for (const issueUrl of [`<${url}>`, `\`${url}\``, `"${url}"`, `'${url}'`, `(${url})`, `${url}.`, `${url}),`, `${url}#issuecomment-123456`, `${url}?q=is%3Aopen`,
      `${url}/`, url.replace('https:', 'http:'), url.replace('github.com', 'www.github.com'), `  ${url}  `, `<${url}#issuecomment-1>.`]) {
      const { result, calls } = await run({ issueUrl, mode: 'triage' })
      assert.equal(result.status, 'triaged', issueUrl)
      assert.equal(result.issueUrl, url, issueUrl)
      assert.equal(result.issue, 'acme/widget#42', issueUrl)
      for (const c of calls) assert.ok(c.prompt.includes(url) && !c.prompt.includes('issuecomment'), `${c.label} prompt for ${issueUrl}`)
    }
  })
  test('owner, repo and number come from the URL', async () => {
    const { result, calls } = await run({ issueUrl: 'https://github.com/Some-Org/my.repo_name/issues/7', mode: 'triage' }, patch('U2:issue', { issueNumber: '#7' }))
    assert.equal(result.issue, 'Some-Org/my.repo_name#7')
    assert.ok(calls.every(c => c.prompt.includes('Some-Org/my.repo_name')))
  })
  test('non-issue URLs and unsafe owner/repo names are rejected', async () => {
    for (const issueUrl of ['https://github.com/acme/widget/pull/42', 'https://github.com/acme/widget/issues', 'https://github.com/acme/widget/issues/abc',
      'https://github.com/acme/widget/issues/42/comments', 'https://gitlab.com/acme/widget/issues/42', 'https://github.com/acme/issues/42',
      'github.com/acme/widget/issues/42', 'acme/widget#42', "https://github.com/ac'me/widget/issues/42", 'https://github.com/acme/wid"get/issues/42',
      'https://github.com/ac me/widget/issues/42', 'https://github.com/acme/wid get/issues/42', 'https://github.com/acme/../issues/42',
      'https://github.com/acme/./issues/42', 'https://github.com/-acme/widget/issues/42', 'https://github.com/acme/widget;rm/issues/42',
      'https://github.com/acme/widget/issues/1234567890', 'ftp://github.com/acme/widget/issues/42', '']) {
      assert.match((await noAgents(runArgs({ issueUrl }), { stopped: 'invalid-issue-url' })).reason, /Expected https:\/\/github\.com\/<owner>\/<repo>\/issues\/<number>/)
    }
    await noAgents({ workspace: WORKSPACE }, { stopped: 'invalid-issue-url' })
    await noAgents(runArgs({ issueUrl: 42 }), { stopped: 'invalid-issue-url' })
  })
  test('unknown mode, effort or gate and a malformed model stop with bad-args', async () => {
    for (const extra of [{ mode: 'fast' }, { mode: 'ultra' }, { effort: 'ultra' }, { effort: 'xhigh' }, { gate: 'remote' }, { gate: 'github' },
      { model: 'gpt 4' }, { model: "opus'" }, { model: 'opus; rm -rf ~' }, { model: '-opus' }, { model: '"opus"' }, { model: '@opus' }, { model: 'a'.repeat(202) }]) {
      await noAgents(runArgs(extra), { stopped: 'bad-args' })
    }
  })
  test('non-numeric attempts and maxAgents stop with bad-args', async () => {
    for (const extra of [{ attempts: 'abc' }, { attempts: 1.5 }, { attempts: '-1' }, { attempts: '2x' },
      { maxAgents: 'abc' }, { maxAgents: 10.5 }, { maxAgents: '-5' }, { maxAgents: true }]) {
      await noAgents(runArgs(extra), { stopped: 'bad-args' })
    }
  })
  test('attempts outside 1 to 8 stop with bad-args', async () => {
    for (const attempts of [0, 9, '0', '9', 100]) await noAgents(runArgs({ attempts }), { stopped: 'bad-args' })
  })
  test('maxAgents outside 4 to 200 stops with bad-args', async () => {
    for (const maxAgents of [0, 1, 3, 201, 500, '2']) await noAgents(runArgs({ maxAgents }), { stopped: 'bad-args' })
  })
  test('the workspace must be an absolute path without quotes or newlines', async () => {
    for (const workspace of ['ws', './ws', '~/ws', "/tmp/o'brien", '/tmp/ws\n/etc', '/tmp/ws\rx', 'tmp/ws']) await noAgents(runArgs({ workspace }), { stopped: 'bad-args' })
  })
  test('a trailing slash on the workspace is dropped and Windows drive paths are accepted', async () => {
    assert.ok(find((await run({ workspace: '/tmp/ws///', mode: 'quick' })).calls, 'U1:repo').prompt.includes("The user's workspace is '/tmp/ws'."))
    assert.equal((await run({ workspace: 'C:\\work\\src', mode: 'triage' })).result.status, 'triaged')
  })
  test('scopeDecisions that is not a list of keyed proceed or abort answers stops with bad-args', async () => {
    for (const scopeDecisions of ['proceed', { key: 'R2:abc', answer: 'proceed' }, ['proceed'], [{ answer: 'proceed' }], [{ key: 'R2:abc', answer: 'yes' }], [{ key: 'R2:abc' }]]) {
      await noAgents(runArgs({ scopeDecisions }), { stopped: 'bad-args' })
    }
  })
  test('mode, effort and gate ignore case and spaces; session/default/inherit mean the session model', async () => {
    const { result, calls } = await run({ mode: ' Triage ', effort: 'LOW', gate: 'Builtin', model: 'default' })
    assert.deepEqual(result.run, { mode: 'triage', effort: 'low', model: 'session', gate: 'builtin', agentsUsed: 2, maxAgents: 6 })
    assert.ok(calls.every(c => !('model' in c.opts)))
    for (const model of ['session', 'inherit', '', null]) assert.equal((await run({ mode: 'triage', model })).result.run.model, 'session', String(model))
    for (const model of ['opus', 'claude-sonnet-4-5', 'claude-opus-4-1[1m]', 'us.anthropic.claude-haiku-4-5:0', 'claude-opus-4-1@20250805',
      'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123', 'a'.repeat(201)]) assert.equal((await run({ mode: 'triage', model })).result.run.model, model)
  })
})

describe('mode', () => {
  for (const [mode, n] of Object.entries(HAPPY_AGENT_COUNTS)) {
    test(`${mode} runs ${n} agents on the happy path and ends ${mode === 'triage' ? 'triaged' : 'awaiting approval'}`, async () => {
      const { result, calls } = await run({ mode })
      assert.equal(result.status, mode === 'triage' ? 'triaged' : 'awaiting-approval')
      assert.equal(calls.length, n)
      assert.equal(result.run.agentsUsed, n)
    })
  }
  test('the counts the docs cite are the ones recorded here', () => assert.deepEqual({ ...HAPPY_AGENT_COUNTS }, { triage: 2, quick: 10, standard: 14, thorough: 19 }))
  test('standard is the default and walks the phases in order', async () => {
    const { result, calls, phases, logs } = await run()
    assert.equal(result.run.mode, 'standard')
    assert.deepEqual(labels(calls), ['U1:repo', 'U2:issue', 'U3:prior-art', 'GATE-0', 'W1:worktree', 'R1:validate', 'R2:plan', 'R3:scope',
      'R4:feasibility#0', 'R5:rescope#0', 'R6:impl#0', 'R6:verify#0', 'R6.5:confirm#0', 'FINAL:check'])
    assert.deepEqual(phases, ['Recon', 'Worktree', 'Validate', 'Plan & Scope', 'Implement & Verify', 'Final check'])
    assert.equal(logs[0], 'resolve-issue: acme/widget#42 · standard mode · effort medium · gate auto · up to 40 agents')
  })
  test('triage reads the thread and prior art only: no clone, no worktree', async () => {
    const { result, calls } = await run({ mode: 'triage' })
    assert.deepEqual(labels(calls).sort(), ['U2:issue', 'U3:prior-art'])
    assert.equal(result.verdict, 'takeable')
    assert.deepEqual(result.blockers, [])
    assert.equal(result.summary.title, canned('U2:issue').title)
  })
  for (const [size, mode] of [['small', 'quick'], ['medium', 'standard'], ['large', 'thorough'], [undefined, 'standard']]) {
    test(`triage suggests ${mode} mode for a ${size || 'missing'} size`, async () => assert.equal((await run({ mode: 'triage' }, patch('U2:issue', { size }))).result.suggestedMode, mode))
  }
  test('triage reports a failed viability check as not takeable', async () => {
    const hard = (await run({ mode: 'triage' }, withTriage({ archived: true }))).result
    assert.deepEqual([hard.verdict, hard.suggestedMode, hard.blockers.map(b => b.code)], ['not-takeable', null, ['repo-archived']])
    assert.match(hard.next, /hard stop/)
    const soft = (await run({ mode: 'triage' }, withTriage({ state: 'CLOSED' }))).result
    assert.equal(soft.verdict, 'not-takeable')
    assert.match(soft.next, /force/)
    const forced = (await run({ mode: 'triage', force: true }, withTriage({ state: 'CLOSED' }))).result
    assert.equal(forced.verdict, 'takeable')
    assert.ok(forced.warnings.some(w => w.startsWith('Overridden with force: issue-closed')))
  })
  test('quick: one plan+scope step, one combined check per attempt, no polish, no extra reviewers', async () => {
    const { calls } = await run({ mode: 'quick' })
    for (const base of ['R2:plan', 'R3:scope', 'R4:feasibility', 'R5:rescope', 'R6:verify', 'R6.5:confirm', 'P1:polish-review', 'P2:polish-apply', 'REVIEW:correctness', 'REVIEW:conventions']) {
      assert.equal(count(calls, base), 0, base)
    }
    assert.deepEqual([count(calls, 'R2:plan+scope'), count(calls, 'R6:check')], [1, 1])
    const check = find(calls, 'R6:check#0').prompt
    assert.ok(check.includes('PART 1.') && check.includes('PART 2 (only if PART 1 passes; set part2Ran=true when you run it). DIFFERENTIAL WITHOUT STASH'))
    const failing = await run({ mode: 'quick' }, patch('R6:check', { passing: false }))
    assert.deepEqual(labels(failing.calls).filter(l => l.startsWith('R6')), ['R6:impl#0', 'R6:check#0', 'R6:impl#1', 'R6:check#1'])
  })
  for (const [mode, scope] of [['quick', 'no tests beyond what already ran (quick mode)'], ['standard', 'the test modules for every file and package the diff touches'], ['thorough', 'the full test suite if it finishes in about 15 minutes']]) {
    test(`${mode}: the final check runs ${scope.split(' (')[0]}`, async () => assert.ok(find((await run({ mode })).calls, 'FINAL:check').prompt.includes(scope)))
  }
  test('polish=true adds the polish pass to quick mode; polish=false removes it from thorough', async () => {
    assert.equal(count((await run({ mode: 'quick', polish: true })).calls, 'P1:polish-review'), 1)
    assert.equal(count((await run({ mode: 'thorough', polish: 'false' })).calls, 'P1:polish-review'), 0)
  })
  test('attempts sets the number of tries', async () => {
    assert.equal(count((await run({ attempts: 5 }, patch('R6:verify', { passing: false }))).calls, 'R6:impl'), 5)
    const q = await run({ mode: 'quick', attempts: '1' }, patch('R6:check', { passing: false }))
    assert.equal(q.result.stopped, 'verify-failed')
    assert.equal(count(q.calls, 'R6:impl'), 1)
  })
})

describe('effort and model', () => {
  const CLASS = {
    'U1:repo': 'read', 'U2:issue': 'read', 'U3:prior-art': 'read', 'GATE-0': 'read', 'W1:worktree': 'mech', 'W1:discard': 'mech',
    'R1:validate': 'think', 'R2:plan': 'think', 'R2:plan+scope': 'think', 'R3:scope': 'think', 'R4:feasibility': 'think', 'R5:rescope': 'think',
    'R5:rescope-impl': 'think', 'R6:impl': 'think', 'P1:polish-review': 'think', 'P2:polish-apply': 'think', 'R6:verify': 'check', 'R6.5:confirm': 'check', 'R6.5:confirm-polish': 'check',
    'R6:check': 'check', 'FINAL:check': 'check', 'REVIEW:correctness': 'check', 'REVIEW:conventions': 'check', 'R7:no-mistakes': 'check',
  }
  const PROFILES = {
    low: { mech: 'low', read: 'low', think: 'medium', check: 'medium' }, medium: { mech: 'low', read: 'medium', think: 'high', check: 'high' },
    high: { mech: 'low', read: 'medium', think: 'xhigh', check: 'xhigh' }, max: { mech: 'medium', read: 'high', think: 'max', check: 'max' },
  }
  // Runs that together reach every node of the graph.
  const everyNode = async extra => (await Promise.all([
    run({ mode: 'thorough', ...extra }), run({ mode: 'quick', ...extra }), run({ gate: 'no-mistakes', ...extra }, GATED),
    run(extra, patch('R6:verify', n => (n === 0 ? { passing: false, needsRescope: true } : undefined))), run(extra, patch('R1:validate', { valid: false })),
  ])).flatMap(r => r.calls)
  for (const [effort, profile] of Object.entries(PROFILES)) {
    test(`effort=${effort} sets each node's effort by its class`, async () => {
      const calls = await everyNode(effort === 'medium' ? {} : { effort })
      assert.deepEqual(new Set(calls.map(c => baseLabel(c.label))), new Set(Object.keys(CLASS)), 'the class table covers every node')
      for (const c of calls) assert.equal(c.opts.effort, profile[CLASS[baseLabel(c.label)]], c.label)
    })
  }
  test('spot checks per level', async () => {
    const at = async (effort, label) => find((await run({ effort })).calls, label).opts.effort
    assert.deepEqual([await at('low', 'U1:repo'), await at('low', 'W1:worktree'), await at('low', 'R1:validate'), await at('low', 'R6:verify#0')], ['low', 'low', 'medium', 'medium'])
    assert.equal(await at('high', 'R6:impl#0'), 'xhigh')
    assert.deepEqual([await at('max', 'W1:worktree'), await at('max', 'R6.5:confirm#0')], ['medium', 'max'])
  })
  test('effort=inherit sets no effort on any agent', async () => {
    for (const c of await everyNode({ effort: 'inherit' })) assert.ok(!('effort' in c.opts), c.label)
  })
  test('a model runs every agent on it; without one no model is set', async () => {
    for (const c of await everyNode({ model: 'opus' })) assert.equal(c.opts.model, 'opus', c.label)
    for (const c of await everyNode({})) assert.ok(!('model' in c.opts), c.label)
    assert.equal((await run({ mode: 'triage', model: 'sonnet' })).result.run.model, 'sonnet')
  })
  test('every node passes a schema except the feasibility spike, which replies in text', async () => {
    for (const c of await everyNode({})) assert.equal(!!c.opts.schema, baseLabel(c.label) !== 'R4:feasibility', c.label)
  })
})

describe('maxAgents: the agent cap', () => {
  test('a small cap stops with agent-budget-reached at exactly the cap', async () => {
    const { result, calls } = await run({ mode: 'quick', maxAgents: 5 })
    assert.equal(result.stopped, 'agent-budget-reached')
    assert.deepEqual([calls.length, result.run.agentsUsed], [5, 5])
    assert.match(result.resume, /args\.maxAgents above 5/)
  })
  test('a cap reached mid-loop says where the work is', async () => {
    const { result, calls } = await run({ maxAgents: 12 })
    assert.equal(result.stopped, 'agent-budget-reached')
    assert.equal(calls.length, 12)
    assert.equal(result.headSha, implSha(0))
    assert.match(result.worktreePath, /widget-issue-42$/)
  })
  test('retries count toward the cap', async () => {
    const { result, calls } = await run({ mode: 'quick', maxAgents: 6 }, { 'R1:validate': null })
    assert.equal(result.stopped, 'agent-budget-reached')
    assert.equal(calls.length, 6)
  })
  test('no cap from 4 to 20 is ever exceeded', async () => {
    for (let cap = 4; cap <= 20; cap++) {
      const { result, calls } = await run({ mode: 'thorough', maxAgents: cap })
      assert.ok(calls.length <= cap, `cap ${cap}: ${calls.length} agents`)
      assert.equal(result.run.agentsUsed, calls.length)
      assert.ok(result.status === 'awaiting-approval' || result.stopped === 'agent-budget-reached', `cap ${cap}: ${result.stopped}`)
    }
  })
  test('a cap that cuts off the extra reviewers still returns the packet and says so, on both gates', async () => {
    for (const gate of ['builtin', 'no-mistakes']) {
      for (const maxAgents of [17, 18]) {
        const { result, calls } = await run({ mode: 'thorough', gate, maxAgents }, gate === 'builtin' ? {} : GATED)
        assert.deepEqual([result.status, calls.length], ['awaiting-approval', maxAgents], `${gate} ${maxAgents}`)
        assert.ok(result.warnings.includes(`The agent cap (${maxAgents}) was reached, so ${19 - maxAgents} extra reviewer(s) did not run. Raise maxAgents for the full review.`))
      }
      assert.equal((await run({ mode: 'thorough', gate, maxAgents: 16 }, gate === 'builtin' ? {} : GATED)).result.stopped, 'agent-budget-reached', 'the gate itself needs a slot')
    }
  })
  test('at the maximum, the resume does not ask for more attempts or a higher cap', async () => {
    for (const [extra, o, max] of [[{ attempts: 8 }, patch('R6:verify', { passing: false }), 'attempts is already at its maximum (8)'],
      [{ attempts: 8 }, patch('R6.5:confirm', { redOnBase: false }), 'attempts is already at its maximum (8)'],
      [{ maxAgents: 200 }, { 'R1:validate': () => { throw new Error('Agent call cap reached for this workflow run') } }, 'maxAgents is already at its maximum (200)']]) {
      const { result } = await run(extra, o)
      assert.ok(result.resume.includes(max) && /fresh run/.test(result.resume), result.resume)
      assert.doesNotMatch(result.resume, /above/)
    }
    assert.match((await run({ attempts: 7 }, patch('R6:verify', { passing: false }))).result.resume, /args\.attempts above 7 \(up to 8\)/)
  })
  test("a refusal from Claude Code's own call cap stops cleanly, without a retry", async () => {
    const { result, calls } = await run({}, { 'R1:validate': () => { throw new Error('Agent call cap reached for this workflow run') } })
    assert.equal(result.stopped, 'agent-budget-reached')
    assert.match(result.reason, /call cap/)
    assert.equal(calls.at(-1).label, 'R1:validate')
    assert.equal(count(calls, 'R1:validate'), 1)
  })
})

describe('gate: the final check', () => {
  test('auto uses no-mistakes when the repo is gated, else the built-in check; builtin always uses the built-in check', async () => {
    const gated = await run({}, GATED)
    assert.deepEqual([count(gated.calls, 'R7:no-mistakes'), count(gated.calls, 'FINAL:check'), gated.result.gate.kind], [1, 0, 'no-mistakes'])
    for (const noMistakes of [{ installed: true, gated: false }, { installed: false, gated: false }]) {
      const r = await run({}, withRepo({ noMistakes }))
      assert.deepEqual([count(r.calls, 'FINAL:check'), r.result.gate.kind], [1, 'builtin'])
    }
    assert.equal(count((await run({ gate: 'builtin' }, GATED)).calls, 'R7:no-mistakes'), 0)
  })
  for (const [what, noMistakes, canPush, cmd] of [
    ['not installed', { installed: false, gated: false }, false, /Install no-mistakes/],
    ['installed but not initialized, without push access', { installed: true, gated: false }, false, new RegExp(`^cd '${CLONE}' && no-mistakes init --fork-url https://github.com/${LOGIN}/widget\\.git$`)],
    ['installed but not initialized, with push access', { installed: true, gated: false }, true, new RegExp(`^cd '${CLONE}' && no-mistakes init$`)],
  ]) {
    test(`no-mistakes when ${what}: handoff-failed with setup commands and no R7 agent`, async () => {
      const { result, calls } = await run({ gate: 'no-mistakes' }, withRepo({ noMistakes, canPush }))
      assert.equal(result.stopped, 'handoff-failed')
      assert.match(result.gate.setupCommands[0], cmd)
      assert.equal(count(calls, 'R7:no-mistakes'), 0)
    })
  }
  test('a resume that re-runs the gate replays the extra reviewers from cache, on both gates', async () => {
    for (const [gate, stop, o, label] of [['builtin', 'final-check-failed', patch('FINAL:check', { ran: false, summary: 'The tree was dirty.' }), 'FINAL:check#1'],
      ['no-mistakes', 'gate-still-running', { ...GATED, ...patch('R7:no-mistakes', { outcome: 'still_running' }) }, 'R7:no-mistakes#1']]) {
      const first = recorded(happy(o))
      const stopped = (await runPipeline(runArgs({ mode: 'thorough', gate }), first.respond)).result
      assert.deepEqual([stopped.stopped, /args\.gateAttempt=1/.test(stopped.resume)], [stop, true], gate)
      const resumed = prefixReplay(first.log, happy(gate === 'builtin' ? {} : GATED))
      const { result } = await runPipeline(runArgs({ mode: 'thorough', gate, gateAttempt: 1 }), resumed.respond)
      assert.deepEqual([result.status, resumed.live], ['awaiting-approval', [label]], `${gate}: only the gate runs again`)
    }
  })
  test('a step that fails beside others retries after the join, so a resume replays it and everything after it from cache', async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    const slowFail = ms => async (l, p, o, n) => (n === 0 ? (await sleep(ms), null) : undefined) // the first try dies slowly, the retry works
    const dirty = patch('FINAL:check', n => (n === 0 ? { ran: false, summary: 'The tree was dirty.' } : undefined))
    for (const fails of [{ 'GATE-0': slowFail(30) }, { 'U1:repo': slowFail(40), 'U2:issue': slowFail(10) }]) {
      const first = recorded(happy({ ...fails, ...dirty }))
      assert.equal((await runPipeline(runArgs(), first.respond)).result.stopped, 'final-check-failed')
      const resumed = prefixReplay(first.log, happy())
      const { result } = await runPipeline(runArgs({ gateAttempt: 1 }), resumed.respond)
      assert.deepEqual([result.status, resumed.live], ['awaiting-approval', ['FINAL:check#1']], Object.keys(fails).join(', '))
    }
    const twice = recorded(happy({ 'GATE-0': async () => (await sleep(30), null) }))
    const failed = (await runPipeline(runArgs(), twice.respond)).result
    assert.deepEqual([failed.stopped, failed.node, resumeArg(failed, 'retryNodes')], ['agent-failed', 'GATE-0', { 'GATE-0': 1 }])
    const again = prefixReplay(twice.log, happy())
    const { result, calls } = await runPipeline(runArgs({ retryNodes: { 'GATE-0': 1 } }), again.respond)
    assert.deepEqual([result.status, again.live[0]], ['awaiting-approval', 'GATE-0~retry'], 'only the retry is new: W1 and R1 replay from cache')
    assert.match(find(calls, 'GATE-0~retry').prompt, /failed in an earlier run: retry 1/)
  })
  test('a recon step that fails twice stops the run before the next retry, so its resume re-runs nothing that finished', async () => {
    const first = recorded(happy({ 'U1:repo': null, 'U2:issue': (l, p, o, n) => (n === 0 ? null : undefined) }))
    const stopped = (await runPipeline(runArgs(), first.respond)).result
    assert.deepEqual([stopped.stopped, stopped.node, resumeArg(stopped, 'retryNodes')], ['agent-failed', 'U1:repo', { 'U1:repo': 1 }])
    const resumed = prefixReplay(first.log, happy())
    const { result } = await runPipeline(runArgs({ retryNodes: { 'U1:repo': 1 } }), resumed.respond)
    const finished = new Set(first.log.filter(e => e.result != null).map(e => e.label))
    assert.deepEqual([result.status, resumed.live[0], resumed.live.filter(l => finished.has(l))], ['awaiting-approval', 'U1:repo~retry', []])
  })
  test('gateAttempt and confirmAttempts re-label and re-number the re-run step', async () => {
    assert.ok(find((await run({ gateAttempt: 1 })).calls, 'FINAL:check#1').prompt.startsWith('FINAL CHECK (attempt 2)'))
    assert.ok(find((await run({ gateAttempt: 2 }, GATED)).calls, 'R7:no-mistakes#2').prompt.startsWith('R7 (validation attempt 3)'))
    assert.match(find((await run({ confirmAttempts: { 0: 1 } })).calls, 'R6.5:confirm#0').prompt, /^R6\.5 \(confirm, check 2\)/)
  })
  const r7 = g => run({}, { ...GATED, ...patch('R7:no-mistakes', g) })
  test('the no-mistakes run skips push, pr and ci and the packet points at the intent file', async () => {
    const { result, calls } = await run({}, GATED)
    assert.ok(find(calls, 'R7:no-mistakes').prompt.includes(`cd '${WORKTREE}' && no-mistakes axi run --skip push,pr,ci --no-publish-intent --intent "$(cat '${STATE_DIR}/intent.txt')"`))
    assert.deepEqual([result.status, result.gate.outcome, result.intentPath], ['awaiting-approval', 'parked_at_gate', `${STATE_DIR}/intent.txt`])
  })
  for (const [what, g] of [['outcome not_started', { outcome: 'not_started', handedOff: false, setupCommands: ['x'] }], ['outcome failed', { outcome: 'failed' }], ['handedOff=false', { handedOff: false }]]) {
    test(`R7 with ${what} stops with handoff-failed`, async () => {
      const { result } = await r7(g)
      assert.deepEqual([result.stopped, result.intentPath], ['handoff-failed', `${STATE_DIR}/intent.txt`])
    })
  }
  test('a no-mistakes run that started and then failed names the failed step, not the setup commands', async () => {
    const steps = [...['intent', 'rebase', 'review'].map(name => ({ name, status: 'completed' })), { name: 'test', status: 'failed' }]
    const failedAt = (await r7({ outcome: 'failed', steps, summary: 'test step failed: 3 tests fail', findings: [{ id: 't1' }] })).result
    assert.deepEqual([failedAt.stopped, failedAt.reason, failedAt.gate.findings], ['handoff-failed', 'test step failed: 3 tests fail', [{ id: 't1' }]])
    assert.equal(failedAt.resume, "The no-mistakes validation run failed at test: fix what it reports (gate.steps, gate.findings), then re-invoke with this run's resumeFromRunId and args.gateAttempt=1. The resume starts a new validation run on the same head.")
    const failed = (await r7({ outcome: 'failed', steps: [], summary: '' })).result
    assert.deepEqual([failed.reason, failed.resume.split(':')[0]], ['The no-mistakes validation run failed.', 'The no-mistakes validation run failed'])
    for (const g of [{ outcome: 'not_started', handedOff: false }, { handedOff: false }]) assert.match((await r7(g)).result.resume, /^Fix the cause \(e\.g\. run gate\.setupCommands, or re-run with gate=builtin\)/)
  })
  test("the extra reviewers' findings on the no-mistakes gate are merged and numbered RV1, RV2, ...", async () => {
    const f = (severity, line, description) => ({ id: 'C1', severity, file: 'src/widget/ranges.py', line, description, recommendation: severity === 'nit' ? 'note' : 'fix', why: 'test' })
    const { result } = await run({ mode: 'thorough' }, { ...GATED, 'REVIEW:correctness': { findings: [f('nit', 'L22', 'parse_range("3-1") returns [3].'), f('nit', '41', 'Rename the test.')] },
      'REVIEW:conventions': { findings: [f('blocker', '22', "parse_range('3-1') returns [3]!")] } })
    assert.deepEqual(result.gate.reviewFindings.map(x => [x.id, x.severity, x.recommendation]), [['RV1', 'blocker', 'fix'], ['RV2', 'nit', 'note']])
  })
  test('a token budget that runs out as a reviewer starts says so, not the agent cap', async () => {
    const { result } = await run({ mode: 'thorough' }, { 'REVIEW:conventions': () => { throw new Error('Workflow token budget exceeded (500,000 / 500,000 output tokens)') } })
    assert.equal(result.status, 'awaiting-approval')
    assert.ok(result.warnings.includes('The token budget for this turn ran out, so 1 extra reviewer(s) did not run; resume in a new turn for the full review.'), result.warnings.join('\n'))
  })
  test('a head the differential never proved is flagged, never adopted silently', async () => {
    const moved = `HEAD moved from ${implSha(0)} to ${POLISH_SHA} after the last independent check; commits ${implSha(0)}..${POLISH_SHA} were not re-proved by the differential.`
    const blockers = r => (r.gate.findings.length ? r.gate.findings : r.gate.reviewFindings).filter(f => f.severity === 'blocker').map(f => [f.id, f.recommendation])
    // P2 reports a short SHA, or dies after merging: the re-check is skipped and the final check (or R7) reports the polished head.
    for (const [o, gate, id] of [[patch('P2:polish-apply', { finalHead: POLISH_SHA.slice(0, 7) }), 'builtin', 'F1'], [{ 'P2:polish-apply': null }, 'builtin', 'F1'], [{ 'P2:polish-apply': null, ...GATED }, 'no-mistakes', 'RV1']]) {
      const { result, calls } = await run({ mode: 'thorough', gate }, { ...o, ...patch(gate === 'builtin' ? 'FINAL:check' : 'R7:no-mistakes', { headSha: POLISH_SHA }) })
      assert.deepEqual([count(calls, 'R6.5:confirm-polish'), result.headSha, blockers(result)], [0, POLISH_SHA, [[id, 'fix']]], `${gate} ${id}`)
      assert.ok(result.warnings.includes(moved))
    }
    const merged = await run({ mode: 'thorough' }) // P2 merged with a full SHA: the re-check runs as before
    assert.deepEqual([count(merged.calls, 'R6.5:confirm-polish'), merged.result.gate.outcome], [1, 'findings'])
    assert.ok(!merged.result.warnings.some(w => w.startsWith('HEAD moved')))
    const user = (await run({}, patch('FINAL:check', { headSha: POLISH_SHA }))).result // no polish: a warning, no blocker
    assert.deepEqual([user.headSha, user.gate.outcome, user.warnings.includes(moved)], [POLISH_SHA, 'findings', true])
  })
  const steps = (name, status) => ['push', 'pr', 'ci'].map(n => ({ name: n, status: n === name ? status : 'skipped' }))
  for (const [what, g] of [['a running push', { steps: steps('push', 'running') }], ['a completed pr step', { steps: steps('pr', 'completed') }], ['a failed ci step', { steps: steps('ci', 'failed') }], ['outcome went_remote', { outcome: 'went_remote' }]]) {
    test(`R7 with ${what} reports went-remote-without-approval`, async () => {
      const { result } = await r7(g)
      assert.deepEqual([result.status, result.gate.wentRemote], ['went-remote-without-approval', true])
      assert.match(result.next, /tell the user now/)
    })
  }
  test('R7 that omits the publish steps warns; validated_complete is approvable', async () => {
    const { result } = await r7({ steps: [{ name: 'review', status: 'completed' }], outcome: 'validated_complete' })
    assert.equal(result.status, 'awaiting-approval')
    assert.ok(result.warnings.some(w => /did not report the status of every push\/pr\/ci step/.test(w)))
  })
  test('a final check that could not start stops with final-check-failed', async () => {
    const { result } = await run({}, patch('FINAL:check', { ran: false, summary: 'The tree was dirty.' }))
    assert.deepEqual([result.stopped, result.reason], ['final-check-failed', 'The tree was dirty.'])
    assert.match(result.resume, /args\.gateAttempt=1/)
  })
  test("the final check re-checks the confirm step's introduced defects", async () => {
    const { calls } = await run({}, patch('R6.5:confirm', { introducedDefects: ['The docstring still says the end is exclusive.'] }))
    assert.match(find(calls, 'FINAL:check').prompt, /flagged these possible problems in lines the diff added: \["The docstring still says the end is exclusive\."\]/)
  })
  test('local paths and publish commands are scrubbed from the intent', async () => {
    const { calls } = await run({}, { ...GATED, ...patch('R6:impl', { prIntent: `Fixed ${CLONE}/src/widget/ranges.py, then git push origin ${BRANCH} and gh pr create.` }) })
    const intent = find(calls, 'R7:no-mistakes').prompt.split('\nINTENT:\n')[1]
    assert.ok(intent.includes('Fixed <path>') && intent.includes('then publish origin'))
    assert.doesNotMatch(intent, /\/tmp\/|git push|gh pr create/)
  })
})

describe('gate findings: one entry per problem, at the highest severity', () => {
  const f = (id, severity, line, description, file = 'src/widget/ranges.py') => ({ id, severity, file, line, description, recommendation: severity === 'nit' ? 'note' : 'fix', why: 'test' })
  const gate = async (final, correctness = [], conventions = []) => (await run({ mode: 'thorough' }, { ...patch('FINAL:check', { findings: final }), 'REVIEW:correctness': { findings: correctness }, 'REVIEW:conventions': { findings: conventions } })).result.gate
  const rows = g => g.findings.map(x => [x.id, x.severity, x.line])
  test('findings from the final check and both reviewers are merged, de-duplicated and renumbered', async () => {
    const g = await gate([f('F1', 'nit', '17', 'The docstring example could show an inclusive range.'), f('F2', 'should-fix', '3', 'The entry sits under the wrong release.', 'CHANGELOG.md')],
      [f('C1', 'blocker', '22', 'parse_range("3-1") now returns [3] instead of [].'), f('C2', 'nit', '17', 'THE DOCSTRING EXAMPLE could show an inclusive range!')], [f('X', 'nit', '41', 'The test name does not match its neighbours.', 'tests/test_ranges.py')])
    assert.deepEqual(g.findings.map(x => [x.id, x.severity]), [['F1', 'nit'], ['F2', 'should-fix'], ['F3', 'blocker'], ['F4', 'nit']])
    assert.deepEqual([g.outcome, g.findings[0].alsoReported], ['blockers', ['THE DOCSTRING EXAMPLE could show an inclusive range!']])
  })
  test('the same finding with other quotes, a line range, an L prefix or another path spelling is merged once', async () => {
    const say = "The new comment says 'A file outside PATH' but the guard is narrower."
    const g = await gate([f('F1', 'nit', '814', say)], [f('C1', 'nit', '814-816', say.replace(/'/g, '"')), f('C2', 'nit', 'L814', say, './src/widget/ranges.py')],
      [f('X1', 'nit', 'line 814', say, `${WORKTREE}/src/widget/ranges.py`), f('X2', 'nit', '814', say, 'src\\widget\\ranges.py'), f('X3', 'nit', '90', 'An unrelated nit on another line.')])
    assert.deepEqual(rows(g), [['F1', 'nit', '814'], ['F2', 'nit', '90']])
    assert.equal(g.findings[0].alsoReported.length, 4)
  })
  test('a final-check nit and a reviewer blocker for one problem give one blocker', async () => {
    const say = 'parse_range("3-1") now returns [3] instead of [].'
    const g = await gate([f('F1', 'nit', '22', say)], [f('C1', 'blocker', 'L22', say)])
    assert.deepEqual([rows(g), g.findings[0].recommendation, g.outcome], [[['F1', 'blocker', '22']], 'fix', 'blockers'])
  })
  test('the same text on other lines, or two problems on one line with a shared opening, stay separate', async () => {
    const lint = 'This line exceeds the 100-character limit set in pyproject.toml.'
    assert.deepEqual(rows(await gate([f('F1', 'nit', 'L17', lint)], [], [f('X1', 'should-fix', 'L88', lint)])), [['F1', 'nit', 'L17'], ['F2', 'should-fix', 'L88']])
    const doc = [f('F1', 'nit', '17', 'The docstring of parse_range still says the end bound is exclusive.'), f('C1', 'blocker', '17', 'The docstring of parse_range still shows parse_range("1-3") == [1, 2], and the doctest now fails.')]
    assert.deepEqual(rows(await gate([doc[0]], [doc[1]])), [['F1', 'nit', '17'], ['F2', 'blocker', '17']])
  })
  test('the outcome is clean without findings and findings with only non-blockers; a silent reviewer only warns', async () => {
    assert.equal((await gate([])).outcome, 'clean')
    assert.equal((await run({ mode: 'thorough' })).result.gate.outcome, 'findings')
    const { result } = await run({ mode: 'thorough' }, { 'REVIEW:conventions': null })
    assert.equal(result.status, 'awaiting-approval')
    assert.ok(result.warnings.includes('1 extra reviewer(s) returned no result; the final check covers the diff on its own.'))
  })
})

describe('resume overrides: retryNodes and confirmAttempts', () => {
  const SUFFIX = 'running again after it failed in an earlier run: retry'
  test('a malformed map stops with bad-args', async () => {
    for (const extra of [{ retryNodes: 'R4:feasibility#0' }, { retryNodes: ['R4:feasibility#0'] }, { retryNodes: { 'R4:feasibility#0': 0 } }, { retryNodes: { 'R4:feasibility#0': 1.5 } },
      { retryNodes: { 'R4:feasibility#0': 'x' } }, { retryNodes: { '': 1 } }, { retryNodes: { 'R4 feasibility': 1 } }, { retryNodes: '{"R3:scope":' },
      { confirmAttempts: 3 }, { confirmAttempts: { first: 1 } }, { confirmAttempts: { '-1': 1 } }, { confirmAttempts: { 0: -2 } }, { confirmAttempts: [1] }]) {
      assert.match((await noAgents(runArgs(extra), { stopped: 'bad-args' })).reason, /^(retryNodes|confirmAttempts) must /, JSON.stringify(extra))
    }
  })
  test('the maps take JSON text too', async () => {
    const r = await run({ retryNodes: '{"R3:scope":2}' })
    assert.ok(find(r.calls, 'R3:scope').prompt.endsWith(`${SUFFIX} 2.)`))
    assert.ok(!find(r.calls, 'R2:plan').prompt.includes(SUFFIX) && !find(r.calls, 'R1:validate').prompt.includes(SUFFIX))
    const c = await run({ attempts: 2, confirmAttempts: '{"0":1,"1":2}' }, patch('R6.5:confirm', n => (n === 0 ? { redOnBase: false } : undefined)))
    assert.deepEqual(['R6.5:confirm#0', 'R6.5:confirm#1'].map(l => find(c.calls, l).prompt.split(':')[0]), ['R6.5 (confirm, check 2)', 'R6.5 (confirm, check 3)'])
  })
  test("chained agent-failed resumes on two different nodes keep the first node's retry prompt", async () => {
    // R4 and R6:verify each fail until they run as a retry; earlier results replay from the journal, as on a resume.
    const failsFirst = (l, p) => (p.includes(SUFFIX) ? undefined : null)
    const respond = journaled(happy({ 'R4:feasibility': failsFirst, 'R6:verify': failsFirst }))
    const runs = []
    for (let args = runArgs(); runs.length < 4;) {
      runs.push(await runPipeline(args, respond))
      const r = runs.at(-1).result
      if (!r.retryNodes) break
      assert.deepEqual(resumeArg(r, 'retryNodes'), r.retryNodes)
      args = runArgs({ retryNodes: r.retryNodes })
    }
    assert.deepEqual(runs.map(r => r.result.node || r.result.status), ['R4:feasibility#0', 'R6:verify#0', 'awaiting-approval'])
    assert.deepEqual(runs[1].result.retryNodes, { 'R4:feasibility#0': 1, 'R6:verify#0': 1 })
    assert.equal(find(runs[2].calls, 'R4:feasibility#0').prompt, find(runs[1].calls, 'R4:feasibility#0').prompt, 'R4 keeps its retry prompt')
  })
  test('chained tree-damaged stops in two attempts do not alternate', async () => {
    // Attempt 0's check damages the tree and its re-check does not confirm; attempt 1's first check damages the tree too.
    const respond = journaled(happy({ 'R6.5:confirm': (l, p, o, n, def) => {
      const again = /^R6\.5 \(confirm, check \d+\)/.test(p)
      if (l === 'R6.5:confirm#0') return again ? { ...def, redOnBase: false } : { ...def, treeIntact: false }
      if (l === 'R6.5:confirm#1' && !again) return { ...def, treeIntact: false }
    } }))
    const seen = []
    for (let extra = {}; seen.length < 4;) {
      const { result } = await runPipeline(runArgs({ attempts: 3, ...extra }), respond)
      seen.push(result.stopped ? `${result.stopped} ${JSON.stringify(result.confirmAttempts)}` : result.status)
      if (!result.stopped) break
      assert.deepEqual(resumeArg(result, 'confirmAttempts'), result.confirmAttempts)
      extra = { confirmAttempts: result.confirmAttempts }
    }
    assert.deepEqual(seen, ['tree-damaged {"0":1}', 'tree-damaged {"0":1,"1":1}', 'awaiting-approval'])
  })
})
