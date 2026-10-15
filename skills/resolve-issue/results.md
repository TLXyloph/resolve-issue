# Presenting a resolve-issue result

The workflow returns one JSON object. Find its outcome below and follow that section. Quote stop reasons and findings as they are; do not soften or re-judge them. Every result except `bad-args`, `invalid-issue-url` and `started: false` carries `run` (mode, effort, model, gate, `agentsUsed`, `maxAgents`): mention the agent count in one line at the end.

## `status: "awaiting-approval"`: the approval packet

This is the checkpoint the whole run builds toward. Show the user, in one message:

1. **What changed and why**: `title`, `impl.summary`, `changeKind` (behavior, diagnostics or docs), `impl.deferred` and anything listed as deliberately unchanged.
2. **Test evidence**: `verify.commands`; the differential in `confirm`: the acceptance test and the regression test the fix added both fail on the base and pass with the fix (`redOnBase`, `intreeRedOnBase`, `greenWithFix`), or behavior is preserved for diagnostics and docs changes; `attempts`; `polish` (if `polish.reconfirmed` is `false`, the polish commits failed their re-check: say so first); `gate.tests` and `gate.lint` (built-in gate only); and the evidence files in `evidence.outputDir` (`base-*.txt` and `head-*.txt`). Read those files if the user asks for the actual output.
3. **What will be published**: the exact diff, `git -C '<worktreePath>' diff <baseSha>...HEAD`, and the commits the push will publish, verbatim: `git -C '<worktreePath>' log --format='--- %h %an <%ae>%n%B' <baseSha>..HEAD`. For a no-mistakes gate, also show `gate.gateCommits`: what the gate itself added.
4. **Findings**: every item in `gate.findings` (and `gate.reviewFindings` on the no-mistakes gate, numbered `RV1`, `RV2`, …), verbatim (id, severity, file, line, description). On the no-mistakes gate, `gate.reviewFindings` also holds the independent checker's possible problems that R7 found real. Repeats within `gate.reviewFindings`, and within `gate.findings` on the built-in gate, are already merged: `alsoReported` holds the other reports' wording. no-mistakes' own `gate.findings` come as it reported them: when several describe the same problem on the same lines, show it once and list all their ids. When a no-mistakes finding and an `RV` finding describe the same problem on the same lines, show it once and list both ids. Give each finding one recommendation, and group them in this order: fix, low-impact, decline, note. A finding from the workflow already carries one: agree, or explain why not. A finding from a later gate round carries none: recommend one by the same test.
   - **fix** when any of these hold:
     - the changed lines give a wrong result, crash or regress on realistic inputs;
     - a test fails because of the change;
     - the diff made a doc, docstring or changelog line false;
   - **low-impact** when the finding passes the low-impact test in [Deciding findings](#deciding-findings); show its evidence (`impact`);
   - **decline** (and say why in the PR body's Notes) when it asks for new validation or restrictions, coverage of items left unchanged on purpose, or revisits a stated decision;
   - **note** when it is informational, or a defect the base already had that the diff neither introduced nor made reachable. After the findings, list each note finding again as a follow-up suggestion, one line each. Keep follow-up suggestions out of the PR body.
5. **The PR text**: read and show `prTitlePath` and `prBodyPath`. Then list `warnings` and the `constraints` checklist (DCO sign-off, CLA, draft required, human testing required, the AI-disclosure line if the repository asks for one).

First decide the findings at the user's autonomy level, as [Deciding findings](#deciding-findings) says. Say in one line what you settled or fixed on your own.

Then ask with AskUserQuestion (header `Publish`, single select):
- `Open the PR`;
- `Open as a draft`;
- `Fix findings first`;
- `Not now`.

Mark exactly one option "(Recommended)" and put it first. Recommend `Not now`, and say why, when the no-mistakes validation run ended without passing. Otherwise recommend `Fix findings first` while a fix finding remains neither fixed nor settled (accepted, declined or noted). Otherwise recommend `Open as a draft` when `constraints.draftRequired` or `constraints.humanTestingRequired` is true. Otherwise recommend `Open the PR`.

`Not now` ends the turn; the run stays in the worktree, and `/resolve-issue publish <worktree>` picks it up later. Any publish choice means: follow [publish.md](publish.md). If you cannot ask (a non-interactive session), show the packet, publish nothing, and end with: "To publish, run `/resolve-issue publish <worktreePath>` in an interactive session." The `yes` flag only skips the cost question; it never approves a publish.

If `gate.kind` is `no-mistakes`, `gate.outcome` is `parked_at_gate` (findings wait for a decision) or `validated_complete` (nothing is parked). Present it the same way. [publish.md](publish.md) says how each kind of finding is fixed on that gate. At autonomy `minor` or `full`, answer the parked validation run before this question. [Answering a validation gate on your own](publish.md#answering-a-validation-gate-on-your-own) says how.

## Deciding findings

### The low-impact test

A finding is low impact only when all of these hold:
- It is a real defect in the changed lines, and only rare inputs reach it.
- It is not a crash, hang, data loss, security problem or failing test.
- The issue's own examples, the acceptance test and the reproduction still work.
- It carries evidence in `impact`: a count from real data, or the unusual input it needs.

A low-impact finding without evidence counts as fix. "Rare" alone is not evidence. You need a count from real data only when it is cheap to get. The unusual input alone is enough evidence, for example "needs two dollar amounts in one label". Between fix and low-impact, prefer low-impact when the fix would add rules or change logic beyond the named lines. Prefer fix when the defect corrupts stored data. A pre-existing defect that the diff made reachable is the diff's own defect, and a crash is always fix.

A product decision is a finding whose right behavior the issue, the intent and the stated decisions do not settle. Example: whether video labels keep `--` as written. Product decisions always go to the user. A no-mistakes `ask-user` finding goes to the user only when it needs a product decision. Otherwise, decide it by the test above.

### Autonomy levels

The level comes from `autonomy=` in the request, else the configured autonomy (default `minor`).

| Level | You settle on your own | You fix on your own | You ask the user about |
|---|---|---|---|
| `ask` | nothing | nothing | every finding, with your recommendation |
| `minor` | low-impact, decline and note findings | nothing | fix findings and product decisions |
| `full` | low-impact, decline and note findings | fix findings, up to the round limit | product decisions, and fix findings left after the limit |

At every level, publishing waits for the user's explicit approval: push, fork, PR and comment. A gate in the publish run also waits for the user, because answering it publishes. Never use `--yes`, never use `--action skip` for single findings, and never `abort` or `rerun` to get past a gate.

### Order of work

At `minor` and `full`, decide the findings before the Publish question:
1. Recommend an action for each finding.
2. Record every decision in the decision log, the intent block and the PR body's Notes, as below.
3. Act. On the built-in gate at `full`, fix as step 0 of [publish.md](publish.md) says. On a parked no-mistakes validation run, answer as [Answering a validation gate on your own](publish.md#answering-a-validation-gate-on-your-own) says.
4. Ask the user about what remains and act on the answers, then present the packet.

In a non-interactive session, do on your own what the level allows. At `full`, that includes the fixes you recommend, up to the round limit. Leave a parked gate unanswered while a fix finding or a product decision waits for the user. Show the packet with the open decisions, and publish nothing.

### The round limit

`rounds=N` (1 to 5, default 2) caps the fix rounds you request in one run. A fix round is one `--action fix` answer on the no-mistakes gate, or one `Fix findings first` pass on the built-in gate. After the cap, settle the remaining low-impact, decline and note findings, and ask the user about any fix finding. At `ask` and `minor`, the cap only shapes your recommendation: past it, recommend settling instead of another fix round. The cap never changes the recommendation for a crash, hang, data loss, security problem or failing test: those stay fix.

### Records

- **Decision log**: `<worktreePath>/.resolve-issue/decisions.json` is a JSON array that you write with the Write tool. Each entry holds `runId`, `id`, `round`, `gateRun`, `summary`, `recommendation`, `impact`, `decision` (fix, accepted, declined or noted), `decidedBy` (user or auto) and `reason`. `round` is the number of fix rounds you requested in this run before this decision (0 before any). Copy `runId` from `packet.json`. Match repeated findings and count rounds only among the entries with this packet's `runId`. When a gate lists a finding again (same file and same problem), its logged decision applies: do not ask again. A publish run is the exception: there, show the finding and wait.
- **Intent block**: keep one block at the end of `<worktreePath>/.resolve-issue/intent.txt`, and replace it on each update. It starts with the line `Findings already decided (decisions, not omissions):`. Then comes one line per accepted, declined or noted finding: at most 12 lines, each up to 200 characters. The publish run passes this file as its intent, so its review reads these as deliberate.
- **PR Notes**: list each accepted finding under "Known limitations" in the PR body's Notes. Write each as one sentence on what happens and when, with its evidence. Declined findings keep their reason there, as before.

## `status: "triaged"`: triage mode

Give the verdict first: **takeable** or **not takeable**. Then `blockers` (each code and reason), `warnings`, the issue summary (`summary.title`, symptom, likely root cause, maintainer intent, size estimate), prior art, and the AI policy with its evidence. End with `suggestedMode` and the exact command to run it, for example `/resolve-issue <url> quick`. If every blocker is overridable (closed issue, competing PR, claim, work in progress, a wontfix/invalid/duplicate label), say that `force` would go ahead anyway, and that this is the user's call. If any blocker is a hard stop, `force` does not help: say so, and do not offer it.

## `status: "awaiting-scope-decision"`

The pipeline found that the responsible fix goes beyond the literal ask: it changes a public API or contract, widens the security surface, contradicts a maintainer, or no code change is responsible. Present `question`, `alternatives`, `recommendation`, `proposedScope` and `why`. Ask with AskUserQuestion: `Proceed with this scope` or `Abort`. Then resume with `scopeDecisions`: every entry in `earlierDecisions`, plus `{ "key": "<gateKey>", "answer": "proceed" | "abort" }` for this gate (the result's `resume` field spells out the exact list). Each gate takes only the answer with its own key, so a run that halts twice needs both answers.

## `status: "went-remote-without-approval"`

no-mistakes pushed, opened a PR or started CI without approval. Tell the user immediately, show `gate.pushedRef` and `gate.prUrl` (or check `no-mistakes axi status` in the worktree if they are empty), and ask what to do.

## Stops: `stopped: "<code>"`

Relay `reason` (or `reasons`), `warnings`, and `resume`, which says exactly how to continue or that the stop is final.

| Code | Meaning | What to offer |
|---|---|---|
| `issue-closed`, `competing-pr`, `claimed`, `work-in-progress`, `not-viable-label` | A soft viability stop: the issue is closed; someone's open PR updated in the last 30 days targets it; someone claimed it 7 days ago or less, or within 14 days with a PR, a branch or a maintainer's acknowledgement; someone has an unmerged fix touched in the last 60 days; or it is labeled wontfix, invalid or duplicate | Explain it. Going ahead anyway is the user's call: resume with `force: true` (recon replays from cache), but only when `resume` offers it. |
| `repo-archived`, `repo-rejects-ai-contributions`, `already-have-pr` | A hard stop | Explain it. `force` does not override these. |
| `invalid-issue` | Not a defect, or already fixed at the base | Show `reason` and `draftComment` as a suggested reply the user may post themselves. Never post it. |
| `validate-blocked` | The environment or a service the tests need could not be set up | Show what `reason` says is missing. After the user fixes it, resume with the `validateAttempt` that `resume` names. |
| `no-red-test` | The issue is real, but no acceptance test could be made to fail on the base, so a behavior fix could not be proven | Explain it. The user may resume with the `validateAttempt` that `resume` names, or stop. |
| `infeasible`, `infeasible-after-impl` | The fix hit a hard wall | Show `reason` and `findings` (for `infeasible-after-impl`, `verify` shows the failure). |
| `verify-failed`, `unconfirmed` | Attempts ran out | Show `lastFailure`. If it or `warnings` point at the environment or a missing service (connection refused, a missing database, Docker, GPU or network), say so first: more attempts fail the same way until that is fixed. Otherwise offer a resume with a larger `attempts`. If `attempts` is already 8, the maximum, `resume` says so: offer to stop here, or to start a fresh run with a different approach. |
| `agent-budget-reached` | The run hit its agent cap | Offer a resume with a larger `maxAgents`, or stop here. If `maxAgents` is already 200, the maximum, `resume` says so: offer to stop here, or to start a fresh run with a different approach. |
| `token-budget-reached` | Claude Code's token budget for the turn ran out | Offer to resume in a new turn, as `resume` says. |
| `agent-failed` | An agent died twice (API error or stall) | Usually transient: wait a few minutes, then resume with the same args plus the `retryNodes` map that `resume` names (it keeps the earlier entries). At most twice, then report. |
| `tree-damaged` | A check left the worktree dirty or off the expected head | Show `git -C '<worktreePath>' status` and the log. After the user restores the tree, resume with the `confirmAttempts` map that `resume` names (it keeps the earlier entries). |
| `final-check-failed`, `handoff-failed` | The final check could not start, or (`handoff-failed` only) the no-mistakes run started and failed | If `gate.steps` shows a failed step, or `resume` says the validation run failed, the gate ran and failed: show `gate.steps` and `gate.findings` verbatim. A resume starts a new validation run on the same head, so the cause must be fixed first; then resume with the `gateAttempt` that `resume` names. Otherwise show the reason and any `gate.setupCommands` (running those is the user's call), and resume with the `gateAttempt` that `resume` names, or, for `handoff-failed`, with `gate: "builtin"`. |
| `gate-still-running` | The no-mistakes run is still going | Offer to resume later with the `gateAttempt` that `resume` names; it reattaches to the same run. |
| `prior-branch-exists` | A `fix/issue-<n>` branch already exists outside resolve-issue's own worktree | Show `priorBranchLog`. The user finishes or removes that branch, then starts a fresh run. |
| `worktree-failed` | The worktree step returned an unexpected branch or path | Show `worktree`. A verdict: check the clone, then start a fresh run. |
| `recon-failed`, `user-declined-wider-scope` | Verdicts | Explain. A resume would replay them. |
| `invalid-issue-url`, `bad-args` | Bad input | Fix the input and start again. |

`started: false` means the workflow was started without the skill's arguments. Launch it again as step 4 of the skill describes.
