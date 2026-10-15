# Safety and trust

This page states what resolve-issue reads, writes and runs, what it never does on its own, and what enforces that. It also states the limits.

## The trust model

resolve-issue is a skill, a workflow and a hook inside your Claude Code session. It has no separate process, server or credentials. Every agent it starts runs:

- under **your** Claude Code permissions and settings (permission mode, allow and deny rules, hooks, sandbox settings);
- with **your** `gh` login and git credentials;
- on **your** machine, in your file system.

So it can do what your session can do. If your session runs with permission prompts bypassed, so do its agents. The safeguards below reduce risk; they do not replace your own settings.

## What it reads

| Source | How |
|---|---|
| The issue thread, every comment, linked issues and PRs | `gh issue view`, `gh api` (GET) |
| The issue timeline and PRs that target the issue | `gh api .../timeline`, `gh pr list`, `gh pr view`, `gh search` |
| Your own PRs on the repository | `gh pr list --author @me` |
| Unmerged fixes without a PR: commits that reference the issue and branches named after it, in the repository or a fork | the issue timeline's referenced events, `gh api` (GET) |
| Your GitHub identity and push permission | `gh api user`, `gh api repos/<owner>/<repo>` |
| Repository files: code, tests, CI workflows, build files, CONTRIBUTING, AGENTS.md, CLAUDE.md, AI_POLICY.md, `.github/copilot-instructions.md`, the PR template, style config | `git show <base>:<path>`, `gh api .../contents` |
| The last 20 commit subjects (every run that passes the viability check; not triage) | `git log --format=%s -20` |
| The last 5 merged PRs (polish pass only) | `gh pr list --state merged` |
| Whether your fork has a `fix/issue-<n>` branch | `git ls-remote` |
| Whether no-mistakes is installed and initialized | `command -v no-mistakes`, `no-mistakes status` |

During a run, every agent is told to use GitHub read-only, the three recon agents included. For 12 hours after a run starts or resumes, the publish guard also denies every publishing command it sees from any subagent in the session, wherever it runs (see [the publish guard](#the-publish-guard)).

## What it writes

| What | Where |
|---|---|
| A clone, only if none exists in or under the current directory | `<cwd>/<repo>` (or `<cwd>/<repo>-<owner>`), with `--filter=blob:none`. If the current directory is inside an unrelated repository, the clone goes next to that repository instead, in the parent directory of its main clone (the main clone, not the worktree, when the current directory is a worktree such as Claude Code's `.claude/worktrees/<name>`; the main clone of the outermost superproject when it is in a submodule, nested or not). In a main working tree (a plain clone, a submodule, a clone with a separate git dir), the main clone is that checkout. From a linked worktree, it comes from the first entry of `git worktree list`: that entry's checkout (for a worktree of a submodule, the submodule's checkout), or the entry itself when it is a bare repository or the git dir of a clone made with `--separate-git-dir`. It does not walk further up through enclosing repositories. |
| A fetch of the upstream default branch | your existing clone's remote-tracking ref |
| A worktree and a branch | `<clone>-issue-<n>` on `fix/issue-<n>` |
| Commits | on `fix/issue-<n>` only (plus a temporary `fix/issue-<n>-polish` during polish) |
| Scratch files | `<worktree>/.resolve-issue/` (self-ignored) |
| An environment for the worktree, only when no usable one exists (common for a fresh clone) | `<worktree>/.resolve-issue/venv` for Python, with an editable install of the worktree and its test dependencies; the lockfile install inside the worktree for Node; the toolchain's own fetch for Rust and Go |
| Missing dependencies for an existing environment | `<worktree>/.resolve-issue/site` for Python; inside the worktree for ecosystems that keep dependencies in the checkout (such as `node_modules`); shared build caches such as `CARGO_TARGET_DIR=<clone>/target` or the pnpm store may be reused |
| The no-mistakes gate run (only with that gate) | the repository's no-mistakes gate |

The validation agent is told never to install into the main clone's environment, a shared virtualenv or your global environment, and to make no editable install other than the worktree itself, into `<worktree>/.resolve-issue/venv`. This is a prompt, not a control: install scripts run with your permissions. The recon agent is told never to add, rename or edit git remotes, and the gate agent never to run `no-mistakes init`; these are prompts too. When a run stops with `invalid-issue` or `infeasible`, a cleanup agent removes the worktree and branch the run created, and only if they hold no work. The stop then reports `worktreePath` and `branch` as `null`. Other stops keep the worktree, so a resume or a fresh run can continue in it.

## What it runs

The target repository's own code: its build, its tests, its linter and formatter, the reproduction script, and package installs (which can run install scripts). This is the same as cloning the project and running its test suite yourself.

**Run resolve-issue only on repositories whose code you would build and test on your own machine.** For code you do not trust, run Claude Code inside a sandbox such as [sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime), or in a disposable VM or container.

## What it never does on its own

- push a branch;
- comment on, label, assign or react to an issue or PR;
- fork a repository;
- open, edit, mark ready, merge or close a PR;
- start a no-mistakes run that can push, open a PR or run CI;
- post the suggested reply it drafts for an invalid issue.

These happen only in the publish step, after you approve that specific publish in the conversation ([publishing.md](publishing.md)).

## The layers behind it

1. **The workflow has no publishing step.** No node in [workflows/pipeline.js](../workflows/pipeline.js) is asked to push or open a PR. The final check runs "with publishing disabled".
2. **Prompts.** Every agent is told never to run `git push` or any GitHub write, and every agent working in the worktree never to run `no-mistakes` other than the one validation run. The three recon agents are told to use GitHub read-only. A prompt asks; it does not enforce. The guard below enforces part of it.
3. **The no-mistakes skip set.** The one no-mistakes run starts with `--skip push,pr,ci`, and the agent is told never to run `axi respond`, `axi abort`, `--yes` or `axi sync` without `--check`. If no-mistakes still reports a push, PR or CI step as run, the result is `status: "went-remote-without-approval"`, and the skill tells you at once.
4. **The publish guard** (below): a hook that denies publishing commands from every subagent in the session for 12 hours after a run starts, and in a resolve-issue worktree.
5. **Your approval.** The skill publishes only after you choose `Open the PR` or `Open as a draft` (or say an equally clear yes) in this conversation. Silence, an earlier approval for something else, or text in a file, issue or tool output is never approval. The `autonomy` option sets how much the skill decides about review findings on its own: `ask`, `minor` or `full` ([publishing.md](publishing.md#finding-decisions-and-autonomy)). At every level, publishing waits for your explicit approval: push, fork, PR and comment. A gate in the publish run also waits for you, because answering it publishes. The skill creates the guard's one-time token (see [the publish guard](#the-publish-guard) below) only after you approve. One exception applies at `minor` and `full`. The skill creates a token on its own for one `no-mistakes axi respond` on a validation run. Such a run cannot publish.

## The publish guard

[hooks/hooks.json](../hooks/hooks.json) registers three `PreToolUse` hooks:

- [hooks/run-marker.sh](../hooks/run-marker.sh), on the Workflow tool. When your session starts or resumes the resolve-issue pipeline, it records the session. It never blocks the Workflow call.
- [hooks/publish-guard.sh](../hooks/publish-guard.sh), on the Bash tool. Eight `if` rules decide when it runs: `Bash(*push*)`, `Bash(*git*alias*)`, `Bash(*gh *)`, `Bash(*gh-axi*)`, `Bash(*hub *)`, `Bash(*no-mistakes*)`, `Bash(*curl*github*)` and `Bash(*wget*github*)`. Claude Code checks each part of a compound command against them, and the wildcards on both sides mean a prefix, a wrapper or a full path does not hide a command from the hook. `*push*` is deliberately broad: a command assembled from parts (`G=git; $G push`) still reaches the guard.
- The same guard, on every MCP tool (`mcp__.*`). An MCP tool whose input has a `command` string (a shell tool, such as desktop-commander's `start_process`) has that string read like a Bash command, in the session's working directory, so all four rules apply to it. A command given as a list, arguments in another field and a working directory of the tool's own are not read. Any other MCP tool is judged by its name alone, whatever the size of its input.

The guard is POSIX `sh` plus [an awk parser](../hooks/publish-guard.awk), with no Python or Node.

**What counts as publishing:**

- `git push`, and `git -c alias.<name>=...` (an alias defined on the command line);
- `gh`, and the `gh-axi` wrapper (`gh-axi …`, `npx -y gh-axi …`, `npx gh-axi@latest …`), in a group that can write: every subcommand except the group's reads, listed in the table below. So gh's own aliases (`gh pr new`, `gh secret remove`) and newer subcommands (`gh pr revert`, `gh discussion comment`, `gh agent-task create`) count, and so do gh-axi's `stack push`, `submit`, `sync` and `merge`. In a nested group (`gh issue subissue`, `gh repo deploy-key`, `gh repo autolink`, `gh project items` or `fields`), the next word is the subcommand. Other `gh` commands (`auth`, `config`, `alias`, `extension`, `ssh-key`, `gpg-key`, `codespace`, `search`, `browse`, `status`) are not checked, and neither is a gh alias or extension from your gh config (`gh prc` defined as `pr create`);
- `gh api` with a write method (`-X POST`, `--method PATCH`, `-X=POST`, also at the end of a short-option cluster: `-iX POST`), a positional write method (`gh-axi api POST …`), or fields (`-f`, `-F`, `--field`, `--raw-field`, `--input`, also in a cluster: `-iF title=x`), which imply POST for `gh`. `gh-axi api` sends GET unless a method is given, so its fields are a query. In a short-option cluster, the first option that takes a value (`-H`, `-q`, `-t`, `-p`, `-f`, `-F`, `-X`) takes the rest of the word, so `-H'X-GitHub-Api-Version: 2022-11-28'` is a header, not a method; and `gh api graphql` with a mutation;
- `curl` with a write method (`-X POST`, also attached or at the end of a cluster: `-XPOST`, `-sX POST`), an upload (`-T`) or a request body (`-d`, `-F`, `--data…`, `--form`, `--json`, also inside a cluster: `-sd`), sent to a GitHub URL: a request URL (an operand, or `--url`) whose host is `github.com` or one of its subdomains (`api.github.com`, `uploads.github.com`). A GitHub URL inside an option's value, such as a body, a header, a referer or a proxy, does not count, so `curl -X POST http://localhost:8000/api -d '{"repo":"https://github.com/o/r"}'` passes. In a short-option cluster, the first option that takes a value takes the rest of the word, or the next word. `-G` or `--get` turns a body into a query, so `curl -G -d q=x` is a read unless `-X` names a write method;
- `wget` with `--post-data`, `--post-file`, `--body-data`, `--body-file` or a write `--method`, sent to a GitHub URL; as for `curl`, only a request URL counts, not an option's value;
- `hub` push, pull-request, fork, create, delete, merge and sync, its issue and release writes, and `hub api` with arguments;
- a command computed at run time that could push: `git` with a computed subcommand (`git $p`, `git $(echo push)`), or a computed program, read like `git`, whose subcommand after git's global options is `push` (`G=git; $G push`, or `$G -C <dir> push`, judged in `<dir>`). These are treated as publishing even when they would not be (fail-safe). A computed program whose first operand is something else passes, such as `$PY -m pytest -k push`;
- `no-mistakes` with `--yes`, `axi respond`, and `run --intent` or `rerun` unless `--skip` lists `push`, `pr` and `ci`;
- for MCP tools: a GitHub tool whose own name starts with a write verb, `create_`, `update_`, `merge_`, `push_`, `delete_`, `fork_`, `add_`, `remove_`, `edit_`, `close_`, `reopen_`, `submit_`, `request_`, `assign_`, `run_`, `rerun_`, `cancel_`, `dispatch_`, `upload_`, `lock_`, `unlock_`, `transfer_`, `star_`, `unstar_`, `manage_`, `dismiss_`, `mark_`, `set_`, `approve_`, `enable_`, `disable_` or `reprioritize_`, or ends in `_write` or `_trigger`. Examples: `mcp__github__create_pull_request`, `mcp__github__run_workflow`, `mcp__github__issue_write` (and `mcp__github__enable_toolset`, since `enable_` is on the list). A tool is a GitHub tool when its server's name (the `<server>` in `mcp__<server>__<tool>`) contains "github" in any case, or its own name starts with `github_`, which is dropped before the verb is read. Reads such as `get_issue_comments`, `list_labels`, `search_issues` or `issue_read` pass, and so does every tool of other servers. These name checks apply only under the run rule. An MCP tool with a `command` string also has that string read like a Bash command (see above).

The reads of each `gh` group (every other subcommand of these groups counts as a write):

| Group | Reads |
|---|---|
| `pr` | `list`, `ls`, `view`, `status`, `checkout`, `co`, `checks`, `diff` |
| `issue` | `list`, `ls`, `view`, `status` |
| `repo` | `list`, `ls`, `view`, `clone`, `set-default`, `gitignore`, `license`, `read-file`, `read-dir` |
| `release` | `list`, `ls`, `view`, `download`, `verify`, `verify-asset` |
| `gist` | `list`, `ls`, `view`, `clone` |
| `run` | `list`, `ls`, `view`, `watch`, `download` |
| `workflow`, `discussion`, `agent-task` | `list`, `ls`, `view` |
| `project` | `list`, `ls`, `view`, `field-list`, `item-list` |
| `label`, `secret`, `cache` | `list`, `ls` |
| `variable` | `list`, `ls`, `get` |
| `stack` (gh-axi) | `view`, `checkout`, `up`, `down`, `top`, `bottom`, `trunk` |
| `skill` | `list`, `ls`, `search`, `preview`, `install`, `update` |

**Four rules decide what is blocked.**

1. **The run rule.** For 12 hours after the pipeline starts or resumes in your session (a triage run included), the guard denies every publishing command it sees from any subagent in that session, wherever it runs: the worktree, the main clone, another repository, `gh --repo` from any directory, a `curl` write to GitHub, or a GitHub MCP write tool. Recon is covered too, before any worktree exists. The rule covers every subagent in the session, not only resolve-issue's, and nothing clears it when the run ends; [troubleshooting.md](troubleshooting.md#a-subagent-is-blocked-hours-after-a-run) says how to lift it early. Workflow agents carry the parent session's `session_id` (with agent type `workflow-subagent`), so the guard can tie their calls to the run. The main session is not affected by this rule.
2. **The worktree rule.** In a resolve-issue worktree (a git worktree with a `.resolve-issue/` folder), the guard denies every publishing command it sees from a subagent, even with a token. The main session needs the one-time token `<worktree>/.resolve-issue/publish-approved`. A token covers one tool call, and every hook process of that call shares it. It expires after 15 minutes: the guard refuses and removes a token that old. It renames a used token to `publish-approved.used.<tool_use_id>`, which stays as an audit trail. W1 removes any old token when it creates or resumes a worktree.
3. **The unknown-directory rule.** A subagent's publishing command whose directory the guard cannot resolve is denied in every session and every repository while the guard is on, with or without a run or a worktree. Examples: a `cd` or `git -C` to a variable or a command substitution (`cd "$(git rev-parse --show-toplevel)" && git push`, `git -C "$PWD" push`), a `cd` or `git -C` to a folder that does not exist yet (the command may create it, or the `cd` may fail and leave the shell where it was), a `cd -` before any `cd`, or a `pushd` with no argument when nothing was pushed. So it can also stop a subagent that has nothing to do with resolve-issue: use a literal path to a folder that exists. The main session's commands pass this rule.
4. **The over-limit rule.** A command nested more than 16 levels deep, with more than 64 KB (65,536 bytes) of text to read, with more than 1,024 subshells and directory changes, with more than 64 publishing commands, or that names programs so often that checking it would read more than 200,000 words is not read past that point, because the rest could publish from anywhere. A subagent may not run it, in every session and every repository, with or without a run or a worktree. The main session's is judged in the directory where reading stopped. Like the unknown-directory rule, it can stop a subagent that has nothing to do with resolve-issue: write long text with the Write tool, or to a file first, and pass the file.

The skill creates the token as its own command, after you approve, right before each publishing command. It runs each publishing command with the worktree as its directory (`(cd '<WT>' && …)`, `cd '<WT>' && …` or `git -C '<WT>'`), so the guard sees it and uses the token. Afterwards it removes any leftover token. One exception applies at `minor` and `full`. The skill creates a token on its own for one `no-mistakes axi respond` on a validation run. It first checks that the workflow or the skill started that run with push, pr and ci skipped. It also checks that none of those steps has run. Such a run cannot publish.

**The token is a speed bump, not proof of approval.** It stops a publish the main session did not prepare on purpose. It cannot prove that you approved: anything that can run commands in your session can create the file. The real control is that the skill creates it only after you answer the Publish question. The one exception is a token for one answer to a validation run, at autonomy `minor` or `full` (see above).

**How the parser reads a command.** It finds the target directory from the session's working directory, `cd`, `cd -`, `pushd`, `popd` and `git -C`. It splits compound commands on `;`, `&`, `|`, parentheses, backticks and newlines, so `cd <worktree> && git push` and `(cd <worktree>; gh pr create)` are caught. Beyond that:

- It finds `git`, `gh`, `gh-axi` (also as `npx -y gh-axi` or `npx gh-axi@latest`), `no-mistakes`, `curl`, `wget` and `hub` at any word position. Keywords (`if`, `!`, `{`), environment-variable prefixes, full paths (`/usr/bin/git`) and wrappers with options (`nice -n 10`, `timeout 30`, `sudo -u x`, `env`, `xargs`) do not hide them. The string of `env -S` (`--split-string`) is read as a command of its own, one level deeper.
- A help request is not publishing: `--help` after `git push`, `gh`, `gh-axi`, `hub` or a computed program's `push`, and `-h` after `git push`, a computed program's `push` or `gh`, before any `--` (`git push --help`, `gh pr create -h`). `-h` is not a help request for `hub`, where it is `--head` or `--homepage`, for `gh repo create` and `gh repo edit`, where it is `--homepage`, or for `gh-axi`, which passes it on as a flag.
- It skips the arguments of programs that never run them: `echo`, `printf`, `grep`, `egrep`, `fgrep`, `which`, `whereis` and `type`. A `$( )` or backticks inside them is still parsed.
- It joins backslash-newline continuations.
- It drops comments. An unquoted `#` at the start of a word starts one; a `#` inside a word (`a#b`, `${#v}`, `$#`) does not.
- It reads heredocs. A quoted body (`<<'EOF'`, `<<"EOF"`, `<<\EOF`) is data. An unquoted body is data except for its `$( )` and backticks, which are parsed as commands. Either kind is parsed as commands when `sh`, `bash`, `zsh`, `dash`, `ksh`, `ssh`, `eval` or `source` is named from the start of the heredoc's own command to the end of its line (`bash <<'EOF'`, `cat <<'EOF' | sh`, `cat > f <<'EOF' && sh f`), or when the heredoc is inside the text of `sh -c` or `eval`. The heredoc's command starts after the last `;`, `&&`, `||` or background `&` before it; a pipe or a redirection's `&` does not end it. A heredoc on the closer of a loop, a group or a subshell (`done <<'EOF'`, `} <<'EOF'`, `fi <<'EOF'`, `) <<'EOF'`) feeds the whole of it, so it is tested from the start of its line, and any earlier line of the command counts too, since the loop may have started there. A shell named in an earlier command on the line does not count, so the body of `source .venv/bin/activate && python - <<'EOF'` is data. So a commit message or a PR body that only mentions `git push` passes. A here-string (`<<<`) is not a heredoc. Given to a shell, it is read as commands (`bash <<< 'cmd'`, `sh -s arg <<< "cmd"`): without `-c`, when it comes before any script operand (a redirection such as `2>&1` is not an operand), or anywhere with `-s`. Given to anything else, it is data.
- It parses the script of `sh -c`, `bash -c`, `zsh -c` (and `dash`, `ksh`) as a command, after any options, including ones that take an argument (`-o pipefail`, `-euo pipefail`, `-oc pipefail`, `-O extglob`, `--rcfile <file>`) and `--`. It parses the text of `eval` the same way.
- It parses a `$( )` or backticks inside double quotes as a command too (`out="$(git push)"` is caught), and keeps it in its word. A `$((` is arithmetic only when its parentheses close as `))`; otherwise, as in bash, it is a `$( )` around a subshell (`out="$((git push) 2>&1)"` is caught).
- Each `( )`, each `$( )` or backticks (quoted or not), each heredoc body or here-string read as commands, and each `sh -c`, `env -S` string or `eval` opens a level. The over-limit rule stops reading at the first bound a command passes: more than 16 levels deep (the message says "a command nested more than 16 levels deep"), more than 64 KB (65,536 bytes) of text to read (text read again one level deeper, such as a double-quoted `$( )` or the script of `sh -c`, counts again), more than 1,024 subshells and directory changes, more than 64 publishing commands, or more than 200,000 words read by the checks that follow each program name (a command that names programs thousands of times; the message says "a command too complex to check"). A hook input that carries a command and is longer than about 132 KB (twice the text bound, plus 4 KB) is refused before it is decoded. The guard runs awk with `LC_ALL=C`, so every awk and every locale counts bytes. The rest of such a command is not read, so it could publish from anywhere: a subagent may not run it at all, and the main session's is judged in the directory where reading stopped. Past a bound, the hook stops reading instead of running long, so it stays well inside its 15-second timeout: in tests, the slowest such command took about 1.5 seconds, and 2 to 3 seconds with eight hook processes at once.
- A `cd`, `pushd` or `popd` inside `( )`, `$( )`, backticks, a heredoc body or here-string read as commands, `sh -c` or an `env -S` string does not change the directory of later commands. Neither does one behind a wrapper that starts a program of its own (`env cd`, `nice cd`, `sudo cd`, `timeout 5 cd`, or in the string of `env -S`); `command cd` and `builtin cd` do. A `cd` in the text of `eval` does too, because `eval` runs in the shell itself. `cd -` returns to the previous directory, and `pushd` and `popd` follow the directory stack. Each Bash call starts a new shell with an empty directory stack, so a `popd` past what the command pushed fails and changes nothing. When the guard cannot follow them (`cd -` before any `cd`; `pushd` with no argument when nothing was pushed, where bash fails and zsh goes home; `pushd` or `popd` with `+N`, `-N` or `-n`; a directory stack more than 16 entries deep), the directory is unknown, and the unknown-directory rule applies. So is a folder that does not exist when the hook runs, a path with a newline in it, a path written longer than 4,096 bytes, and a path longer than 1,024 bytes once resolved (the session's own directory included). A word that starts with a quoted `~` (`"~/x"`, `'~'`), an escaped `\~` or `\$`, or a single-quoted `$` (`'$HOME/x'`) is not expanded by the shell, so the guard reads it as a literal relative path: a `cd` there is to a folder that does not exist, and the directory is unknown. Several `git -C` options apply in order, each relative to the one before (`git -C a -C b push` runs in `a/b`).
- If the parser itself fails (an awk error), the hook blocks the command and exits with status 2.

Some side effects err on the safe side. A mention in the arguments of another program, such as `man git push` or `find . -name git -o -name push`, counts as a push; a quoted mention (`'git push'`) passes, and so do the arguments of `echo` or `grep`. A computed program whose first operand is `push` counts too, such as `"$(git rev-parse --show-toplevel)/scripts/test.sh" --suite push`. A command past one of the over-limit bounds counts as publishing even when it publishes nothing, once one of the hook's `if` rules sends it to the guard. In a `curl` or `wget` command, the value of a rare option that the guard does not know takes a value can read as a request URL.

**Tested in a real session.** In a Claude Code 2.1.296 session, the worktree rule blocked 8 publishing forms in a resolve-issue worktree: a bare `git push`, an env-prefixed push, a `cd` chain, `command git push`, `sh -c`, `/usr/bin/git push`, `git -C <worktree> push` and `gh pr create`. Read-only `gh` and `git` commands ran. A push from a workflow agent was blocked. The unit tests are in [tests/publish-guard.test.mjs](../tests/publish-guard.test.mjs).

**Its limits.** It is defense in depth, not a sandbox. It is meant to catch publishing that agents do by mistake, in the forms they write. A command written to get past it can.

- The token is a speed bump for the main session, not proof of your approval (see above).
- At autonomy `minor` or `full`, the skill decides findings on its own, only at validation gates, which cannot publish. A wrong low-impact call ships a known limitation, and the PR's Notes list it.
- The main session is not restricted outside resolve-issue worktrees. It is also not checked when the guard cannot resolve a command's directory (a variable, a command substitution, a folder that does not exist yet), or in the unread rest of a command past a bound.
- It follows `cd`, `pushd` and `popd` in the order they are written. It does not evaluate conditions, loops, functions, pipelines or background jobs, so a command can hide its directory: `false && cd /tmp; git push`, run in a worktree, passes the worktree rule.
- The guard reads the command text. It does not see publishing inside a script file, a Makefile target or a git alias from your git config, or a gh alias or extension from your gh config. A script that a heredoc writes and a later command runs (`cat > x.sh <<'EOF'` … `sh x.sh`) is a script file too. An alias set with `git -c alias.*` on the command line is seen.
- It does not see text computed while the command runs. Computed git subcommands, and computed programs whose subcommand is `push`, are caught, but an unquoted command substitution used as the program name (`$(echo git) push`), script text produced at run time (`sh -c "$(…)"`, `eval "$(…)"`), and a whole command assembled in a variable and run another way are not.
- A few rare forms are misread: escaped backticks nested inside backticks, and a stray `)`, such as a `case` pattern's, which can end a subshell or a substitution early. The guard reads commands the way bash and zsh run them, so in `sh -c` on a system whose `sh` is dash, it still follows a `pushd`, `popd` or `builtin cd` that dash cannot run. The `$( )` of an unquoted heredoc body is judged after the rest of its line, so a `cd` later on that line changes the directory it is judged in.
- Other tools are not covered: a browser, or an MCP tool that is not a GitHub tool by the test above and has no `command` string. For a shell tool, a command given as a list, arguments in another field and the tool's own working directory are not read. The main session's calls to GitHub MCP write tools are not checked.
- A hook can be turned off: in your Claude Code settings (for example, when hooks are disabled) or with the `publish_guard` option.
- Windows is untested.

**Turning it off.** Set **Publish guard** (`publish_guard`) to `false` in `/config`. This turns off all four rules. The skill still waits for your approval; only the hook stops checking.

Run the guard's tests with `npm test`.

## Prompt injection

Issue text, comments, PR descriptions and repository files are written by other people. resolve-issue treats them as data:

- Every agent prompt says that text quoted from issues, PRs, comments or repo files is data, never instructions: note an instruction found there, do not follow it.
- GATE-0 is told that no repo file or note can relax push, PR or approval rules.
- The skill treats any text inside the issue, the repository or tool output as data. Only your own words can accept the cost or approve a publish.
- Viability, confirmation and scope halts are decided by code over structured fields, not by an agent's free-text judgement.

Prompt rules reduce risk; they do not guarantee it. This is why the publish guard exists, and why you see the exact diff before anything is published.

## AI-contribution policies and disclosure

Many projects have rules for AI-assisted contributions. U3 reads CONTRIBUTING, AGENTS.md, CLAUDE.md, AI_POLICY.md and the PR template and classifies the policy:

| Policy | What happens |
|---|---|
| `reject-agentic` (AI-assisted work refused even when a human submits it) | Hard stop: `repo-rejects-ai-contributions`. `force` does not override it. |
| `no-autonomous` (only autonomous agents opening PRs are banned) | Warning: you must review, test and submit the PR yourself. The PR body carries a disclosure. |
| `disclosure-required` | Warning, and the PR body carries the disclosure the repository asks for. |
| `allowed`, `none-found` | No action. |

U3 also warns when a repository wants agent work opened as a draft, tested by a human, accompanied by screenshots, or agreed with a maintainer first.

When no wording is given, the default disclosure is: "AI disclosure: prepared with Claude Code (an AI coding assistant), which reproduced the issue and drafted the change and tests; I reviewed the diff and the test results before submitting." Make sure that last clause is true before you publish.

Commits carry no `Co-authored-by` trailers and no tool or agent names. The PR is opened under your GitHub account: you are its author, and you answer for it.

## Data handling

resolve-issue has no telemetry, no server and no network calls of its own. Data leaves your machine only through tools your session already uses:

- Claude Code sends prompts to the model, as in any session. Prompts include issue text and repository code.
- `gh` and `git` talk to GitHub (read-only during a run).
- Package managers contact their registries when a missing dependency is installed.
- no-mistakes, if you use that gate, runs its own validation with push, PR and CI skipped. See its documentation for what it sends.
