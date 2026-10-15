// Tests for hooks/publish-guard.sh and hooks/run-marker.sh: feed them PreToolUse hook JSON the way Claude Code
// does and check that publishing is denied (exit 2) where it must be and everything else passes.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, realpathSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks')
const GUARD = join(HOOKS, 'publish-guard.sh')
const MARKER = join(HOOKS, 'run-marker.sh')
const SID = 'sess-1111-2222'

// Set up at module level, not in before(): on Node 20.0 the first tests start before a top-level before() runs.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'ri-guard-')))
const repo = join(root, 'repo')
const git = (...a) => execFileSync('git', a, { stdio: 'pipe' })
git('init', '-q', '-b', 'main', repo)
git('-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init')
const wt = join(root, 'repo-issue-7')
git('-C', repo, 'worktree', 'add', '-q', '-b', 'fix/issue-7', wt)
const state = join(wt, '.resolve-issue')
mkdirSync(state)
mkdirSync(join(wt, 'src'))
const other = join(root, 'other')
git('init', '-q', other)
const data = join(root, 'plugin-data')
after(() => rmSync(root, { recursive: true, force: true }))

let n = 0
function hookInput(command, { cwd = wt, agent = '', tuid = `toolu_${++n}`, sid = SID, tool = 'Bash' } = {}) {
  const input = { session_id: sid, cwd, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: tool === 'Bash' ? { command, description: 'test' } : { title: 'x' }, tool_use_id: tuid }
  if (agent) Object.assign(input, { agent_id: agent, agent_type: 'workflow-subagent' })
  return JSON.stringify(input)
}
const hookEnv = (env = {}) => ({ ...process.env, CLAUDE_PLUGIN_DATA: data, ...env })
function guard(command, { env, ...opts } = {}) {
  const r = spawnSync('sh', [GUARD], { input: hookInput(command, opts), encoding: 'utf8', env: hookEnv(env) })
  return { code: r.status, stderr: r.stderr }
}
const guardAsync = input => new Promise(resolve => { // for hook processes that run at the same time
  const p = spawn('sh', [GUARD], { env: hookEnv() })
  let stderr = ''
  p.stderr.on('data', d => { stderr += d })
  p.on('close', code => resolve({ code, stderr }))
  p.stdin.end(input)
})
const guardJson = input => { // a hook input written out in full
  const r = spawnSync('sh', [GUARD], { input: JSON.stringify(input), encoding: 'utf8', env: hookEnv() })
  return { code: r.status, stderr: r.stderr }
}
const denied = (cmd, opts) => assert.equal(guard(cmd, opts).code, 2, `expected DENY: ${cmd}`)
const allowed = (cmd, opts) => { const r = guard(cmd, opts); assert.equal(r.code, 0, `expected ALLOW (got ${r.code}: ${r.stderr}): ${cmd}`) }
const AGENT = { agent: 'agent-1' }
const markRun = (sid = SID) => { mkdirSync(join(data, 'runs'), { recursive: true }); writeFileSync(join(data, 'runs', sid), '') }
const clearRuns = () => rmSync(join(data, 'runs'), { recursive: true, force: true })
const age = (file, minutes) => { const t = new Date(Date.now() - minutes * 60_000); utimesSync(file, t, t) }

// Both rules read the command the same way: check it as a subagent during a run (in an unrelated repo) and as the
// main session in the worktree with no token.
const RULES = { 'a subagent during a run': { ...AGENT, cwd: other }, 'the main session in the worktree': {} }
function underBothRules(deny, cmds) {
  markRun()
  try {
    for (const [who, opts] of Object.entries(RULES)) for (const cmd of cmds) {
      const r = guard(cmd, opts)
      assert.equal(r.code, deny ? 2 : 0, `${who}: expected ${deny ? 'DENY' : 'ALLOW'} (got ${r.code}: ${r.stderr}): ${JSON.stringify(cmd)}`)
    }
  } finally { clearRuns() }
}
const deniedByBoth = cmds => underBothRules(true, cmds)
const allowedByBoth = cmds => underBothRules(false, cmds)
// Claude Code's own commit idiom: the message is a quoted heredoc inside a double-quoted $( )
const commitIdiom = msg => `git commit -m "$(cat <<'EOF'\n${msg}\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF\n)"`

// ── The worktree rule
test('git push from inside the worktree is denied', () => denied('git push origin fix/issue-7'))
test('cd into the worktree, then push, is denied', () => denied(`cd '${wt}' && git push origin fix/issue-7`, { cwd: root }))
test('git -C <worktree> push is denied', () => denied(`git -C '${wt}' push https://github.com/me/repo.git fix/issue-7`, { cwd: root }))
test('a push from a subdirectory with git -c options is denied', () => denied(`cd ${wt}/src; git status && git -c core.x=y push`, { cwd: root }))
test('a push in a subshell is denied', () => denied(`(cd '${wt}' && git push)`, { cwd: root }))
test('a push from an unrelated repository is allowed', () => allowed('git push origin main', { cwd: other }))
test('a push with a relative cd out of the worktree is judged by the new directory', () => allowed('cd ../other && git push', { cwd: wt }))
test('a cd inside a subshell or $( ) does not change the directory of a later push', () => {
  denied(`base=$(cd '${repo}' && git rev-parse HEAD); git push origin fix/issue-7`)
  denied(`(cd '${other}' && echo hi); git push origin fix/issue-7`)
  denied("x=`cd /tmp && pwd`; git push origin fix/issue-7")
  denied(`v="$(cd '${other}' && pwd)"; git push origin fix/issue-7`)
})
test('cd -, pushd and popd are followed back into the worktree', () => {
  for (const opts of [{}, AGENT]) {
    denied('cd /tmp && cd - >/dev/null && git push origin x', opts)
    denied('pushd /tmp >/dev/null && popd >/dev/null && git push origin x', opts)
    denied('pushd /tmp >/dev/null && pushd >/dev/null && git push origin x', opts) // no argument: swap the top two
    denied(`cd /tmp && (cd '${other}') && cd - >/dev/null && git push origin x`, opts) // a subshell's cd stays inside
    denied(`pushd /tmp >/dev/null && (pushd '${other}') && popd >/dev/null && git push origin x`, opts)
  }
  allowed(`cd '${other}' && cd /tmp && cd - >/dev/null && git push origin x`)
  allowed(`pushd '${other}' >/dev/null && git push origin x`)
})
test('a popd past what the command pushed changes nothing, as in a fresh shell', () => {
  for (const opts of [{ cwd: other }, { ...AGENT, cwd: other }]) {
    denied(`cd '${wt}'; cd /tmp; popd 2>/dev/null; cd - >/dev/null; git push origin fix/issue-7`, opts)
    allowed(`pushd /tmp && popd && popd; git push origin x`, opts)
  }
})
test('cd - before any cd, and pushd with no argument when nothing was pushed, cannot be resolved', () => {
  for (const cmd of ['cd - && git push origin x', 'pushd && git push origin x', `cd '${wt}'; cd /tmp; pushd 2>/dev/null; cd - >/dev/null; git push origin x`]) {
    denied(cmd, { ...AGENT, cwd: other })
    allowed(cmd, { cwd: other })
  }
})
test('a cd to a folder that does not exist yet cannot be resolved: the command may create it, or the cd may fail', () => {
  const missing = join(root, 'missing')
  for (const cmd of [`cd '${missing}'; git push origin fix/issue-7`, `mkdir -p '${wt}/new' && cd '${wt}/new' && git push origin fix/issue-7`,
    `mkdir -p '${wt}/new' && git -C '${wt}/new' push origin fix/issue-7`]) {
    const r = guard(cmd, { ...AGENT, sid: 'a-session-with-no-run' }) // a subagent in the worktree, in a session with no run
    assert.equal(r.code, 2, `expected DENY: ${cmd}`)
    assert.match(r.stderr, /its directory cannot be resolved/)
    allowed(cmd, { cwd: other }) // the main session passes the unknown-directory rule
  }
})
test('a cd run as a program of its own does not move the shell; a cd in eval does, and one in sh -c does not', () => {
  for (const cmd of ['env cd /tmp; git push origin fix/issue-7', 'nice cd /tmp && git push origin fix/issue-7', 'timeout 5 cd /tmp; git push origin fix/issue-7', 'sudo cd /tmp; git push origin fix/issue-7']) {
    denied(cmd) // the main session in the worktree is still in the worktree
    denied(cmd, { ...AGENT, sid: 'a-session-with-no-run' })
  }
  allowed('command cd /tmp; git push origin x') // command and builtin run the shell's own cd
  for (const cmd of [`eval "cd '${wt}'"; git push origin fix/issue-7`, `eval cd "'${wt}'" && git push origin fix/issue-7`]) {
    denied(cmd, { cwd: other })
    denied(cmd, { ...AGENT, cwd: other, sid: 'a-session-with-no-run' })
  }
  allowed("eval 'cd /tmp'; git push origin x")
  allowed(`sh -c "cd '${wt}'"; git push origin x`, { cwd: other })
})
test('a path that holds a newline cannot be resolved', () => {
  for (const cmd of [`cd '/tmp\n${wt}'; git push origin fix/issue-7`, `git -C '/tmp\n${wt}' push origin fix/issue-7`]) {
    const r = guard(cmd, { ...AGENT, cwd: other, sid: 'a-session-with-no-run' })
    assert.equal(r.code, 2, `expected DENY: ${JSON.stringify(cmd)}`)
    assert.match(r.stderr, /its directory cannot be resolved/)
  }
})

test('a quoted or escaped ~ or $HOME is not expanded by the shell, so it names a folder that does not exist', () => {
  for (const cmd of ['cd "~"; git push origin fix/issue-7', "cd '$HOME'; git push origin fix/issue-7", 'cd \\~; git push origin fix/issue-7']) {
    const r = guard(cmd, { ...AGENT, sid: 'a-session-with-no-run' }) // a subagent in the worktree: the cd fails and the push runs there
    assert.equal(r.code, 2, `expected DENY: ${cmd}`)
    assert.match(r.stderr, /its directory cannot be resolved/)
  }
  allowed('cd ~; git push origin x', { ...AGENT, sid: 'a-session-with-no-run' }) // unquoted, the shell goes home
})

test('read-only gh commands are allowed', () => {
  allowed('gh pr view 12 --json title')
  allowed('gh issue view 3 --repo o/r --comments')
  allowed('gh api repos/o/r/issues/1/timeline --paginate')
  allowed("gh api graphql -f query='query { viewer { login } }'")
  allowed('gh repo view o/r --json isArchived')
  allowed('gh release list --repo o/r')
})
test('GitHub writes are denied', () => {
  denied('gh pr create --repo o/r --title x --body-file b')
  denied('gh -R o/r issue comment 3 --body hi')
  denied('gh repo fork o/r --clone=false')
  denied('gh api -X POST repos/o/r/issues/1/comments -f body=hi')
  denied('gh api repos/o/r/issues/1/comments -f body=hi') // fields imply POST
  denied('gh api --method=PATCH repos/o/r/pulls/2')
  denied("gh api graphql -f query='mutation { addComment }'")
  denied('gh pr edit 5 --title "$(cat title.txt)" --body-file body.md')
  denied('gh release create v1 --repo o/r')
  denied('gh workflow run ci.yml --repo o/r')
  denied('gh run rerun 123 --repo o/r')
  denied('gh label create bug --repo o/r')
  denied('gh gist create notes.md')
})
test("gh's own aliases and newer subcommands count as writes, and its reads pass", () => {
  deniedByBoth(['gh pr new --fill', 'gh issue new --title x --body y', 'gh release new v1.2.3 --generate-notes', 'gh repo new me/x --private',
    'gh gist new notes.md', 'gh secret remove TOKEN', 'gh variable remove X', 'gh pr revert 12', 'gh discussion comment 5 --body x',
    'gh agent-task create "fix issue 7"', 'gh project item-add 1 --owner o --url u', 'gh issue subissue add 3 4', 'gh repo deploy-key add k.pub'])
  allowedByBoth(['gh pr view 12', 'gh pr checks 12', 'gh pr diff 12', 'gh pr checkout 12', 'gh issue list --label bug', 'gh run view 1 --log',
    'gh run watch 1', 'gh release download v1', 'gh repo clone o/r', 'gh issue subissue list 3', 'gh variable get X', 'gh project item-list 1', 'gh repo deploy-key list'])
})
test('the gh-axi wrapper is read like gh, and a hook rule sends it to the guard', () => {
  deniedByBoth(['npx -y gh-axi pr create --title x --body-file b.md', 'gh-axi issue comment 7 --body-file c.md', 'npx gh-axi@latest pr merge 12 --squash',
    'npx -y gh-axi api POST repos/o/r/issues --field title=x', 'gh-axi stack submit --open'])
  allowedByBoth(['npx -y gh-axi pr view 12', 'gh-axi issue list', 'gh-axi stack view', 'npx -y gh-axi run view 123 --log-failed'])
  const rules = JSON.parse(readFileSync(join(HOOKS, 'hooks.json'), 'utf8')).hooks.PreToolUse.find(e => e.matcher === 'Bash').hooks.map(h => h.if)
  assert.ok(rules.includes('Bash(*gh-axi*)'), rules.join(' '))
})
test('help requests are not publishing, but a -h that takes a value is not help', () => {
  allowedByBoth(['git push --help', 'git push -h', 'gh pr create --help', 'gh pr create -h', 'hub pull-request --help', 'G=git; $G push --help'])
  deniedByBoth(['git push origin fix/issue-7 -- --help', // after --, --help is a refspec
    'hub pull-request -b main -h fix/issue-7 -m x', 'hub create -d demo -h https://example.com me/x', // hub's -h is --head or --homepage
    'gh repo edit -h https://example.com', 'gh repo create me/x --public -h https://x.dev', // and so is gh repo's
    'npx -y gh-axi pr create --title x --body-file b.md -h']) // gh-axi passes -h on as a flag
})
test('gh skill publish counts as a write; gh-axi api defaults to GET; attached gh api values are not options', () => {
  deniedByBoth(['gh skill publish --tag v1.0.0'])
  allowedByBoth(['gh skill list', 'gh skill search x', 'npx -y gh-axi stack trunk',
    'npx -y gh-axi api GET search/issues --field q="repo:o/r is:open"', 'npx -y gh-axi api /repos/o/r/pulls --field state=closed',
    'gh api -H"X-GitHub-Api-Version: 2022-11-28" repos/o/r/issues/7/comments', "gh api repos/o/r/pulls -q'.[].head.ref'",
    "gh api -H'Accept: application/vnd.github.diff' repos/o/r/pulls/1"])
})
test('curl writes to GitHub are denied; reads are allowed', () => {
  denied('curl -X POST https://api.github.com/repos/o/r/issues/1/comments -d \'{"body":"hi"}\'')
  denied('curl --json \'{"title":"x"}\' https://api.github.com/repos/o/r/pulls')
  allowed('curl -s https://api.github.com/repos/o/r')
})
test('curl writes in clustered short options are denied; -G turns a body into a query', () => {
  deniedByBoth([
    'curl -sX POST https://api.github.com/repos/o/r/issues',
    "curl -sd '{}' https://api.github.com/repos/o/r/issues",
    'curl -XPOST https://api.github.com/repos/o/r/issues',
    'curl -sSX PATCH https://api.github.com/repos/o/r/issues/1',
    'curl -sXPOST https://api.github.com/repos/o/r/issues',
    'curl -sF a=b https://api.github.com/repos/o/r/issues',
    'curl -sT f https://uploads.github.com/repos/o/r/releases/1/assets',
    'curl -G -X POST -d q=x https://api.github.com/repos/o/r/issues', // -X sets a write method
  ])
  allowedByBoth([
    'curl -G -d q=x https://api.github.com/search/issues',
    'curl -sG --data-urlencode q=x https://api.github.com/search/issues',
    'curl -s https://api.github.com/repos/o/r',
    'curl -XGET https://api.github.com/repos/o/r',
  ])
})
test('a write counts as going to GitHub only when a request URL is on GitHub, not when a body or header names it', () => {
  allowedByBoth([
    `curl -X POST http://localhost:8000/api/analyze -H 'Content-Type: application/json' -d '{"repo_url": "https://github.com/psf/requests"}'`,
    `curl -sS -d '{"url":"https://github.com/o/r/pull/1"}' https://example.com/api/links`,
    "curl -s -X POST localhost:3000/webhook -d @payload.json -H 'X-GitHub-Event: push' -H 'Referer: https://github.com/o/r'",
    `curl -fsS http://127.0.0.1:5000/repos --json '{"name":"r","clone_url":"https://github.com/o/r.git"}'`,
    "wget -qO- --post-data='repo=https://github.com/o/r' http://localhost:8000/import",
    'curl -X POST https://api.github.com.example.org/x -d y',
  ])
  deniedByBoth(['curl -sd x api.github.com/repos/o/r/issues', 'curl --url https://api.github.com/repos/o/r/issues -X POST',
    "curl -H 'Accept: x' -d @f https://uploads.github.com/x", 'curl -u me:token -X DELETE https://api.github.com/repos/o/r/git/refs/heads/x',
    'wget --post-data x https://api.github.com/x', 'wget --method=DELETE https://api.github.com/repos/o/r'])
})
test('chained git -C, env -S and gh api option clusters are read', () => {
  denied(`git -C '${root}' -C repo-issue-7 push origin fix/issue-7`, { ...AGENT, cwd: other, sid: 'a-session-with-no-run' }) // each -C is relative to the last
  deniedByBoth(["env -S 'git push origin fix/issue-7'", "time -p env -S 'git push origin fix/issue-7'", 'gh api -iX POST repos/o/r/issues', 'gh api -iF title=x repos/o/r/issues'])
  allowed('time cd /tmp; git push origin x') // from the worktree: the time keyword runs cd in the shell
  denied('/usr/bin/time cd /tmp; git push origin fix/issue-7') // /usr/bin/time runs cd as a program of its own
})
test('a command that only mentions publishing is allowed', () => allowed(`echo 'git push origin main' && grep -r 'gh pr create' .`))
test('the arguments of a program that never runs them are not read for publishing', () => {
  allowedByBoth(['echo git push origin main', 'printf "%s\\n" gh pr create', 'grep -rn -e git -e push src/', 'which git gh hub', 'type git'])
  deniedByBoth(['echo hi && git push origin fix/issue-7', 'echo "$(git push origin fix/issue-7)"', 'echo $(git push origin fix/issue-7)',
    'grep -q x f || git push origin fix/issue-7', 'find . -name x -exec git push \\;'])
})

test('publishing hidden behind a shell -c, eval, a full path, a wrapper or a keyword is denied', () => {
  denied("sh -c 'git push origin fix/issue-7'")
  denied(`bash -lc "cd '${wt}' && git push"`, { cwd: root })
  denied('eval git push origin fix/issue-7')
  denied('eval "git push origin fix/issue-7"')
  denied('/usr/bin/git push origin fix/issue-7')
  denied('command git push')
  denied('GIT_TERMINAL_PROMPT=0 git push origin fix/issue-7')
  denied("zsh -c \"gh pr create --repo o/r --title t --body b\"")
  denied('nice -n 10 git push origin fix/issue-7')
  denied('timeout 30 git push origin fix/issue-7')
  denied('sudo -u someone git push origin fix/issue-7')
  denied('if git push origin fix/issue-7; then echo ok; fi')
  denied('! git push origin fix/issue-7')
  denied('{ git push origin fix/issue-7; }')
  denied('git -c alias.p=push p origin fix/issue-7')
})
test('a shell option that takes an argument does not hide the -c script', () => {
  deniedByBoth([
    "bash -o pipefail -c 'git push'",
    "bash -euo pipefail -c 'git push'",
    "bash -O extglob -c 'git push'",
    "sh -o errexit -c 'git push'",
    "bash -co pipefail 'git push'", // -c inside a cluster that ends in o
    "bash --rcfile /dev/null -c 'git push'",
    "bash +e -c 'git push'",
    "sh -c -- 'git push'",
    "bash -oc pipefail 'git push'", // an o before the c still takes the next word
    "bash -eoc pipefail 'git push origin fix/issue-7'",
    "bash -xoc pipefail 'git push'",
    "bash -Oc extglob 'git push'",
  ])
  allowedByBoth(["bash -o pipefail -c 'git status | head -3'"])
})
test('nested shells, evals and substitutions are read to 16 levels; deeper counts as publishing', () => {
  deniedByBoth([String.raw`sh -c "sh -c \"sh -c 'git push'\""`, String.raw`eval "eval \"eval 'git push'\""`, `${'echo "$('.repeat(15)}git push${')"'.repeat(15)}`])
  const deep = [`${'echo "$('.repeat(17)}date${')"'.repeat(17)}`, `${'('.repeat(17)}true${')'.repeat(17)}`,
    `case x in a) ;; b) ;; c) ;; esac; ${'echo "$('.repeat(17)}date${')"'.repeat(17)}`] // a stray ) does not buy extra levels
  markRun()
  try {
    for (const cmd of deep) {
      const r = guard(cmd, { ...AGENT, cwd: other })
      assert.equal(r.code, 2, `expected DENY: ${cmd}`)
      assert.match(r.stderr, /a command nested more than 16 levels deep/)
    }
  } finally { clearRuns() }
  for (const cmd of deep) allowed(cmd, { cwd: other }) // the main session, outside any worktree, with no run
})
test('ordinary nested substitutions are read, not refused', () => allowedByBoth([
  'PARENT="$(dirname "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")")"; echo "$PARENT"',
  'cd "$(dirname "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")")" && ls',
  'echo "Branch: $(git -C "$(dirname "$(git rev-parse --git-common-dir)")" branch --show-current)"',
  `bash -c 'echo "$(dirname "$(pwd)")"'`,
  `git commit -m "$(printf 'fix: %s' "$(git log -1 --format=%s "$(git merge-base HEAD main)")")"`,
]))
test('a command too long to check counts as publishing, and is refused in time', () => {
  const big = n => `echo "${'The quick brown fox jumps over the lazy dog. '.repeat(Math.ceil(n / 45))}"`
  allowedByBoth([big(60_000)])
  markRun()
  try {
    const nested = `echo "$(echo "${'x'.repeat(40_000)}")"` // 40 KB, read twice: once in the quotes, once in the $( )
    for (const cmd of [big(70_000), nested, big(500_000), `${'('.repeat(5000)}git push${')'.repeat(5000)}`]) {
      const t0 = Date.now(), r = guard(cmd, { ...AGENT, cwd: other })
      assert.equal(r.code, 2, `expected DENY for a ${cmd.length}-character command`)
      assert.match(r.stderr, /a command too long to check|nested more than 16 levels deep/)
      assert.ok(Date.now() - t0 < 8000, `took ${Date.now() - t0} ms for a ${cmd.length}-character command`)
    }
  } finally { clearRuns() }
  allowed(big(70_000), { cwd: other }) // the main session, outside any worktree
})
test('the unread rest of an over-limit command could publish anywhere, so a subagent may never run it', () => {
  for (const pre of [`${'('.repeat(17)}true${')'.repeat(17)}`, `echo "$(echo "${'x'.repeat(40_000)}")"`]) {
    for (const cmd of [`(cd /tmp && ${pre}); cd '${wt}' && git push origin fix/issue-7`, `cd /tmp && ${pre}; cd '${wt}' && git push origin fix/issue-7`]) {
      const r = guard(cmd, { ...AGENT, cwd: other, sid: 'a-session-with-no-run' })
      assert.equal(r.code, 2, `expected DENY: ${cmd.slice(0, 80)}`)
      assert.match(r.stderr, /the guard does not read past this bound/)
    }
    denied(`${pre}; git push origin fix/issue-7`) // the main session in the worktree, without a token
    allowed(`${pre}; git push origin main`, { cwd: other }) // the main session outside any worktree
  }
})
test('a command with too many subshells, directory changes or publishing commands counts as publishing, and is refused in time', () => {
  const tail = `cd '${wt}' && git push origin fix/issue-7`
  for (const [cmd, why] of [
    [`${'cd /tmp\n'.repeat(1100)}${tail}`, /a command with more than 1024 subshells and directory changes/],
    [`${'(:)\n'.repeat(1100)}${tail}`, /a command with more than 1024 subshells and directory changes/],
    [`${'git push\n'.repeat(1500)}${tail}`, /a command with more than 64 publishing commands/],
    [`cd /${'a'.repeat(4000)}; ${'pushd . >/dev/null 2>&1; '.repeat(100)}(:); ${tail}`, /resolve-issue worktree/],
    [`cat ${'<<A'.repeat(21_000)}; ${tail}\n`, /resolve-issue worktree/], // a line of heredocs: one pass over the line
    [`${'curl '.repeat(13_000)}; ${tail}`, /a command too complex to check/], // a program named thousands of times in one command
    [`${'gh api '.repeat(9_000)}; ${tail}`, /a command too complex to check/],
    [`${'curl '.repeat(100)}-${'a'.repeat(64_000)}; ${tail}`, /resolve-issue worktree/], // a long option cluster, read once per curl
    [`${'wget '.repeat(100)}-${'z'.repeat(64_000)}; ${tail}`, /resolve-issue worktree/],
  ]) {
    const t0 = Date.now(), r = guard(cmd, { ...AGENT, cwd: other, sid: 'a-session-with-no-run' })
    assert.equal(r.code, 2, `expected DENY: ${cmd.slice(0, 60)}`)
    assert.match(r.stderr, why)
    assert.ok(Date.now() - t0 < 8000, `took ${Date.now() - t0} ms: ${cmd.slice(0, 60)}`)
  }
})
test('the text bound counts bytes, whatever the awk and the locale', () => {
  const cmd = `cat > notes.zh.md <<'EOF'\n# 发布流程 (git push)\n${'发布'.repeat(12_500)}\nEOF` // 25,000 characters, 75,000 bytes
  for (const LANG of ['en_US.UTF-8', 'C']) {
    const r = guard(cmd, { ...AGENT, cwd: other, sid: 'a-session-with-no-run', env: { LANG, LC_ALL: '' } })
    assert.equal(r.code, 2, `LANG=${LANG}: ${r.stderr}`)
    assert.match(r.stderr, /more than 65536 bytes to read/)
  }
})
test('a command computed at run time, hub and wget writes count as publishing (fail-safe)', () => {
  denied('git $(echo push) origin fix/issue-7')
  denied('p=push; git $p origin fix/issue-7')
  denied('G=git; $G push origin fix/issue-7')
  denied('hub pull-request -m "x"')
  denied('hub push origin fix/issue-7')
  denied("wget --post-data='{}' https://api.github.com/repos/o/r/issues")
  allowed('git $(echo log) --oneline -1', { cwd: other })
  allowed('hub browse', { cwd: other })
})
test('a program computed at run time is read like git: it publishes when its subcommand is push', () => {
  deniedByBoth(['G=git; $G -C . push', 'G=git; $G --no-pager push', 'G=git; $G -c alias.p=push p', '"$GIT" push origin fix/issue-7'])
  allowedByBoth(['PY=python3; $PY -m pytest tests -k push -q', '"$VIRTUAL_ENV/bin/python" -m pytest -k push', '${PYTHON:-python3} -m pytest -q -k push'])
  denied(`G=git; $G -C '${wt}' push origin fix/issue-7`, { ...AGENT, cwd: other, sid: 'a-session-with-no-run' }) // its -C directory counts
})
test('a backslash-newline continuation does not hide a push', () => {
  denied(`git status && \\\n  git push origin fix/issue-7`)
  denied(`git -C '${wt}' \\\n  push origin fix/issue-7`, { cwd: root })
  denied('gh pr "cre\\\nate" --title t --body b')
})
test('harmless commands inside a shell -c are allowed', () => {
  allowed(`sh -c 'echo "git push"'`) // a mention is data
  allowed("bash -c 'gh pr view 1 --json title'")
  allowed("sh -c 'git status && git log --oneline -3'")
})

// ── Command substitution inside double quotes, comments and heredocs
test('publishing inside a double-quoted $( ) or backticks is denied', () => deniedByBoth([
  'out="$(git push origin fix/issue-7 2>&1)"; echo "$out"',
  'echo "$(git push)"',
  'echo "`git push`"',
  'url="$(gh pr create --title t --body b)" && echo "$url"',
  `printf '%s\\n' "$(gh api -X POST repos/o/r/issues/1/comments -f body=hi)"`,
  'if ! out="$(git push -u origin HEAD 2>&1)"; then echo "$out"; fi',
  'echo "done: $(echo "$(git push origin fix/issue-7)")"',
  `${commitIdiom('fix: x')} && git push origin fix/issue-7`,
  `out="$((cd '${wt}' && git push origin fix/issue-7) 2>&1)"; echo "$out"`, // $(( that does not close as )) is a $( ( ) )
  'echo "$((git push) )"',
  'cat <<EOF\n$((git push) 2>&1)\nEOF',
]))
test('a double-quoted $( ) that does not publish is allowed, and so are arithmetic and escaped or single-quoted forms', () => allowedByBoth([
  'no-mistakes axi run --skip push,pr,ci --no-publish-intent --intent "$(cat intent.txt)"',
  commitIdiom('fix: handle git push errors'),
  commitIdiom(`fix: don't crash when "git push" fails (closes #7)\n\nThe retry now wraps gh pr create.`),
  'git commit -m "$(cat title.txt)" -m "$(cat body.md)"',
  'echo "$((1 + 2))"',
  'echo "$(( (1 + 2) * 3 ))" "$(( $(date +%s) % 7 ))"',
  'echo "\\$(git push)"',
  "echo '$(git push)'",
  'echo "pid $$(git push) is text in double quotes"',
]))
test('a # comment or a heredoc body with an apostrophe does not hide a later push', () => deniedByBoth([
  "git commit -q -F - <<'EOF'\nfix: don't crash on empty config\nEOF\ngit push origin fix/issue-7",
  "cat > /tmp/msg <<'EOF'\nIt's fixed\nEOF\ngit commit -F /tmp/msg && git push",
  "# Let's push the branch now\ngit push origin fix/issue-7",
  "git status # what's changed\ngit push origin fix/issue-7",
  "git add -A  # stage what's new\ngit push -u origin HEAD",
  "cat > body.md <<'EOF'\nDon't merge yet\nEOF\ngh pr create --title x --body-file body.md",
  "cat <<-EOF\n\tdon't\n\tEOF\ngit push origin fix/issue-7", // <<- strips leading tabs
  "cat <<A <<'B'\nit's\nA\ndon't\nB\ngit push origin fix/issue-7", // two heredocs on one line, in order
  'cat <<<EOF\ngit push origin fix/issue-7\nEOF', // <<< is a here-string, not a heredoc
  'echo a#b && git push origin fix/issue-7', // a # inside a word is not a comment
  'echo ${#v} $# && git push origin fix/issue-7',
  'x=$((1<<2))\ngit push origin fix/issue-7', // << inside $(( )) is a shift
  'x=`date # now`; git push origin fix/issue-7', // a comment inside backticks ends at the backtick
  "echo $'don\\'t'; git push origin fix/issue-7", // $'…' escapes its quote
  "echo $$'a\\'; git push origin fix/issue-7; echo 'b'", // $$ is the PID, so the ' after it opens a plain quote
  'cat <<EOF\nx\nEO\\\nF\ngit push origin fix/issue-7\nEOF', // a backslash-newline joins the delimiter line
]))
test('a heredoc body is parsed as commands where it can run: an unquoted $( ), a shell reading it, sh -c or eval', () => deniedByBoth([
  'cat <<EOF\nresult: $(git push origin fix/issue-7)\nEOF',
  'cat <<EOF\nresult: `git push origin fix/issue-7`\nEOF',
  "bash <<'EOF'\ngit push origin fix/issue-7\nEOF",
  "cat <<'EOF' | sh\ngit push origin fix/issue-7\nEOF",
  `eval "$(cat <<'EOF'\ngit push origin fix/issue-7\nEOF\n)"`,
  `sh -c "$(cat <<'EOF'\ngit push origin fix/issue-7\nEOF\n)"`,
]))
test('a heredoc body is commands when a shell is named in its own command or later on its line, and data otherwise', () => {
  const notes = 'Next: run `git push` from the worktree, then `gh pr create --fill`.\ngit push origin fix/issue-7\ngh pr create --fill'
  deniedByBoth([
    `cat > f.sh <<'EOF' && bash f.sh\n${notes}\nEOF`,
    `ssh host bash <<'EOF'\n${notes}\nEOF`,
    `bash 2>&1 <<'EOF'\n${notes}\nEOF`, // the & of a redirection does not end the command
    `source <(cat <<'EOF'\n${notes}\nEOF\n)`,
  ])
  allowedByBoth([
    `source .venv/bin/activate && python - <<'EOF'\nprint(${JSON.stringify(notes)})\nEOF`,
    `cd '${wt}' && source .venv/bin/activate && cat > '${state}/notes.md' <<'EOF'\n${notes}\nEOF`,
    `eval "$(conda shell.bash hook)" && conda activate dev && cat > notes.md <<'EOF'\n${notes}\nEOF`,
    `bash scripts/check.sh > out; cat > summary.md <<'EOF'\n${notes}\nEOF`,
  ])
})
test('a here-string given to a shell runs as commands', () => {
  deniedByBoth(["bash <<< 'git push origin fix/issue-7'", 'bash <<<"gh pr create --fill"', 'sh -s x <<< "git push origin fix/issue-7"',
    "bash 2>&1 <<< 'git push origin fix/issue-7'", "bash 2>/dev/null <<< 'git push origin fix/issue-7'", 'sh > out.log <<< "git push origin fix/issue-7"'])
  allowedByBoth(["bash <<< 'git status'", "cat <<< 'git push'", "bash script.sh <<< 'git push'", "bash script.sh 2>&1 <<< 'git push'"]) // these feed a script's stdin
})
test("a heredoc on a loop's, group's or subshell's closer feeds the whole of it", () => {
  deniedByBoth([
    "while read -r c; do eval \"$c\"; done <<'EOF'\ngit push origin fix/issue-7\nEOF",
    "{ read -r c; sh -c \"$c\"; } <<'EOF'\ngit push origin fix/issue-7\nEOF",
    "if true; then sh; fi <<'EOF'\ngit push origin fix/issue-7\nEOF",
    "(read -r c; sh -c \"$c\"; echo ok) <<'EOF'\ngit push origin fix/issue-7\nEOF",
    "while read -r cmd; do eval \"$cmd\"; \\\ndone <<'EOF'\ngit push origin fix/issue-7\nEOF",
    "while read -r c; do\n  eval \"$c\"\ndone <<'EOF'\ngit push origin fix/issue-7\nEOF", // the loop starts on an earlier line
  ])
  allowedByBoth(["while read -r f; do echo \"$f\"; done <<'EOF'\ngit push origin main\nEOF", "(cd src && cat) <<'EOF'\ngit push origin main\nEOF"])
})
test('a heredoc body or a comment that only mentions publishing is allowed', () => allowedByBoth([
  "git commit -F - <<'EOF'\nfix: handle push errors\n\ngit push now retries on 5xx.\nEOF",
  "cat > tests/test_cli.sh <<'EOF'\n#!/bin/sh\ngit push origin main\nEOF",
  'cat <<EOF\nrun \\`git push\\` or \\$(git push) when ready\nEOF',
  'git status # then git push origin main',
  'cat <<EOF\n$(date) gh pr create is next\nEOF',
]))

test('no-mistakes: validation runs are allowed, publishing runs are denied', () => {
  allowed(`no-mistakes axi run --skip push,pr,ci --no-publish-intent --intent "$(cat '${state}/intent.txt')"`)
  allowed('no-mistakes axi run --skip=push,pr,ci,lint --intent x')
  allowed('no-mistakes axi run --wait 8m') // reattach, no --intent
  allowed('no-mistakes status')
  denied('no-mistakes axi run --skip test,document,lint --no-publish-intent --intent "$(cat x)"')
  denied('no-mistakes axi run --skip push,pr,ci --skip test --intent x') // the last --skip wins
  denied('no-mistakes axi respond --action approve')
  denied('no-mistakes axi run --skip push,pr,ci --intent x --yes')
})

// ── The approval token (main session, worktree rule)
test('the approval token allows one main-session tool call, shared by every hook process of that call', () => {
  writeFileSync(join(state, 'publish-approved'), '')
  allowed('git push origin fix/issue-7', { tuid: 'toolu_shared' })
  allowed('git push origin fix/issue-7', { tuid: 'toolu_shared' }) // a second hook entry for the same call
  assert.ok(existsSync(join(state, 'publish-approved.used.toolu_shared')))
  denied('git push origin fix/issue-7', { tuid: 'toolu_next' }) // consumed
})
test('every hook process of an approved tool call allows it, though they all race for the token', async () => {
  const token = join(state, 'publish-approved')
  for (let round = 1; round <= 30; round++) {
    writeFileSync(token, '')
    const input = hookInput('git push origin fix/issue-7', { tuid: `toolu_race_${round}` })
    const results = await Promise.all(Array.from({ length: 8 }, () => guardAsync(input))) // the 8 Bash hook entries
    for (const r of results) assert.equal(r.code, 0, `round ${round}: ${r.stderr}`)
    assert.ok(!existsSync(token) && existsSync(join(state, `publish-approved.used.toolu_race_${round}`)))
  }
})
test('an approval token older than 15 minutes is refused and removed', () => {
  writeFileSync(join(state, 'publish-approved'), '')
  age(join(state, 'publish-approved'), 20)
  const r = guard('git push origin fix/issue-7')
  assert.equal(r.code, 2)
  assert.match(r.stderr, /older than 15 minutes/)
  assert.ok(!existsSync(join(state, 'publish-approved')))
})
test('subagents are denied in a worktree even with a token, and do not consume it', () => {
  writeFileSync(join(state, 'publish-approved'), '')
  const r = guard('git push origin fix/issue-7', AGENT)
  assert.equal(r.code, 2)
  assert.match(r.stderr, /Subagents never publish from a resolve-issue worktree/)
  assert.ok(existsSync(join(state, 'publish-approved')), 'a subagent must not consume the token')
  rmSync(join(state, 'publish-approved'))
})
test('the deny message tells the main session how to approve', () => {
  const r = guard('gh pr create --repo o/r')
  assert.equal(r.code, 2)
  assert.match(r.stderr, /explicitly approves/)
  assert.ok(r.stderr.includes(`touch '${join(state, 'publish-approved')}'`))
})

// ── The run rule (subagents for 12 hours after a run starts in the session)
test('during a run, a subagent may not publish anywhere: the main clone, another repo, or with --repo', () => {
  markRun()
  try {
    denied(`git -C '${repo}' push origin fix/issue-7`, { ...AGENT, cwd: root })
    denied('git push origin main', { ...AGENT, cwd: other })
    denied('gh pr create --repo o/r --title t --body b', { ...AGENT, cwd: root })
    denied('gh issue comment 1 --repo o/r --body hi', { ...AGENT, cwd: root })
    allowed('gh issue view 1 --repo o/r', { ...AGENT, cwd: root }) // reads are fine
    allowed('git push origin main', { cwd: other }) // the main session is not affected by the run rule
  } finally { clearRuns() }
})
test('the run rule is scoped to its session and expires after 12 hours', () => {
  markRun()
  try {
    allowed('git push origin main', { ...AGENT, cwd: other, sid: 'another-session' })
    age(join(data, 'runs', SID), 13 * 60)
    allowed('git push origin main', { ...AGENT, cwd: other })
  } finally { clearRuns() }
})
test('the run-rule message says a run started in the last 12 hours, not that one is active', () => {
  markRun()
  try {
    for (const r of [guard('git push origin main', { ...AGENT, cwd: other }), guard('', { ...AGENT, tool: 'mcp__github__create_pull_request', cwd: root })]) {
      assert.equal(r.code, 2)
      assert.match(r.stderr, /a resolve-issue run started in this session within the last 12 hours, so no subagent in this session may publish \(docs\/troubleshooting\.md says how to lift this early\)/)
      assert.doesNotMatch(r.stderr, /is active/)
    }
  } finally { clearRuns() }
})
test('during a run, a subagent may not call a GitHub MCP write tool; reads, other servers and the main session are fine', () => {
  const mcp = (tool, opts = AGENT) => guard('', { ...opts, tool, cwd: root }).code
  markRun()
  try {
    for (const t of ['get_issue', 'get_issue_comments', 'get_pull_request_reviews', 'list_labels', 'issue_read', 'pull_request_read', 'search_issues', 'download_workflow_run_artifact']) {
      assert.equal(mcp(`mcp__github__${t}`), 0, `expected ALLOW: ${t}`)
    }
    for (const t of ['create_pull_request', 'add_issue_comment', 'run_workflow', 'rerun_failed_jobs', 'cancel_workflow_run', 'issue_write', 'star_repository', 'push_files', 'reprioritize_sub_issue', 'actions_run_trigger']) {
      assert.equal(mcp(`mcp__github__${t}`), 2, `expected DENY: ${t}`)
    }
    assert.equal(mcp('mcp__plugin_engineering_github__create_issue'), 2)
    assert.equal(mcp('mcp__GitHub__github_create_issue'), 2) // case-insensitive, github_ prefix stripped
    assert.equal(mcp('mcp__acme__github_merge_pull_request'), 2) // a github_ tool on another server
    assert.equal(mcp('mcp__linear__create_issue'), 0)
    assert.equal(mcp('mcp__github__create_pull_request', {}), 0) // the main session
  } finally { clearRuns() }
  assert.equal(mcp('mcp__github__create_pull_request'), 0) // no run
})
test('an MCP tool is judged by its name whatever the size of its input; a command field is read like a Bash command', () => {
  const call = (tool, tool_input, { agent = '', cwd = wt, sid = SID } = {}) =>
    guardJson({ session_id: sid, cwd, ...(agent ? { agent_id: agent, agent_type: 'workflow-subagent' } : {}), hook_event_name: 'PreToolUse', tool_name: tool, tool_input, tool_use_id: `toolu_${++n}` }).code
  const big = { title: 'notes', content: 'x'.repeat(140_000) }
  markRun()
  try {
    assert.equal(call('mcp__claude_ai_Google_Drive__create_file', big, { agent: 'agent-1', cwd: other }), 0) // a subagent during a run
    assert.equal(call('mcp__claude_ai_Google_Drive__create_file', big, { agent: 'agent-1', cwd: other, sid: 'a-session-with-no-run' }), 0)
    assert.equal(call('mcp__claude_ai_Google_Drive__create_file', big), 0) // the main session in the worktree
    const push = { command: 'git push origin fix/issue-7' }
    assert.equal(call('mcp__desktop-commander__start_process', push), 2) // the main session in the worktree, without a token
    assert.equal(call('mcp__desktop-commander__start_process', push, { agent: 'agent-1', cwd: other }), 2) // a subagent during a run
    assert.equal(call('mcp__desktop-commander__start_process', push, { cwd: other }), 0) // the main session elsewhere
  } finally { clearRuns() }
})
test('in any session and repository, a subagent publishing from a directory that cannot be resolved is denied; the main session is not', () => {
  for (const cmd of ['cd "$SOMEWHERE" && git push origin x', 'cd "$(git rev-parse --show-toplevel)" && git push origin main', 'git -C "$PWD" push origin main']) {
    const r = guard(cmd, { ...AGENT, cwd: other, sid: 'a-session-with-no-run' })
    assert.equal(r.code, 2, `expected DENY: ${cmd}`)
    assert.match(r.stderr, /its directory cannot be resolved/)
    allowed(cmd, { cwd: other })
  }
  allowed(`cd "$HOME" && echo ok`, { ...AGENT, cwd: other })
})

test('run-marker.sh records a resolve-issue workflow start for the session, and ignores other workflows', () => {
  const run = tool_input => spawnSync('sh', [MARKER], { input: JSON.stringify({ session_id: 'sess-marker-1', tool_name: 'Workflow', tool_input }), encoding: 'utf8', env: hookEnv() })
  assert.equal(run({ name: 'some-other:workflow', args: {} }).status, 0)
  assert.ok(!existsSync(join(data, 'runs', 'sess-marker-1')))
  assert.equal(run({ name: 'resolve-issue:pipeline', args: { issueUrl: 'https://github.com/o/r/issues/1' } }).status, 0)
  assert.ok(existsSync(join(data, 'runs', 'sess-marker-1')))
  clearRuns()
  assert.equal(run({ scriptPath: '/x/plugins/cache/resolve-issue/resolve-issue/1.0.0/workflows/pipeline.js', args: {} }).status, 0)
  assert.ok(existsSync(join(data, 'runs', 'sess-marker-1')))
  clearRuns()
})

test('the publish_guard option turns the guard off', () => allowed('git push origin fix/issue-7', { env: { CLAUDE_PLUGIN_OPTION_PUBLISH_GUARD: 'false' } }))

test('a string value that equals a key name does not hide the command', () => {
  const input = { session_id: SID, cwd: wt, agent_id: 'agent-1', agent_type: 'command', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin fix/issue-7', description: 'cwd' }, tool_use_id: 'toolu_decoy' }
  assert.equal(guardJson(input).code, 2)
})
test('escaped JSON (quotes, newlines, unicode) is decoded before parsing', () => {
  denied(`echo "a \\"quoted\\" word" \n git push origin fix/issue-7`)
  allowed('echo "naïve ✓" && gh pr list')
})

test('used tokens are left as an audit trail', () => {
  const used = readdirSync(state).filter(f => f.startsWith('publish-approved.used.'))
  assert.ok(used.length >= 1)
})
