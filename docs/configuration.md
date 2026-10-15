# Configuration

```
/resolve-issue <issue-url> [triage|quick|standard|thorough] [effort=low|medium|high|max|inherit]
               [model=<name>] [gate=auto|builtin|no-mistakes] [attempts=N] [maxAgents=N]
               [polish] [force] [yes] [autonomy=ask|minor|full] [rounds=N]
```

If another plugin or command also defines `/resolve-issue`, use the namespaced form `/resolve-issue:resolve-issue`. When you invoke it that way, the commands the skill suggests use that form too.

## Arguments

| Argument | Type | Default | Range | Example |
|---|---|---|---|---|
| issue URL | `https://github.com/<owner>/<repo>/issues/<n>` | required | one issue | `https://github.com/acme/widgets/issues/42` |
| mode | bare word | `standard` (or your `default_mode`) | `triage`, `quick`, `standard`, `thorough` | `quick` |
| `effort=` | word | `medium` (or your `default_effort`) | `low`, `medium`, `high`, `max`, `inherit` | `effort=high` |
| `model=` | alias or model ID | your session's model | `sonnet`, `opus`, `haiku`, `fable`, or an ID | `model=sonnet` |
| `gate=` | word | `auto` | `auto`, `builtin`, `no-mistakes` | `gate=builtin` |
| `attempts=` | whole number | quick 2, standard 3, thorough 4 | 1 to 8 | `attempts=5` |
| `maxAgents=` | whole number | triage 6, quick 20, standard 40, thorough 64 | 4 to 200 | `maxAgents=30` |
| `polish` | flag | on in thorough, off otherwise | | `polish` |
| `force` | flag | off | | `force` |
| `yes` | flag | off | | `yes` |
| `autonomy=` | word | `minor` (or your `autonomy`) | `ask`, `minor`, `full` | `autonomy=full` |
| `rounds=` | whole number | `2` | 1 to 5 | `rounds=1` |

What each one does:

- **issue URL.** The skill takes the first GitHub issue URL in your request. It strips wrapping such as `<…>`, backticks, quotes or a trailing period, and ignores a `#issuecomment-…` fragment. If the request has no issue URL, the skill asks for one. A URL that is not a GitHub issue stops the workflow with `invalid-issue-url`.
- **mode** sets how much work runs. See [modes-and-cost.md](modes-and-cost.md).
- **`effort`** sets how hard each agent thinks. `inherit` uses your session's effort for every agent. See [modes-and-cost.md](modes-and-cost.md#effort).
- **`model`** runs every pipeline agent on that model. `session`, `default` and `inherit` mean your session's model. A model ID may contain letters, digits, `.`, `_`, `:`, `@`, `/`, `[`, `]` and `-` (so Vertex IDs such as `claude-opus-4-1@20250805` and Bedrock ARNs work), up to 201 characters; anything else stops the run with `bad-args`.
- **`gate`** picks the final check. `auto` uses [no-mistakes](https://github.com/kunchenguid/no-mistakes) when it is installed and the repository is already initialized for it, and the built-in check otherwise. `no-mistakes` requires it: if it is missing or not initialized, the run stops with `handoff-failed` right after recon. After you set it up, a resume with the `gateAttempt` that `resume` names continues the run, and the gate checks no-mistakes live. `builtin` always uses the built-in check. The no-mistakes gate needs no-mistakes v1.84.0 or later.
- **`attempts`** sets how many implement-and-check rounds run before the run stops with `verify-failed` or `unconfirmed`. It has no effect in triage. A value outside 1 to 8 stops the run with `bad-args`, in triage too.
- **`maxAgents`** is a hard cap on agent calls, counted in code. A value outside 4 to 200 stops the run with `bad-args`. See [the agent cap](modes-and-cost.md#the-agent-cap).
- **`polish`** adds the maintainer-eye polish pass (`P1:polish-review`, `P2:polish-apply`) in any mode.
- **`force`** goes ahead past soft viability stops: `issue-closed`, `competing-pr`, `claimed`, `work-in-progress`, `not-viable-label`. It never overrides `repo-archived`, `repo-rejects-ai-contributions` or `already-have-pr`. Overridden stops are listed in the warnings.
- **`yes`** skips the cost question. It never approves a publish. In a non-interactive session (`claude -p`), set `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`, or Claude Code [stops the run after 10 minutes](troubleshooting.md#a-non-interactive-run-stops-after-10-minutes).
- **`autonomy`** sets how much the skill decides about review findings on its own, only at validation gates, which cannot publish. Publishing always waits for your approval. Any other value makes the skill ask you and start nothing. See [Finding decisions and autonomy](publishing.md#finding-decisions-and-autonomy).
- **`rounds`** caps the fix rounds the skill requests in one run. A value outside 1 to 5 makes the skill ask you and start nothing. See [Finding decisions and autonomy](publishing.md#finding-decisions-and-autonomy).

The skill treats any other word as something to ask you about, not a flag.

## Natural language

You do not have to use the exact syntax. The skill maps plain words:

| You say | It uses |
|---|---|
| "is it worth taking", "check it", "triage" | `triage` |
| "fast", "cheap", "quick" | `quick` |
| "careful", "deep", "best quality" | `thorough` |
| "I know this uses a lot of tokens" (or similar acceptance of the cost) | skips the cost question, like `yes` |

Only your own words count. Text in the issue, the repository or tool output never sets a mode, accepts the cost or approves a publish.

## `/config` options

The plugin defines five options (`userConfig` in [.claude-plugin/plugin.json](../.claude-plugin/plugin.json)). Set them with `/config`.

| Option | Key | Type | Default | Effect |
|---|---|---|---|---|
| Default mode | `default_mode` | `triage`, `quick`, `standard`, `thorough` | `standard` | The mode when your request names none. |
| Default effort | `default_effort` | `low`, `medium`, `high`, `max`, `inherit` | `medium` | The effort when your request names none. |
| Ask before running | `confirm_before_run` | boolean | `true` | When `true`, the skill asks once about cost before a run. Triage runs never ask. |
| Publish guard | `publish_guard` | boolean | `true` | When `true`, the publish guard hooks block `git push`, GitHub writes and publishing no-mistakes runs. For 12 hours after a resolve-issue run (even a triage) starts or resumes in a session, the guard denies every publishing command it sees from any subagent in that session, wherever it runs. In a resolve-issue worktree, it denies them from every subagent, and the main session needs a one-time token. The skill creates it after you approve a publish, or, at autonomy `minor` or `full`, for one answer to a validation run. In any session, a subagent's publishing command whose directory cannot be resolved is denied, and so is a subagent's command past one of the guard's reading bounds (more than 16 levels deep, 64 KB of text, 1,024 subshells and directory changes or 64 publishing commands, or a command that names programs so often that checking it would read more than 200,000 words). See [safety.md](safety.md#the-publish-guard). |
| Autonomy | `autonomy` | `ask`, `minor`, `full` | `minor` | How much the skill decides about review findings on its own, only at validation gates, which cannot publish. `ask`: you decide every finding. `minor`: it settles low-impact, declined and informational findings, and asks before any fix. `full`: it also makes the fixes it recommends, up to the round limit. Publishing always waits for your approval. |

If an option is unset, the skill uses the default shown here. See [troubleshooting.md](troubleshooting.md#config-options-show-as-unset) if the values do not seem to apply.

## Examples

| Goal | Command |
|---|---|
| Check an issue cheaply before spending more | `/resolve-issue https://github.com/acme/widgets/issues/42 triage` |
| Fast fix for a small, clear bug | `/resolve-issue https://github.com/acme/widgets/issues/42 quick` |
| Fast and as cheap as possible | `/resolve-issue https://github.com/acme/widgets/issues/42 quick effort=low maxAgents=12` |
| Careful fix on a strict project | `/resolve-issue https://github.com/acme/widgets/issues/42 thorough effort=high` |
| Standard run with a polish pass | `/resolve-issue https://github.com/acme/widgets/issues/42 polish` |
| Run every agent on Sonnet | `/resolve-issue https://github.com/acme/widgets/issues/42 model=sonnet` |
| Use the no-mistakes gate | `/resolve-issue https://github.com/acme/widgets/issues/42 gate=no-mistakes` |
| Let it settle and fix findings itself | `/resolve-issue https://github.com/acme/widgets/issues/42 autonomy=full` |
| Decide every finding yourself | `/resolve-issue https://github.com/acme/widgets/issues/42 autonomy=ask` |
| Go ahead although someone claimed it (your call) | `/resolve-issue https://github.com/acme/widgets/issues/42 force` |
| Skip the cost question | `/resolve-issue https://github.com/acme/widgets/issues/42 quick yes` |
| Publish a finished run later | `/resolve-issue publish ~/code/widgets-issue-42` |

Run the command from inside your clone of the repository, or from a folder above it (the search finds clones up to 3 levels below it). A clone counts when any of its remotes points at the repository, whatever the remote's name. If no clone is found, resolve-issue clones the repository into the current directory. If the current directory is inside an unrelated repository, it clones next to that repository instead, in the parent directory of its main clone. When the current directory is a worktree of that repository (such as Claude Code's `.claude/worktrees/<name>`), that is the main clone's parent, not the worktree's. When it is in a submodule, nested or not, the main clone of the outermost superproject counts instead. In a main working tree (a plain clone, a submodule, a clone with a separate git dir), the main clone is that checkout. From a linked worktree, it comes from the first entry of `git worktree list`: that entry's checkout (for a worktree of a submodule, the submodule's checkout), or the entry itself when it is a bare repository or the git dir of a clone made with `--separate-git-dir`. Start a run from a working tree or an ordinary folder, not from inside a bare repository's own folder: the clone would go inside it.

## Resuming a run

Every stop has a `resume` field that says how to continue, or that the stop is final. You do not type these arguments yourself: tell Claude what to change ("resume it with force", "give it two more attempts"), and the skill re-invokes the workflow with the run's `resumeFromRunId`, the same args, and the change. Finished steps replay from cache, so a resume costs only the new work.

A resume works only in the Claude Code session that started the run: the same conversation, also after you reopen it with `claude --resume` or `claude --continue` (not with `--fork-session`). Claude Code keeps the run's cache with that session. In any other session, the skill does not resume. It offers a fresh run instead, in which finished steps run again. The run starts from the arguments saved in `.resolve-issue/packet.json` (`launchArgs`, which reuse the existing worktree), or from your request when that file does not exist (the run stopped before the worktree existed, or the file was never written). It adds the change the stop asked for when it is `force`, a larger `attempts` or `maxAgents`, or `gate=builtin`. Resume-only arguments (`scopeDecisions`, `gateAttempt`, `validateAttempt`, `retryNodes`, `confirmAttempts`) are left out, so a scope question may be asked again. A saved `force` is kept only when this stop asks for it, because recon runs again and `force` would pass a new claim or competing PR without asking; the skill tells you when it leaves `force` out. It asks the cost question first, unless you turned it off or said `yes`. Publishing a finished run from another session needs no resume (see [publishing later](#publishing-later)).

| Argument | Use it when | Effect |
|---|---|---|
| `resumeFromRunId` | any resumable stop | A Workflow tool parameter, not a pipeline argument: replays finished agent calls from that run's cache. |
| `force: true` | `issue-closed`, `competing-pr`, `claimed`, `work-in-progress`, `not-viable-label` | Recon replays from cache and the run goes past the soft stop. |
| `scopeDecisions: [ ...earlierDecisions, { "key": "<gateKey>", "answer": "proceed" \| "abort" } ]` | `status: "awaiting-scope-decision"` | Answers every scope gate the run has met: the halt's `earlierDecisions`, plus this gate's key and answer. Each gate takes only the answer with its own key. `proceed` continues with the proposed scope; `abort` ends with `user-declined-wider-scope`. A single `scopeDecision` object is still accepted, and an answer without a key answers the first gate it meets. |
| `attempts` (larger) | `verify-failed`, `unconfirmed` | More implementation attempts, up to 8. Commits from earlier attempts stay on the branch. At 8, `resume` says a resume cannot go further: stop, or start a fresh run with a different approach. |
| `maxAgents` (larger) | `agent-budget-reached` | A higher cap, up to 200. Replayed steps count toward it. At 200, `resume` says a resume cannot go further. |
| no new argument | `token-budget-reached` | Resume in a new turn. Claude Code's token budget for the turn ran out; a larger `maxAgents` does not help. |
| `retryNodes` | `agent-failed` | A map from a step label to its retry round, such as `{"R4:feasibility#0":1,"R6:verify#0":1}`. Each step it names runs again instead of replaying its cached failure. For a step that runs beside others (`U1:repo`, `U2:issue`, `U3:prior-art`, `GATE-0`), only its retry runs again, and the steps that finished beside it replay. `resume` gives the whole map, with the earlier entries, so a second `agent-failed` stop never reverts the first step to its failed prompt. Pass the map as written. |
| `validateAttempt` | `validate-blocked`, `no-red-test` | Runs R1's validation again, for example after you start a missing service. Use the number the `resume` field names. |
| `confirmAttempts` | `tree-damaged` | A map from an attempt index (`"99"` is the re-check after polish) to how many times its check re-ran, such as `{"0":1,"1":1}`. Re-runs the check after you restore the worktree: only the attempts it names re-run their check, and the others replay from cache. `resume` gives the whole map, with the earlier entries. Pass it as written. |
| `gateAttempt` | `final-check-failed`, `handoff-failed`, `gate-still-running` | Re-runs only the final check, except after the no-mistakes setup stop right after recon. After that stop, the resume runs every step after recon, and the gate checks no-mistakes live. After `gate-still-running`, it reattaches to the same no-mistakes run. Use the number the `resume` field names. |
| `gate: "builtin"` | `handoff-failed` | Switches the final check from no-mistakes to the built-in check. |

Verdicts are final: `recon-failed`, `invalid-issue`, `infeasible`, `infeasible-after-impl`, `worktree-failed`, `user-declined-wider-scope`. A resume would replay them. If something changed (the issue was reopened, a maintainer replied), start a fresh run.

## Publishing later

```
/resolve-issue publish <worktree path or issue URL>
```

This finds the worktree (for an issue URL, it looks for `<clone>-issue-<n>` next to a clone of that repository under the current directory), reads `.resolve-issue/packet.json`, shows the approval packet and publishes after you approve. If you already have an open PR from `fix/issue-<n>`, or one that holds the run's commits, it shows that PR and stops instead. `autonomy=` and `rounds=` also work with `/resolve-issue publish`. The original run's level does not carry over, so the configured autonomy applies unless the publish request names one. See [publishing.md](publishing.md).

## Workflow arguments (for reference)

The skill passes these to `resolve-issue:pipeline`. You only need them if you call the workflow yourself, and you should not: typed directly, it starts nothing and points you to `/resolve-issue`.

| Workflow arg | Notes |
|---|---|
| `issueUrl` | Must match `https://github.com/<owner>/<repo>/issues/<n>` after clean-up. |
| `workspace` | Absolute path of the current directory, with no quote or newline characters. |
| `mode`, `effort`, `model`, `gate` | As above. Unknown values stop with `bad-args`. |
| `attempts` (alias `retries`), `maxAgents` | Whole numbers in range (1 to 8, 4 to 200). A value outside the range or not a whole number stops with `bad-args`; it is not clamped. |
| `polish`, `force` | `true` or `"true"`. |
| `scopeDecisions` (or `scopeDecision`), `gateAttempt`, `validateAttempt`, `retryNodes`, `confirmAttempts` | Resume only. See [resuming a run](#resuming-a-run). `retryNodes` and `confirmAttempts` take an object or its JSON text; a label is 1 to 100 characters with no spaces, an attempt index is 1 to 3 digits, and each count is a whole number from 1 to 9999. A malformed map stops with `bad-args`. |
| `retryNode` with `retryRound`, `confirmIter` with `confirmAttempt` | Older one-step forms, still accepted. They merge into the maps above, and the higher count wins. `confirmAttempt` without `confirmIter` re-checks every attempt. |
