# Modes and cost

Every run has two dials and an optional model choice:

| Dial | Sets | Values | Default |
|---|---|---|---|
| **Mode** | How much work runs (speed and cost) | `triage`, `quick`, `standard`, `thorough` | `standard` |
| **Effort** | How hard each agent thinks | `low`, `medium`, `high`, `max`, `inherit` | `medium` |
| **Model** | Which model every agent runs on | an alias (`sonnet`, `opus`, `haiku`, `fable`) or a model ID | your session's model |

The values come from `MODES` and `EFFORTS` in [workflows/pipeline.js](../workflows/pipeline.js). You can change the defaults for mode and effort in `/config` ([configuration.md](configuration.md#config-options)).

## Modes

| | triage | quick | standard | thorough |
|---|---|---|---|---|
| Clones the repo | No | Yes | Yes | Yes |
| Reproduction and acceptance test | No | Yes | Yes | Yes |
| Plan and scope | No | One combined step (`R2:plan+scope`) | `R2:plan`, then `R3:scope` | `R2:plan`, then `R3:scope` |
| Feasibility rounds | 0 | 0 | up to 2 | up to 3 |
| Re-scopes after a failed approach | 0 | 0 | 1 | 2 |
| Implementation attempts | 0 | 2 | 3 | 4 |
| Independent check | none | one combined check (`R6:check`: targeted tests + differential) | separate `R6:verify` and `R6.5:confirm` | separate `R6:verify` and `R6.5:confirm` |
| Polish pass | No | only with `polish` | only with `polish` | Yes, with an independent re-check of the polished head |
| Final check tests | none | none beyond the targeted check | test modules for every touched file and package | full suite if it finishes in about 15 minutes, else the touched packages' tests |
| Extra reviewers | 0 | 0 | 0 | 2 (correctness lens, conventions and scope lens), beside either gate |
| Typical agents | 2 | ~10 | ~14 | ~19 |
| Agent cap | 6 | 20 | 40 | 64 |
| Measured time and tokens ([details](#measured-runs)) | 30–60 s, about 90–110k tokens | 7–8 minutes, about 570–580k tokens (2 runs) | 11–12 minutes, about 760–780k tokens (2 runs) | 16–20 minutes, about 1.05–1.14M tokens (2 runs) |

Every mode runs the final check's lint and maintainer-eye review and drafts the PR text, except triage, which stops after viability.

### Measured runs

These figures are measured, not guaranteed. Times vary with the repository's test suite and how long its environment takes to set up.

They were taken with Claude Code 2.1.296, Claude Opus 5.5 as the session model, `effort=medium`, on macOS. Tokens are the total tokens the run's agents processed, as Claude Code's workflow usage reports them; most of them are cached input.

| Run | Agents | Time | Tokens | Notes |
|---|---|---|---|---|
| triage | 2 | 30–60 s | about 90–110k | Measured over 10 runs on real issues. |
| a quick, standard or thorough run that stops at the viability check | 3 | about 1 minute | about 160k | `U1`, `U2` and `U3`, then a stop. |
| quick | 10 | 7–8 minutes | about 570–580k | Two runs on one real issue, both reaching the approval packet: a fix plus a regression test, red on the base and green with the fix. Their agents also ran the whole suite (321 tests, all passed), which quick mode does not require. |
| standard | 14 | 11–12 minutes | about 760–780k | Two runs on the same issue, both reaching the approval packet. The whole suite also passed (322 tests), beyond the affected-module tests that standard mode requires. |
| thorough | 19–20 | 16–20 minutes | about 1.05–1.14M | Two runs on the same issue. The 20-agent run predates the polish re-check (`R6.5:confirm-polish`) and had a second feasibility round after the scope widened; the 19-agent run on the release code ran the re-check, which passed. The full suite passed (322–324 tests), and the final check left only informational notes. |

The six quick, standard and thorough runs (two per mode) used the same real, open bug report in [Pelican](https://github.com/getpelican/pelican), a static site generator with about 13k stars. No pull request was opened.

### What each mode is for

- **triage** answers "is this issue worth taking?" It reads the thread and checks prior art and viability, with no clone. It returns a verdict and a suggested mode. It never asks about cost first.
- **quick** fits a small, clear bug. One skeptical agent checks the fix and runs the differential in a single step.
- **standard** fits most issues. A feasibility spike tests the plan's riskiest assumptions before any code is written, and verify and confirm are separate agents.
- **thorough** fits strict projects or larger changes. It adds a polish pass with a re-check, two extra reviewers and the widest test run.

### Why triage runs first

An issue that looks free often is not. While testing, we triaged 10 open, unassigned bugs with few or no comments on established GitHub projects. 9 already had someone on them:

- 4 had open PRs that show up only in the issue timeline;
- 3 had claims made that same day;
- 1 had a maintainer's unmerged fix branch;
- 1 was self-assigned by its maintainer during the test.

Triage finds these in 30–60 seconds with 2 agents and no clone, before a full run spends far more. This is also why a claim from the last 7 days and an unmerged fix branch stop a run (see [viability](how-it-works.md#viability-in-code-no-agent)).

### Where the typical counts come from

A run with no retries uses these agents:

| Mode | Agents |
|---|---|
| triage (2) | `U2:issue`, `U3:prior-art` |
| quick (10) | `U1:repo`, `U2:issue`, `U3:prior-art`, `GATE-0`, `W1:worktree`, `R1:validate`, `R2:plan+scope`, `R6:impl#0`, `R6:check#0`, `FINAL:check` |
| standard (14) | quick's recon, `GATE-0`, `W1` and `R1`, then `R2:plan`, `R3:scope`, `R4:feasibility#0`, `R5:rescope#0`, `R6:impl#0`, `R6:verify#0`, `R6.5:confirm#0`, `FINAL:check` |
| thorough (19) | standard, plus `P1:polish-review`, `P2:polish-apply`, `R6.5:confirm-polish`, `REVIEW:correctness`, `REVIEW:conventions` |

`R6.5:confirm-polish` runs only when the polish pass merges a change. If P1 finds nothing to polish, P2 and the re-check do not run.

Each retry, extra attempt, extra feasibility round or re-scope adds agents. The `no-mistakes` gate replaces `FINAL:check` with one `R7:no-mistakes` agent. Thorough mode's two extra reviewers run beside either gate, so the count stays the same.

## Effort

Each agent belongs to a node class. The effort level maps each class to a reasoning effort:

| Class | Nodes | low | medium (default) | high | max |
|---|---|---|---|---|---|
| `mech` (bookkeeping) | `W1:worktree`, `W1:discard` | low | low | low | medium |
| `read` (recon and rules) | `U1`, `U2`, `U3`, `GATE-0` | low | medium | medium | high |
| `think` (validate, plan, build, polish) | `R1`, `R2`, `R3`, `R4`, `R5`, `R6:impl`, `P1`, `P2` | medium | high | xhigh | max |
| `check` (verify, confirm, review) | `R6:verify`, `R6:check`, `R6.5:confirm`, `R6.5:confirm-polish`, `FINAL:check`, `REVIEW:*`, `R7:no-mistakes` | medium | high | xhigh | max |

`inherit` sets no per-node effort: every agent uses your session's effort level.

If the model does not support a level, Claude Code falls back to the model's highest supported level at or below it.

## Model

`model=<alias or ID>` runs every agent on that model. Without it, agents use your session's model. `model=session`, `model=default` and `model=inherit` also mean the session's model.

## Keeping usage low

| Step | Why it helps |
|---|---|
| Run `triage` first | Two agents, no clone. It stops before any expensive work when the issue is closed, claimed, already has a PR or work in progress, or the repo rejects AI work. |
| Use `quick` for small bugs | About 10 agents instead of 14, and a cap of 20. |
| Use `effort=low` | Cheaper reasoning in every class. |
| Use `model=sonnet` or `model=haiku` | Smaller models cost less per token, but they may struggle with hard bugs. |
| Set `maxAgents=N` | A hard cap, enforced in code (4 to 200; a value outside that range stops the run with `bad-args`). |
| Watch `/workflows` | It shows progress and per-agent token use, and can pause or stop the run. |
| Resume instead of restarting | Finished steps replay from cache. A fresh run pays for everything again. |

The skill asks once before a run (unless the mode is `triage`, you said `yes`, or you turned off **Ask before running**). The question shows the mode, effort, model, typical agent count and cap, and the time and tokens measured for that mode. It offers a cheaper choice: `Run quick instead` for standard or thorough, or `Triage only` for quick.

The run also stops early, before expensive work, when the issue fails viability, fails validation (`invalid-issue`), the environment cannot be set up (`validate-blocked`), no acceptance test fails on the base (`no-red-test`), or the plan is infeasible.

## The agent cap

Every agent call goes through one function that counts calls, including the single automatic retry. When the count reaches `maxAgents`, the run stops before the next call with:

```
stopped: agent-budget-reached
```

The stop payload says where the work is (worktree, branch, head). To continue, ask Claude to resume the run with a larger `maxAgents` (up to 200). Finished steps replay from cache, but each replayed step still counts toward the cap, so set the new cap above the old one plus the work left.

One exception: thorough mode's two extra reviewers run beside the final check, with either gate. They take only the slots the cap leaves after one for the final check, so near the cap the run still returns the approval packet without them, and `warnings` says how many did not run. If the cap leaves no slot for the final check itself, the run stops with `agent-budget-reached`. At `maxAgents` 200, the maximum, `resume` says a resume cannot go further.

If Claude Code itself refuses another agent because of its own agent or call cap, the run stops with the same code. If Claude Code's token budget for the turn runs out, the run stops with `token-budget-reached` instead. A larger `maxAgents` does not help there: resume in a new turn.

## Requirements for dynamic workflows

resolve-issue runs as a Claude Code dynamic workflow, which needs Claude Code 2.1.275 or later. On the Pro plan, turn on **Dynamic workflows** in `/config` and restart Claude Code. On other paid plans they are on by default. Organization admins can turn workflows off; if `/config` has no such row, ask your admin. See [troubleshooting.md](troubleshooting.md#the-workflow-tool-is-missing).
