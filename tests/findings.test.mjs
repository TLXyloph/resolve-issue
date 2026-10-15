// Finding recommendations (fix, low-impact, decline, note), the evidence rule for low-impact findings,
// known defects on the no-mistakes gate, the early stop for gate=no-mistakes on a repo that cannot run it,
// and R7's record of the validation runs it starts in strict launch mode.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { run, find, count, labels, baseLabel, patch, withRepo, GATED, STATE_DIR } from './harness.mjs'

const RECS = ['fix', 'low-impact', 'decline', 'note']
const finding = (o = {}) => ({ id: 'F1', severity: 'should-fix', file: 'src/widget/ranges.py', line: '22', description: 'parse_range("3-1") returns [3].', recommendation: 'fix', impact: '', why: 'test', ...o })

describe('finding recommendations', () => {
  test('every finding schema offers fix, low-impact, decline and note, with an impact field', async () => {
    const builtin = (await run({ mode: 'thorough' })).calls
    for (const label of ['FINAL:check', 'REVIEW:correctness', 'REVIEW:conventions']) {
      const item = find(builtin, label).opts.schema.properties.findings.items
      assert.deepEqual(item.properties.recommendation.enum, RECS, label)
      assert.equal(item.properties.impact.type, 'string', label)
    }
    const gate = find((await run({}, GATED)).calls, 'R7:no-mistakes').opts.schema.properties
    assert.deepEqual(gate.findings.items.properties.recommendation.enum, RECS)
    assert.deepEqual(gate.knownDefects.items.properties.recommendation.enum, RECS)
  })
  test('the final check, the extra reviewers and R7 state the low-impact rule and its evidence', async () => {
    const calls = [...(await run({ mode: 'thorough' })).calls, ...(await run({ mode: 'thorough' }, GATED)).calls]
    for (const label of ['FINAL:check', 'REVIEW:correctness', 'REVIEW:conventions', 'R7:no-mistakes']) {
      const p = find(calls, label).prompt
      assert.ok(p.includes('Use low-impact for a real defect in the changed lines that only rare inputs reach.'), label)
      assert.ok(p.includes('A low-impact finding without evidence counts as fix.'), label)
    }
  })
  test('a low-impact finding without evidence counts as fix; with evidence it stays low-impact', async () => {
    const { result } = await run({}, patch('FINAL:check', { findings: [
      finding({ recommendation: 'low-impact', impact: '' }),
      finding({ line: '40', description: 'A label with two dollar amounts loses its dollar signs.', recommendation: 'low-impact', impact: 'Needs two dollar amounts in one label: 0 of 297 labels.' }),
    ] }))
    assert.deepEqual(result.gate.findings.map(f => [f.id, f.recommendation]), [['F1', 'fix'], ['F2', 'low-impact']])
    assert.match(result.gate.findings[0].why, /without evidence, so it counts as fix/)
  })
  test('a repeat keeps the stronger recommendation: fix over low-impact over decline over note', async () => {
    const IMPACT = 'Reversed ranges appear in no doc, test or caller.'
    const cases = [[['decline', ''], ['low-impact', IMPACT], 'low-impact'], [['low-impact', IMPACT], ['fix', ''], 'fix'], [['note', ''], ['decline', ''], 'decline']]
    for (const [[r1, i1], [r2, i2], want] of cases) {
      const { result } = await run({ mode: 'thorough' }, { 'REVIEW:correctness': { findings: [finding({ recommendation: r1, impact: i1 })] }, 'REVIEW:conventions': { findings: [finding({ recommendation: r2, impact: i2 })] } })
      const merged = result.gate.findings.filter(f => f.line === '22')
      assert.deepEqual(merged.map(f => f.recommendation), [want], `${r1} + ${r2}`)
      if (want === 'low-impact') assert.equal(merged[0].impact, IMPACT)
    }
  })
})

describe('known defects on the no-mistakes gate', () => {
  test("R7 gets the independent checker's possible problems, and its real ones join the RV findings", async () => {
    const possible = ['src/widget/ranges.py parse_range: a reversed range "3-1" returns [3].']
    const known = { id: 'K1', severity: 'should-fix', file: 'src/widget/ranges.py', line: '22', description: 'parse_range("3-1") returns [3] instead of [].', recommendation: 'low-impact', impact: 'Reversed ranges appear in no doc, test or caller.', why: 'rare' }
    const { result, calls } = await run({}, { ...GATED, ...patch('R6.5:confirm', { introducedDefects: possible }), ...patch('R7:no-mistakes', { knownDefects: [known] }) })
    assert.ok(find(calls, 'R7:no-mistakes').prompt.includes(JSON.stringify(possible)))
    assert.deepEqual(result.gate.reviewFindings.map(f => [f.id, f.recommendation, f.impact]), [['RV1', 'low-impact', known.impact]])
  })
  test("no-mistakes' own findings keep their ids, and a low-impact one without evidence counts as fix", async () => {
    const own = [{ id: 'r1', severity: 'warning', action: 'auto-fix', file: 'src/widget/ranges.py', line: '22', description: 'd1', recommendation: 'low-impact', impact: '' },
      { id: 'r2', severity: 'info', action: 'no-op', file: 'src/widget/ranges.py', line: '30', description: 'd2', recommendation: 'note', impact: '' }]
    const { result } = await run({}, { ...GATED, ...patch('R7:no-mistakes', { findings: own }) })
    assert.deepEqual(result.gate.findings.map(f => [f.id, f.recommendation]), [['r1', 'fix'], ['r2', 'note']])
  })
})

describe('the validation-run record', () => {
  test('R7 starts each validation run in strict launch mode, records it, and reattaches only to a run the record lists', async () => {
    const prompt = find((await run({}, GATED)).calls, 'R7:no-mistakes').prompt
    const record = `'${STATE_DIR}/validation-runs.txt'`
    assert.ok(prompt.includes(record), 'names the record')
    assert.ok(prompt.includes(`Reattach only when ${record} lists that id`), 'reattaches only to a listed run')
    assert.ok(prompt.includes('leave that run alone and return outcome=not_started'), 'leaves an unlisted run alone')
    assert.ok(prompt.includes(`append it as one line to ${record}`), 'records the run it starts')
    const start = prompt.split('\n').find(l => l.includes('--no-publish-intent --intent')) || ''
    for (const flag of ['--launch-nonce', '--validation-generation']) assert.ok(start.includes(flag), `the start command carries ${flag}`)
  })
})

describe('gate=no-mistakes on a repo that cannot run it', () => {
  for (const noMistakes of [{ installed: false, gated: false }, { installed: true, gated: false }]) {
    test(`stops right after recon when no-mistakes is ${noMistakes.installed ? 'not initialized' : 'not installed'}`, async () => {
      const { result, calls } = await run({ gate: 'no-mistakes' }, withRepo({ noMistakes }))
      assert.equal(result.stopped, 'handoff-failed')
      assert.deepEqual(labels(calls).map(baseLabel).sort(), ['U1:repo', 'U2:issue', 'U3:prior-art'])
    })
  }
  test('a resume with gateAttempt goes on to R7, which checks again', async () => {
    const { result, calls } = await run({ gate: 'no-mistakes', gateAttempt: 1 }, withRepo({ noMistakes: { installed: true, gated: false } }))
    assert.deepEqual([count(calls, 'R7:no-mistakes'), result.status], [1, 'awaiting-approval'])
  })
  test('auto on an ungated repo still uses the built-in check', async () => {
    assert.equal((await run({}, withRepo({ noMistakes: { installed: true, gated: false } }))).result.gate.kind, 'builtin')
  })
})
