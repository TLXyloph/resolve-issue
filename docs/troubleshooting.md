# Troubleshooting

Every stop carries a `stopped` code and a `reason`, except a viability stop, which lists every stop that applies in `reasons`, and `user-declined-wider-scope`, which is your own answer. Every stop after the arguments are accepted also carries a `resume` field that says how to continue or that the stop is final. A finished run carries a `status` and a `next` field instead. Start there. This page explains each code and the common setup problems.

## Statuses

| Status | Meaning | What to do |
|---|---|---|
| `awaiting-approval` | The run finished. The approval packet is ready. | Review it and choose a publish option. See [publishing.md](publishing.md). |
| `triaged` | A triage run finished with a verdict: `takeable` or `not-takeable`. | Run the suggested mode, or `force` past a soft blocker if that is your call. |
| `awaiting-scope-decision` | The responsible fix goes beyond the literal ask: it changes a public API or contract, widens the security surface, contradicts a maintainer, or no code change is responsible. | Read the question, alternatives and recommendation, then answer `Proceed with this scope` or `Abort`. The skill resumes with `scopeDecisions`: the halt's `earlierDecisions`, plus this gate's `gateKey` and your answer. |
| `went-remote-without-approval` | no-mistakes pushed, opened a PR or started CI during validation. | Look at the fork branch and any PR the skill shows you, and decide what to do (for example, close the PR or delete the branch on GitHub). Check your no-mistakes version and config. |

`started: false` (with `reason: "use-the-skill"`) means the workflow was started directly, without the skill's arguments. Run `/resolve-issue <issue-url>` instead.

## Stop codes

### Viability

| Code | Cause | Fix |
|---|---|---|
| `issue-closed` | The issue is not open. | Soft stop. If you still want to fix it, resume with `force`. |
| `competing-pr` | Another contributor's open PR targets the issue and was updated in the last 30 days. | Soft stop. Consider reviewing their PR instead. Going ahead is your call: resume with `force`. |
| `claimed` | Someone claimed the issue in the last 14 days, and they have a PR or branch or a maintainer acknowledged it. Or the claim is from the last 7 days: a claim this recent is presumed active, even without a PR, branch or acknowledgement. A claim whose age recon could not find counts as fresh. | Soft stop. Ask in the thread first. Resume with `force` only if the claim is dead. |
| `work-in-progress` | Someone has an unmerged change to the project's own code that fixes the issue without a PR (a branch or a commit that references the issue, in the repository or a fork), touched in the last 60 days, or at an unknown time. Older work, or a workaround in another repository, is only a warning. | Soft stop. Look at their branch or commit, and ask in the thread whether they plan to open a PR. Resume with `force` only if the work is abandoned. |
| `not-viable-label` | The issue is labeled won't fix, invalid or duplicate. | Soft stop. Resume with `force` only if a maintainer says otherwise. |
| `repo-archived` | The repository is archived. | Hard stop. `force` does not override it. |
| `repo-rejects-ai-contributions` | The contribution policy refuses AI-assisted work, even when a human submits it. | Hard stop. Respect it. `force` does not override it. |
| `already-have-pr` | You already have an open PR for this issue. | Hard stop. resolve-issue does not update existing PRs. Continue on that PR's branch by hand, or close the PR first. |

### Recon and setup

| Code | Cause | Fix |
|---|---|---|
| `recon-failed` | U2 or U3 could not read the issue, U2 reported a different issue number, or U1 could not establish a main clone and a fetched base SHA. | Check `gh auth status`, that the issue exists and is visible to you, and that the clone can fetch from GitHub. Then start a fresh run. |
| `prior-branch-exists` | A `fix/issue-<n>` branch exists locally or on your fork outside resolve-issue's own worktree, or it backs an open PR of yours. | Finish that branch by hand, or delete or rename it (your call), then start a fresh run. The result shows `priorBranchLog`. |
| `worktree-failed` | W1 returned a branch or path other than `fix/issue-<n>` at `<clone>-issue-<n>`. The result shows `worktree`. | A verdict: a resume would replay it. Check `git -C <clone> worktree list` and `git -C <clone> branch --list 'fix/issue-*'`, clean up by hand, then start a fresh run. |
| `invalid-issue-url` | The URL is not `https://github.com/<owner>/<repo>/issues/<number>`. | Pass an issue URL (not a PR or discussion URL). |
| `bad-args` | An argument is invalid: an unknown mode, effort or gate, a malformed model name or resume map (`retryNodes`, `confirmAttempts`), an `attempts` outside 1 to 8 or a `maxAgents` outside 4 to 200 (or either not a whole number), a `scopeDecisions` entry without a key or with an answer other than proceed or abort, or a workspace that is not an absolute path. Out-of-range numbers are rejected, not clamped. | Fix the argument the `reason` names and start again. |

### Validation and planning

| Code | Cause | Fix |
|---|---|---|
| `validate-blocked` | R1 could not set up the environment or a service the tests need (a database, Docker, a GPU, network access, a toolchain). | The worktree is kept. Fix what `reason` names (see [Dependency installs fail](#dependency-installs-fail)), then resume with the `validateAttempt` the `resume` field names. R1 runs again. |
| `invalid-issue` | R1 found the behavior correct (and no clearer message or doc would help), or the issue is already fixed at the base. Environment trouble never leads here; that is `validate-blocked`. | Read `reason` and `draftComment`, a suggested reply you may post yourself. resolve-issue never posts it. The run removed the worktree and branch it created, if they held no work; then `worktreePath` and `branch` are `null`. |
| `no-red-test` | The issue is real, but R1 could not write an acceptance test that fails on the base, so a behavior fix could not be proven. | Resume with the `validateAttempt` the `resume` field names to let R1 try again, or stop here. |
| `infeasible` | The feasibility check hit a hard wall. | Read `reason` and `findings`. This is a verdict; start a fresh run only if something changed. |
| `user-declined-wider-scope` | You answered `abort` at a scope gate. | Final. Start a fresh run if you change your mind. |

### Implementation and checks

| Code | Cause | Fix |
|---|---|---|
| `verify-failed` | No attempt reached a green build, passing change-relevant tests and a fixed reproduction. | Read `lastFailure`. If it points at the environment or a missing service (connection refused, a missing database, Docker, GPU or network), fix that first: more attempts fail the same way (see [Dependency installs fail](#dependency-installs-fail)). Otherwise resume with a larger `attempts` (up to 8). At 8, `resume` says a resume cannot go further: stop, or start a fresh run with a different approach. |
| `unconfirmed` | The targeted check passed, but the independent check did not confirm the fix for its change kind. For a `behavior` change, it needs the acceptance test and the regression test the fix added to fail on the base and pass with the fix, and a test that guards the bug and pins the contract. In quick mode, the reason can also be that the differential (PART 2) ran in no attempt. | Read `confirm` and `lastFailure`. If they point at the environment, fix that first. Otherwise resume with a larger `attempts` (at 8, stop or start a fresh run). |
| `infeasible-after-impl` | A re-scope after a failed approach found no feasible approach. | Read `reason` and `verify`. Final. |
| `tree-damaged` | A check (`R6:check`, `R6.5:confirm` or `R6.5:confirm-polish`) left the worktree dirty or off the expected head. A quick-mode check that never reached the differential uses up an attempt; it is not this stop. | Inspect `git -C '<worktree>' status` and `git -C '<worktree>' log --oneline <baseSha>..HEAD`. Restore the tree to the head the `resume` field names, then resume with the `confirmAttempts` map it names. It keeps the earlier entries, so only the attempts it names re-run their check. |

### Final check

| Code | Cause | Fix |
|---|---|---|
| `final-check-failed` | The built-in final check's precondition failed: a dirty tree, the wrong branch, or a head that does not contain the confirmed commit. | Fix the cause, then resume with the `gateAttempt` the `resume` field names. Only the final check re-runs. |
| `handoff-failed` | With `gate=no-mistakes`: no-mistakes is not installed, the repository is not initialized for it, or the validation run did not start or failed. When no-mistakes is missing or not initialized, the stop comes right after recon. The validation run also does not start when another no-mistakes run is active on the branch, and `.resolve-issue/validation-runs.txt` does not list it. That run may be one you started by hand, or a publish run. It may also be the pipeline's own run, if the pipeline stopped before recording it. A no-mistakes version older than v1.84.0 can reject a flag of `axi run`, such as `--launch-nonce`, so the validation run does not start. | If the run started and failed (`gate.steps` shows a failed step, and `resume` says so), read `gate.steps` and `gate.findings` and fix that cause first: a resume starts a new validation run on the same head. If `reason` says another no-mistakes run is active on the branch, finish or abort it in no-mistakes, then resume. If `reason` reports an unknown flag, such as `--launch-nonce`, update no-mistakes to v1.84.0 or later, then resume. Otherwise run the `gate.setupCommands` shown (your call; for example `no-mistakes init`). Then resume with the `gateAttempt` named; the resume continues the run, and the gate checks no-mistakes live. Or resume with `gate: "builtin"`. |
| `gate-still-running` | The no-mistakes validation run was still going after the last reattach. | Resume later with the `gateAttempt` the `resume` field names. The final check reattaches to the same no-mistakes run. |

### Budget and agents

| Code | Cause | Fix |
|---|---|---|
| `agent-budget-reached` | The run used its `maxAgents` cap, or Claude Code refused another agent because of its own agent or call cap. | Resume with a larger `maxAgents` (up to 200), or stop here. Replayed steps count toward the cap. At 200, `resume` says a resume cannot go further: stop, or start a fresh run. See [modes-and-cost.md](modes-and-cost.md#the-agent-cap). |
| `token-budget-reached` | Claude Code's token budget for the turn ran out. This is not the agent cap. | Resume in a new turn, as the `resume` field says. A larger `maxAgents` does not help. |
| `agent-failed` | One agent returned no result twice: an API error, a stall, or the agent was skipped. The result names the `node`. | Usually transient. Wait a few minutes, then resume with the same args plus the `retryNodes` map the `resume` field names, so the failed step runs again instead of replaying its failure from cache. The map keeps every step an earlier resume retried. If it fails twice more, report it. |

## Setup problems

### The Workflow tool is missing

The skill stops with: "resolve-issue runs as a Claude Code dynamic workflow, and this session doesn't have the Workflow tool."

- Update Claude Code to 2.1.275 or later (`claude update`).
- On the Pro plan, turn on **Dynamic workflows** in `/config` and restart Claude Code.
- If `/config` has no such row, workflows are off for your account or organization. Ask your admin.

### gh is not logged in

The skill runs `gh auth status` before starting and stops if `gh` is missing or not logged in to github.com. Install the [GitHub CLI](https://cli.github.com/) and run:

```
gh auth login
```

Also check `git --version`: resolve-issue needs git 2.31 or later. The no-mistakes gate's publish step needs git 2.38 or later, because its upstream check uses `git merge-tree --write-tree`; with older git, that check is treated as a conflict. The no-mistakes gate needs no-mistakes v1.84.0 or later.

### `/resolve-issue` runs a different command

Another plugin or a custom command uses the same name. Use the namespaced form:

```
/resolve-issue:resolve-issue <issue-url>
```

The commands the skill then suggests (for example `/resolve-issue:resolve-issue publish <worktree>`) use the same form.

### Config options show as unset

The skill reads your `/config` values when it loads. If a value is blank or still shows a `${…}` placeholder, the skill treats the option as unset and uses the default: `standard`, `medium`, ask before running, autonomy `minor`. To fix it:

- set the option again in `/config`;
- restart Claude Code so the skill picks up the new value;
- update Claude Code if the values never apply.

The publish guard reads `publish_guard` separately and defaults to on.

### The guard blocks a push

The message starts with `resolve-issue publish guard:`.

- **From a pipeline agent:** expected. For 12 hours after a resolve-issue run starts or resumes in your session, the guard denies every publishing command it sees from any subagent in the session, wherever it runs. In a resolve-issue worktree, it denies them from every subagent. See [the next section](#a-subagent-is-blocked-hours-after-a-run) if the subagent has nothing to do with the run.
- **From the main session after you approved:** the skill must run `touch '<worktree>/.resolve-issue/publish-approved'` as its own command right before each publishing command, and run that command with the worktree as its directory. A token covers one tool call. Ask Claude to create a new token and retry.
- **"the approval token was older than 15 minutes":** the token expired and the guard removed it. Approve again, then retry.
- **Before you approved:** expected. Review the packet and approve first.
- **"its directory cannot be resolved":** a subagent ran a publishing command from a directory the guard cannot work out: a variable or a command substitution (`cd "$WT"`, `cd "$(git rev-parse --show-toplevel)"`, `git -C "$PWD"`), a folder that does not exist yet (the command may create it, or the `cd` may fail), a `cd -` before any `cd`, a `pushd` with no argument when nothing was pushed, a quoted or escaped `~` or `$HOME` that the shell does not expand (`cd "~/x"`, `cd '$HOME/x'`), or a path longer than 4,096 bytes as written or 1,024 bytes once resolved. This rule applies in every session and repository while the guard is on, so it can also stop a subagent that has nothing to do with resolve-issue. Use a literal path to a folder that exists; create a new folder first, in a separate command.
- **A command that only mentions publishing** in another program's arguments, such as `man git push`, counts as a push. Quote the text (`'git push'`). The plain arguments of `echo`, `printf`, `grep` and a few others are not read; a `$( )` or backticks inside them still is.
- **"a command nested more than 16 levels deep", "a command too long to check (more than 65536 bytes to read)", "a command with more than 1024 subshells and directory changes", "a command with more than 64 publishing commands" or "a command too complex to check" (one that names programs so often that checking it would read more than 200,000 words):** the over-limit rule. The guard does not read past these bounds, because the rest of the command could publish from anywhere. A subagent may not run such a command at all; this applies to any subagent, in every session and repository, while the guard is on, so it can also stop a subagent that has nothing to do with resolve-issue. The main session's command is judged in the directory where reading stopped. Split the command, or write long text to a file first (Claude's Write tool) and pass the file.

If the message reads "could not parse this command, so it was blocked to be safe", the guard's parser itself failed, so the hook blocked the command rather than let it through unchecked. Ask Claude to run the command in a simpler form (for example, without nested quoting). If it keeps happening, report it; turning the guard off is your call.

The guard is a Claude Code hook, so it only checks commands Claude runs. Pushing from your own terminal is not affected. To turn it off, set **Publish guard** (`publish_guard`) to `false` in `/config`. See [safety.md](safety.md#the-publish-guard).

### A subagent is blocked hours after a run

The message reads "a resolve-issue run started in this session within the last 12 hours, so no subagent in this session may publish". When a resolve-issue run starts or resumes, even a 30-second triage, the guard records the session. For the next 12 hours it denies every publishing command from every subagent in that session, including subagents that have nothing to do with the run. Nothing clears the record when the run ends.

To lift the rule early, when no resolve-issue run is going in the session:

- Delete the session's record, the file `runs/<session_id>` in the plugin's data folder (the folder Claude Code passes to hooks as `CLAUDE_PLUGIN_DATA`). For a marketplace install, that is usually `~/.claude/plugins/data/resolve-issue-resolve-issue/`; with `claude --plugin-dir`, `~/.claude/plugins/data/resolve-issue-inline/`. The session ID is the name of the session's transcript file under `~/.claude/projects/`. Deleting every file in `runs/` lifts the rule in all sessions.
- Or turn **Publish guard** (`publish_guard`) off in `/config` for that work, and back on afterwards.

Or run the publishing command from the main session instead of a subagent: the run rule does not apply to it.

### A run stalls

- Open `/workflows` to see which agent is running, its progress and its token use. You can pause or stop the run there.
- resolve-issue does not set `stallMs`, so each agent uses Claude Code's default stall timeout. An agent that stalls or is skipped returns no result; resolve-issue retries a required step once (the label ends in `~retry`), and a second failure stops the run with `agent-failed`. Steps that run side by side (`U1` to `U3`, and `GATE-0` beside `W1` and `R1`) make their retry after they all return, in a fixed order, so a resume replays them and every later step from cache.
- The optional steps, `P1:polish-review`, `P2:polish-apply`, `REVIEW:correctness` and `REVIEW:conventions`, are not retried, so skipping one in `/workflows` is respected; the packet says what did not run.
- To recover, resume with the same args plus the `retryNodes` map the `resume` field names. Finished steps replay from cache, and the failed step runs again. For a step that ran side by side, the map marks only its retry, so the steps that finished beside it replay too.

### A non-interactive run stops after 10 minutes

In a non-interactive session (`claude -p`), the run ends as stopped or killed before it returns its result. Claude Code 2.1.296 writes this message to stderr:

```
Background tasks still running 10m after the last turn (workflow …); stopping them. Set CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 to wait indefinitely.
```

In a non-interactive session, Claude Code stops background tasks 10 minutes after the session's last turn. The skill ends its turn right after it starts the run. So Claude Code stops any run that takes longer than 10 minutes, such as a standard run (about 11 to 12 minutes).

To let the run finish, set `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` when you start Claude Code. Use `0` for no limit, or a number of milliseconds longer than the run:

```
CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 claude -p "/resolve-issue <issue-url> yes"
```

### Dependency installs fail

When no usable environment exists (common for a fresh clone), R1 creates one for the worktree only: a virtualenv in `<worktree>/.resolve-issue/venv` with an editable install of the worktree and its test dependencies (Python), the lockfile install inside the worktree (Node), or the toolchain's own fetch (Rust, Go). When an environment exists but lacks a declared dependency, R1 installs just that one into `<worktree>/.resolve-issue/site` (Python, with `--no-deps`). R1 is told never to install into your main clone's environment, a shared virtualenv or your global environment (a prompt, not a control). If R1 still cannot set up the environment or a service the tests need, the run stops with `validate-blocked` and keeps the worktree. When that happens:

- Set up the project's development environment in your main clone first, the way CONTRIBUTING describes. U1 looks for an existing compatible interpreter or virtualenv, such as the clone's `.venv`, and R1 uses it instead of creating one.
- Start any services the tests need (database, Docker). The packet's warnings list what U1 found under services.
- Check network access to the package registry and any private registry credentials.
- Then resume with the `validateAttempt` the `resume` field names, so R1 runs again. Or start a fresh run: if the earlier run made the worktree, the new run resumes it instead of creating another.

Failures caused by a missing optional dependency or by the environment are listed as ignored, not as failures caused by the change.

### Windows

Windows is untested. The publish guard needs `sh` and `awk`, and the prompts use POSIX shell commands. The workflow accepts drive-letter paths, but nothing else has been checked. If you try it, WSL provides `sh`, `awk` and POSIX paths.

## The gate keeps finding new edge cases

Each review is a fresh pass, so it can find what an earlier pass missed. Code with many rules has many rare inputs. Each fix adds rules, so the next review has more to find.

What ends the loop:

- **`autonomy`.** At `minor` (the default), the skill settles low-impact, declined and informational findings on its own. At `full`, it also makes the fixes it recommends. Set it in `/config`, or add `autonomy=<level>` to the request. Publishing always waits for your approval.
- **The round limit.** `rounds=N` (1 to 5, default 2) caps the fix rounds the skill requests in one run. After the cap, the skill settles the remaining low-impact, declined and informational findings, and asks you about any fix finding. At `ask` and `minor`, the cap is advisory: past it, the skill recommends settling instead of another fix round. The cap never changes the recommendation for a crash, hang, data loss, security problem or failing test: those stay fix.
- **The decision log.** `<worktree>/.resolve-issue/decisions.json` keeps each decision. When the gate lists a finding again, the skill applies the logged decision and does not ask again. In the publish run, it still shows the finding and waits for you.
- **Low-impact findings.** A real defect that only rare inputs reach can ship as a low-impact finding, with evidence. The PR's Notes list it under "Known limitations".

See [Finding decisions and autonomy](publishing.md#finding-decisions-and-autonomy).

## A resume re-ran steps that had finished

A resume replays calls from the cache until the first call whose prompt changed. That call and every later one run again, and they cost time and tokens again. Updating the plugin between a stop and its resume can change prompts. To keep the cached steps, resume a stopped run before you update the plugin.
