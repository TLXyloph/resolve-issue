# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 1.0.x | Yes |
| Earlier | No |

Security fixes go into the latest release. Update in a terminal with `claude plugin marketplace update resolve-issue && claude plugin update resolve-issue@resolve-issue` (the first command refreshes the marketplace's list of versions), then restart Claude Code.

## Report a vulnerability

Report vulnerabilities privately. Do not describe one in a public issue, pull request or discussion.

1. Go to the repository's [Security tab](https://github.com/TLXyloph/resolve-issue/security).
2. Choose **Report a vulnerability**. This opens a private security advisory that only you and the maintainers can see.
3. Describe the problem, the version, and the steps to reproduce it. A command or hook input that shows the problem helps most.

If the **Report a vulnerability** button is missing, private reporting is not turned on yet. Open a short public issue that asks for a private contact, and leave out every detail of the problem.

We aim to acknowledge a report within 7 days. We will agree on a fix and a disclosure date with you, and credit you in the advisory unless you ask us not to.

Examples of what we treat as a vulnerability:

- a way for a pipeline agent, or text in an issue or repository, to push, comment, fork or open a pull request without the user's approval;
- a publishing command from a subagent that gets past the guard within 12 hours after a resolve-issue run started in its session (the run rule), or inside a resolve-issue worktree (the worktree rule), through a form the parser claims to read: a wrapper, a keyword, a nested shell up to the documented depth, a continuation, a comment, a heredoc or a quoting form;
- an approval token that lets more than one tool call through, or works after 15 minutes;
- a way for the skill to create the token for a publishing command, or to publish, before the user approves that publish. The one documented exception applies at autonomy `minor` or `full`. The skill then creates a token for one `no-mistakes axi respond` on a validation run. The run qualifies only when the workflow or the skill started it with push, pr and ci skipped, and none of those steps has run.

Known limits, not vulnerabilities on their own: the guard is meant to catch publishing that agents do by mistake, and a command written to get past it can; it follows `cd`, `pushd` and `popd` in the order they are written, without evaluating conditions, loops, functions, pipelines or background jobs (`false && cd /tmp; git push`), and a stray `)` such as a `case` pattern's can end a subshell early; the token is a speed bump for the main session, not proof of approval, so anything that can run commands in the session can create it; the main session is not restricted outside resolve-issue worktrees, when its command's directory cannot be resolved (including a folder that does not exist yet), or in the unread rest of a command past a bound; publishing inside a script file, a Makefile target or a git alias from the user's config is not seen; `gh` commands outside the groups the guard checks (such as `gh auth`, `gh extension` or `gh ssh-key`), and a gh alias or extension from the user's config, are not checked; text computed while the command runs (`$(echo git) push`, `sh -c "$(cat script)"`) and a few rare quoting forms are not read; other tools, such as a browser or an MCP tool that is neither a GitHub tool nor a tool with a `command` string, are not covered, and for a shell tool a command given as a list, arguments in another field and the tool's own working directory are not read. [docs/safety.md](docs/safety.md#the-publish-guard) lists them all.

## Trust model in brief

- resolve-issue runs inside Claude Code with your permissions, your `gh` login and your git credentials. A run builds the target project, installs its dependencies and runs its tests with them.
- The pipeline treats text from issues, repositories and tool output as data, never as instructions.
- The pipeline has no step that pushes, comments, forks or opens a pull request; its agents are told not to, and the publish guard backs that up. Publishing is a separate step that runs only after you approve it.
- The publish guard is a set of `PreToolUse` hooks with four rules. Run rule: for 12 hours after the resolve-issue workflow starts or resumes in a session, the guard denies every publishing command it sees from a subagent in that session, wherever the command runs, including GitHub MCP write tools ([the verb list](docs/safety.md#the-publish-guard)). Worktree rule: in a resolve-issue worktree, it denies every publishing command it sees from a subagent, and the main session needs a one-time token that covers one tool call and expires after 15 minutes. Unknown-directory rule: in any session, it denies a subagent's publishing command whose directory it cannot resolve. Over-limit rule: a command nested more than 16 levels deep, with more than 64 KB (65,536 bytes) of text to read, with more than 1,024 subshells and directory changes, with more than 64 publishing commands, or that names programs so often that checking it would read more than 200,000 words is not read past that point; a subagent may not run it in any session, and the main session's is judged in the directory where reading stopped.
- The guard reads the command text, and the `command` string of an MCP tool that has one, in the session's working directory. It finds `git`, `gh`, `gh-axi`, `no-mistakes`, `curl`, `wget` and `hub` at any word position, joins backslash-newline continuations, drops comments, and treats heredoc bodies as data unless a shell can run them. It reads through `sh -c`, `bash -c`, `zsh -c`, `eval`, `env -S`, a here-string given to a shell and a `$( )` inside double quotes. For `gh`, every subcommand of a group that can write counts unless it is a read; a `curl` or `wget` write counts only when its request URL is on GitHub. If the parser itself fails, it blocks the command.
- The guard is defense in depth, not a sandbox. A hook can be turned off, and Windows is untested.

[docs/safety.md](docs/safety.md) describes the full trust model and its limits.
