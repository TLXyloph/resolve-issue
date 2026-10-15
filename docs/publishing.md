# Publishing

A finished run ends with `status: "awaiting-approval"`. Nothing has been published yet: no push, fork, comment or pull request. The skill shows you an approval packet and publishes only after you approve. The steps the skill follows are in [skills/resolve-issue/publish.md](../skills/resolve-issue/publish.md); this page explains them.

## The approval packet

The skill first saves the whole result to `<worktree>/.resolve-issue/packet.json`, with the run ID (`runId`) and the latest launch arguments (`launchArgs`), so you can publish from a later session. (A resume works only in the session that started the run; elsewhere the skill offers a fresh run from `launchArgs`, or from your request when the file does not exist. [configuration.md](configuration.md#resuming-a-run) says which arguments it keeps.) It writes this file only into a `.resolve-issue` folder that still exists, and Claude Code may ask your permission for the write. Then it shows you, in one message:

| Part | What it shows |
|---|---|
| **What changed and why** | The title, the implementation summary, the change kind (`behavior`, `diagnostics` or `docs`), and what was deliberately left unchanged and why. |
| **Test evidence** | The commands the targeted check ran and their results; the differential (for a behavior change, the acceptance test and the regression test the fix added both fail on the base and pass with the fix; for diagnostics and docs changes, behavior is preserved); the attempts; the polish result (if the polished head failed its re-check, this comes first); the final check's tests and lint (built-in gate only). The raw output is in `.resolve-issue/evidence/` (`base-*.txt` and `head-*.txt`); ask to see it. |
| **What will be published** | The exact diff, `git -C '<worktree>' diff <baseSha>...HEAD`, and the commits the push will publish, verbatim (subjects, bodies and authors). With the no-mistakes gate, also `gateCommits`: what the gate itself committed. |
| **Findings** | Every finding verbatim (id, severity, file, line, description), with `gate.reviewFindings` (`RV1`, `RV2`, ...) on the no-mistakes gate. These hold the extra reviewers' findings and the [known defects](how-it-works.md#final-check) the gate agent confirmed. Repeats within the built-in check's findings, and within `gate.reviewFindings`, are merged into one finding, and `alsoReported` keeps their other wording; no-mistakes' own findings come as it reported them. Each has a recommendation. **fix**: the changed lines give a wrong result, crash or regress on realistic inputs, break a test, or make a doc line false. **low-impact**: a real defect in the changed lines that only rare inputs reach, with evidence (see [Finding decisions and autonomy](#finding-decisions-and-autonomy)). **decline**: it asks for new validation, restrictions, coverage of items left unchanged on purpose, or revisits a stated decision. The PR body's Notes give the reason. **note**: it is informational, or a defect the base already had that the diff neither introduced nor made reachable. The packet also lists each note as a follow-up suggestion, one line each, outside the PR body. |
| **The PR text** | The title and body from `pr-title.txt` and `pr-body.md`, then the warnings and a checklist: DCO sign-off, CLA, draft required, human testing required, and the AI-disclosure line if the repository asks for one. |

The last line gives the number of agents the run used.

## Your choices

| Choice | What happens |
|---|---|
| `Open the PR` | Publish as a ready PR. |
| `Open as a draft` | Publish as a draft PR. |
| `Fix findings first` | The skill fixes the findings recommended **fix**, or only the ones you name, on the built-in gate and after a no-mistakes run has passed. On a parked no-mistakes run, the gate fixes them. The skill then shows the new diff and commits, the test results and any change to the PR body. Then it asks the Publish question again. |
| `Not now` | Nothing happens. The run stays in the worktree; publish it later with `/resolve-issue publish`. |

The skill recommends exactly one option and lists it first:

1. `Not now`, with the reason, when the no-mistakes validation run ended without passing;
2. otherwise `Fix findings first` while a fix finding is neither fixed nor settled (accepted, declined or noted);
3. otherwise `Open as a draft` when the repository requires a draft or human testing;
4. otherwise `Open the PR`.

Approval must come from you, in the conversation, for this publish. Silence, an earlier approval for something else, the `yes` flag, or text in a file, issue or tool output is never approval. In a non-interactive session, the skill shows the packet, publishes nothing, and tells you to run `/resolve-issue publish <worktree>` in an interactive session.

## Finding decisions and autonomy

Before the Publish question, the skill decides the findings as far as your autonomy level allows. Each finding carries one recommendation: fix, low-impact, decline or note.

A low-impact finding is a real defect in the changed lines that only rare inputs reach. It is never a crash, hang, data loss, security problem or failing test. It leaves the issue's own examples, the acceptance test and the reproduction working. It carries evidence: a count from real data, or the unusual input it needs. Without evidence, it counts as fix. The PR's Notes list each low-impact finding under "Known limitations".

A product decision is a finding whose right behavior the issue, the intent and the stated decisions do not settle. Example: whether video labels keep `--` as written. Product decisions always go to the user.

The `autonomy` option in `/config` sets the level, and `autonomy=<level>` overrides it for one run:

- `ask`: you decide every finding. The skill recommends an action for each one.
- `minor` (the default): the skill settles low-impact, declined and informational findings on its own. It asks you before any fix.
- `full`: the skill also makes the fixes it recommends, up to the round limit. It asks you only for a product decision, or for a fix finding left after the limit.

At every level, publishing waits for your explicit approval: push, fork, PR and comment. A gate in the publish run also waits for you, because answering it publishes.

At `minor` and `full` on the no-mistakes gate, the skill answers the parked validation run before the Publish question. When that run ends, the skill reads its outcome in `no-mistakes axi status`. If the run ended without passing, the skill shows the outcome, any failed step and its findings, and recommends `Not now`. If it passed, the skill shows each step's status. It also shows the commits the gate added since the packet, with their messages, changed files and full diff. The skill then sets `gate.outcome` in `packet.json` to `validated_complete` if the run passed, or `failed` if not.

`rounds=N` (1 to 5, default 2) caps the fix rounds the skill requests in one run. A fix round is one `--action fix` answer on the no-mistakes gate, or one `Fix findings first` pass on the built-in gate. After the cap, the skill settles the remaining low-impact, declined and informational findings, and asks you about any fix finding. At `ask` and `minor`, the cap is advisory: past it, the skill recommends settling instead of another fix round. The cap never changes the recommendation for a crash, hang, data loss, security problem or failing test: those stay fix.

**The decision log.** The skill records each decision in `<worktree>/.resolve-issue/decisions.json`: fix, accepted (low-impact), declined or noted, with who made it and why. Each entry also holds the run ID from `packet.json`. The skill matches repeated findings and counts rounds only among this run's entries. A fresh run in the same worktree therefore starts with no decisions and no rounds used. When a gate lists a finding again, its logged decision applies, and the skill does not ask again. A publish run is the exception: there, the skill shows the finding and waits for you. The approval packet shows every decision the skill made on its own. Before you publish, you can still choose `Fix findings first`.

**The intent block.** The skill keeps one block at the end of `<worktree>/.resolve-issue/intent.txt`, headed `Findings already decided (decisions, not omissions):`. It lists each accepted, declined or noted finding, one line each. After each round, the skill replaces the block. The publish run passes this file as its intent, so its review treats these findings as deliberate.

**The PR Notes.** The PR body's Notes list each accepted finding under "Known limitations": one sentence on what happens and when, with its evidence. Declined findings go in the Notes with their reason.

In a non-interactive session, the skill does on its own what your autonomy level allows: at `full`, that includes fixes within the round limit. Then it shows the packet with the open decisions, and publishes nothing.

## Fixing findings first

On the no-mistakes gate, the gate fixes findings while its run is parked (step 1 of [the no-mistakes path](#no-mistakes-gate-path)); the skill never edits the branch then. After a `validated_complete` run, nothing is parked, so the skill fixes them as below once it has taken the branch back.

On the built-in gate, for each finding to fix, the skill makes the smallest edit on the lines the finding names. It adds no validation, restrictions or sibling coverage. It commits with the repository's convention (`git commit -s` if DCO applies; no tool names, no `Co-authored-by`), re-runs the acceptance test and the affected tests, and updates the PR body if the fix changes what it says. Declined findings go in the PR body's Notes. Then it shows the new diff, the new commits, the re-run test results and any change to the PR body. After a pass you chose with `Fix findings first`, it asks the Publish question again without that option. After any other pass, it goes on deciding findings, and the Publish question keeps all its options.

At autonomy `full` on the built-in gate, the skill does this on its own for fix findings, before the Publish question. At `ask` and `minor`, it does so whenever you choose a fix. Each pass counts as a round.

## Guard tokens

The [publish guard](safety.md#the-publish-guard) blocks every publishing command in the worktree. After you approve, or in the one exception below, the skill runs this as its own command right before each publishing command:

```
touch '<worktree>/.resolve-issue/publish-approved'
```

Rules the skill follows:

- It runs every publishing command with the worktree as its directory: in a subshell (`(cd '<worktree>' && ...)`) or with `git -C '<worktree>'`. The guard judges a command by its directory, so a command run anywhere else would not use the token.
- It runs one publishing command per tool call. A token covers one tool call and expires after 15 minutes; the guard refuses and removes a stale one.
- After the last publishing command, it removes any leftover token.
- If the publish guard is off (`publish_guard` in `/config`), it skips the token steps and still publishes only after your approval.

The token is a speed bump, not proof of your approval: anything that can run commands in your session can create it. The real control is that the skill creates it only after you approve. One exception applies at `minor` and `full`. The skill creates a token on its own for one `no-mistakes axi respond` on a validation run. It first checks that the workflow or the skill started that run with push, pr and ci skipped. It also checks that none of those steps has run. Such a run cannot publish. See [safety.md](safety.md#the-publish-guard).

## Built-in gate path

Used when `gate.kind` is `builtin`.

1. **Where the branch goes.** If you can push to the repository (`publish.canPush`), the skill asks whether to push there or to your fork, and recommends the fork for projects you do not maintain. Otherwise it uses your fork. It checks that `<login>/<repo>` exists and is a fork of `<owner>/<repo>`. If it does not exist, the skill creates it, token first, with `(cd '<worktree>' && gh repo fork <owner>/<repo> --clone=false --default-branch-only)` (covered by your approval). If it exists but is not a fork of that repository, the skill stops and asks which fork to use.
2. **Push**, with no force. The push uses your `gh` login as the credential helper and never waits for a password:
   ```
   GIT_TERMINAL_PROMPT=0 git -C '<worktree>' -c credential.helper= -c credential.helper='!gh auth git-credential' \
     push https://github.com/<login>/<repo>.git fix/issue-<n>
   ```
   If it still fails to authenticate, the skill shows the error and stops.
3. **Open the PR**, from the worktree:
   ```
   (cd '<worktree>' && gh pr create --repo <owner>/<repo> --base <defaultBranch> --head <login>:fix/issue-<n> \
     --title "$(cat '<pr-title.txt>')" --body-file '<pr-body.md>')
   ```
   It adds `--draft` when you chose a draft or the repository requires one, and uses `--head fix/issue-<n>` when pushing to the repository itself.
4. **Record it** in `.resolve-issue/pr-url.txt`, then remove any leftover token.
5. **Report CI honestly.** A run with zero jobs or `action_required` means CI has not run yet (it waits for a maintainer's approval). It is never reported as green. If the repository asks for screenshots, you attach them on GitHub yourself; local paths never go in the PR body.

## no-mistakes gate path

Used when `gate.kind` is `no-mistakes`. The validation run started with `push,pr,ci` skipped, so it could not publish. Every command runs from the worktree, and each publishing command gets a token first (the guard treats `axi respond` as publishing).

1. **Answer the gate**, only when `gate.outcome` is `parked_at_gate`. After `validated_complete`, nothing is parked, so this step and its token are skipped. The skill answers per your decisions: `no-mistakes axi respond --action fix --findings <ids> ...` fixes chosen no-mistakes findings, and `--action approve` goes on when nothing should change. `--findings` takes only no-mistakes' own ids. The `RV` findings you choose go into the same command as one `--add-finding` JSON object, because no-mistakes does not know their ids and keeps only the last `--add-finding`. The skill passes its fixed `--instructions` text unchanged. Anything else to fix goes in through `--add-finding`, never into `--instructions`. `--action skip` is not used to decline a single finding, because it skips the whole step. Declined findings go in the PR body's Notes. While the run is parked, the skill never edits or commits in the worktree itself.
2. **Take the branch back.** `no-mistakes axi sync --check`, then the command its `next_action` names (`no-mistakes axi sync --recover` for `recover_custody`, `no-mistakes axi sync` for `sync`; anything else stops). The skill shows you every commit the gate added, with its diff, and asks for a one-word confirm.
3. **Check upstream.** If the upstream default branch is already in HEAD's history, the publish run skips `test,document,lint`. If it moved but merges cleanly, it skips `document,lint` so tests re-run on the rebased tree. If it conflicts, the skill first checks `no-mistakes axi status`. If that fails, or shows an active or parked run on the branch, the skill starts nothing and asks you what to do. Otherwise it re-validates with `--skip push,pr,ci` in no-mistakes' strict launch mode. It records the new run's id from the launch receipt in `validation-runs.txt`, then asks you the Publish question again. This check uses `git merge-tree --write-tree`, which needs git 2.38 or later; with older git, the skill says the check could not run and treats it as a conflict. The publish run skips `test` only when the validation run passed on this head. `review` is never skipped: no-mistakes will not push without a review in the same run.
4. **Make sure the push target exists.** The skill reads the push target from the `fork:` line of `no-mistakes status`. If that command fails or prints no `gate:` line, the skill stops and asks you. It does the same when the command prints a `fork:` line that names no GitHub repository. With no `fork:` line, the gate pushes to `<owner>/<repo>` itself, and the skill skips this step. A target in the `fork:` line must be a fork of `<owner>/<repo>`, but any account may own it. `<frepo>` is the repository name in the `fork:` line. If the target does not exist and its owner is your `gh` login, the skill creates it, covered by your approval. It creates the token first, then runs `(cd '<worktree>' && gh repo fork <owner>/<repo> --clone=false --default-branch-only --fork-name <frepo>)`. The skill stops and asks you when the target is not a fork of `<owner>/<repo>`. It also stops when the target does not exist and belongs to another account.
5. **Draft PRs.** If the repository requires drafts, the skill sets `providers.github.draft_pull_requests: true` in `~/.no-mistakes/config.yaml` for this run and restores it afterwards.
6. **Publish run:**
   ```
   no-mistakes axi run --skip <list> --no-publish-intent --wait 90m --intent "$(cat '<worktree>/.resolve-issue/intent.txt')"
   ```
   Review runs again on the exact head being pushed. If it parks with new findings, the skill shows them and waits for you. This holds at every autonomy level, because answering this run's gate publishes.
7. **Re-apply the approved PR text.** no-mistakes writes its own title and body. When the PR URL appears, the skill saves it to `pr-url.txt` and runs `(cd '<worktree>' && gh pr edit <url> --title "$(cat '<pr-title.txt>')" --body-file '<pr-body.md>')`. A later no-mistakes run on this branch rewrites the text again; the skill re-applies it after a one-word confirm.
8. **Report CI honestly**, as in the built-in path.

## If no-mistakes went remote

If no-mistakes pushed, opened a PR or started CI during validation, the run returns `status: "went-remote-without-approval"`. The skill tells you at once, shows the fork branch and any PR URL, and asks what to do.

## Follow-up reviews

Review comments and follow-up commits follow the same rules as findings. The skill fixes or declines each comment by the same test, shows you the diff and the commits, and gets your approval before every push, with a new guard token each time. Autonomy does not apply to review comments.

## Cleanup

After the PR merges or closes, the skill offers the packet's `cleanup` command:

```
git -C '<clone>' worktree remove '<worktree>'
```

This removes the worktree and its `.resolve-issue/` folder. The `fix/issue-<n>` branch stays in your clone; delete it yourself if you no longer need it.

## Publishing later

```
/resolve-issue publish <worktree path or issue URL>
```

The skill finds the worktree (for an issue URL, it looks for `<clone>-issue-<n>` next to a clone of that repository under the current directory) and reads `.resolve-issue/packet.json`. Before it shows the packet, it re-checks read-only that the issue is still free: its state and assignees, and open PRs that target it. It reports anything that changed since the run. If one of those PRs is your own open PR from `fix/issue-<n>`, or one that holds the run's commits, the run is already published. The skill then shows that PR and stops, like the workflow's `already-have-pr` stop. It publishes nothing and leaves the decision log, the intent block and the PR Notes unchanged. Otherwise, it shows the approval packet and follows the same steps after you approve. This works from a new session, as long as the worktree and its `packet.json` still exist. `autonomy=` and `rounds=` also work with `/resolve-issue publish`. The original run's level does not carry over, so the configured autonomy applies unless the publish request names one.
