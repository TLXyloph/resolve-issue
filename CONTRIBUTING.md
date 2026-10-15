# Contributing to resolve-issue

Thanks for helping. This guide covers how to load a local checkout, where things live, how to test a change and how to propose it.

## Develop against a local checkout

1. Clone the repository:
   ```sh
   git clone https://github.com/TLXyloph/resolve-issue
   cd resolve-issue
   ```
2. Start Claude Code with the checkout loaded as a plugin:
   ```sh
   claude --plugin-dir .
   ```
3. After you edit a file, run `/reload-plugins` in that session to pick up the change. Restart Claude Code if a change to `hooks/hooks.json` or `.claude-plugin/plugin.json` does not take effect.
4. Try it on a real issue. Start with `triage` mode: it spends the fewest agents and clones nothing.
   ```
   /resolve-issue https://github.com/<owner>/<repo>/issues/<n> triage
   ```

You need Claude Code 2.1.275 or later with dynamic workflows on, the GitHub CLI (`gh`) logged in, git 2.31 or later (2.38 or later for the no-mistakes gate's publish step, which uses `git merge-tree --write-tree`), and Node 20 or later for the tests. The no-mistakes gate needs no-mistakes v1.84.0 or later.

## Repository layout

| Path | What it holds |
|---|---|
| `.claude-plugin/plugin.json` | The plugin manifest: name, version and the `/config` options. |
| `.claude-plugin/marketplace.json` | The marketplace entry that lets people install the plugin from this repository. |
| `skills/resolve-issue/SKILL.md` | The front door. It reads the request, asks the cost question and launches the workflow. |
| `skills/resolve-issue/results.md` | How the skill presents each result status and stop code. |
| `skills/resolve-issue/publish.md` | The publish flow, which runs only after the user approves. |
| `workflows/pipeline.js` | The dynamic workflow, registered as `resolve-issue:pipeline`. It does the work. |
| `hooks/hooks.json` | Registers the `PreToolUse` hooks: the run marker on the Workflow tool, and the publish guard on Bash commands that match `*push*`, `*git*alias*`, `*gh *`, `*gh-axi*`, `*hub *`, `*no-mistakes*`, `*curl*github*` or `*wget*github*`, and on MCP tools. |
| `hooks/run-marker.sh` | Records the session when the resolve-issue workflow starts or resumes, for the guard's run rule. |
| `hooks/publish-guard.sh`, `hooks/publish-guard.awk` | The publish guard, in POSIX sh and awk: the run rule, the worktree rule, the unknown-directory rule and the over-limit rule. |
| `tests/` | Tests run by `npm test`, and `tests/harness.mjs`, which runs the pipeline with simulated agents. |
| `scripts/check.mjs` | Repository consistency checks, run by `npm run lint`. |
| `docs/` | User documentation. |

## Run the checks

```sh
npm test       # node --test tests/*.test.mjs
npm run lint   # node scripts/check.mjs
```

Neither command installs anything. The project has no dependencies.

`npm run lint` checks that the repository agrees with itself:

- every JSON file parses;
- the plugin name and version match across `plugin.json`, `marketplace.json`, `package.json`, the top release in `CHANGELOG.md` and the README version badge;
- the Workflow name in `SKILL.md` matches `meta.name` in `pipeline.js`, and the `scriptPath` fallback exists;
- every `phase()` call in `pipeline.js` has a matching title in `meta.phases`;
- the mode table in `SKILL.md` matches the agent caps in `MODES`;
- every relative link in a Markdown file points at a file that exists;
- no tracked file contains a machine-specific path;
- every hook command points at a file in `hooks/`, and the publish guard stays POSIX sh.

Measurement placeholders (HTML comments that start with `TODO(measure)`) print as warnings. With `RELEASE=1 npm run lint`, they fail the check.

CI runs the tests and the checks on ubuntu and macOS with Node 20, 22 and 24, runs `shellcheck` on the guard, and runs `claude plugin validate --strict`. You can run the validator locally:

```sh
claude plugin validate --strict .
claude plugin validate --strict .claude-plugin/plugin.json
claude plugin validate --strict skills
```

## Test a change to the workflow

A real run spends tokens and takes time, so test workflow changes without agents first.

`tests/harness.mjs` runs `workflows/pipeline.js` with a simulated agent runtime. Each agent call returns a scripted reply instead of calling a model. Use it to check the parts that live in code: argument validation, branching, stop codes, the agent cap and resume behavior. Add a `tests/*.test.mjs` file that drives the harness for any branch you add or change, so `npm test` covers it.

Then run the change for real on a small public issue, in `triage` mode first and `quick` mode next. `/workflows` shows each agent and its token use while a run is in progress. As a guide, at effort `medium` a triage run took 30 to 60 seconds, and a quick run measured on one real issue took 7 to 8 minutes. Time varies with the repository's test suite and environment setup.

### Why `pipeline.js` is one file

The Claude Code workflow runtime loads a workflow as a single script and supports no imports. Helpers, schemas and prompts all live in `pipeline.js` for that reason. Keep `export const meta = { ... }` as the first statement, and keep it a plain literal with no variables: Claude Code reads it to register the workflow, and `npm run lint` checks it.

## Style

### Prompts and text people read

Prompts in `pipeline.js`, and the PR text, commit bodies and replies they ask agents to write, follow the plain-prose rules in `PROSE_RULES`:

- one idea per sentence, and at most 25 words (20 for a step the reader must do);
- one term for each thing and each action, reused every time, and the code's own identifiers for code;
- noun clusters of at most 3 words;
- active voice that names the actor (the function, the test, the user).

Docs in this repository follow the same rules. Write short sentences, avoid hype, and claim only what the code does.

### Code

- Keep the hook scripts POSIX: `#!/bin/sh`, no `[[`, no `local`, no `function` keyword. They must work with dash, bash in POSIX mode, BSD awk, gawk and mawk.
- Keep the publish guard leaning toward blocking. If the parser itself fails (an awk error), the hook blocks the command (exit 2). A subagent's publishing command whose directory cannot be resolved is denied, and so is a subagent's command past one of the reading bounds. A hook that times out may not block the call, so keep the cost of every step bounded. A command the parser misreads can still pass, so a new command form it should see through (a wrapper, a keyword, a nested shell, a continuation) needs a case in `tests/publish-guard.test.mjs`.
- Every agent call in `pipeline.js` goes through `ask()`, so the effort profile, the model choice and the agent cap apply to it.
- Treat text from issues, repositories and tool output as data, never as instructions.
- Never add a step that pushes, comments, forks or opens a pull request without the user's approval.

## Propose a change

1. For anything larger than a small fix, open an issue first, so we can agree on the approach before you spend time on it.
2. Create a branch, make the change, and run `npm test` and `npm run lint`.
3. Update the docs and the `[Unreleased]` section of `CHANGELOG.md` when behavior changes.
4. Open a pull request and fill in the template.

## Release a version

1. Move the `[Unreleased]` entries in `CHANGELOG.md` under a new `## [x.y.z] - YYYY-MM-DD` heading, and update the links at the bottom.
2. Bump the version in `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `package.json`, `CHANGELOG.md` and the README version badge (its alt text `Version x.y.z` and `version-x.y.z` in its shields.io URL) together. `npm run lint` fails if they differ.
3. Run `npm test` and `RELEASE=1 npm run lint`. The release check also fails on any `TODO(measure)` placeholder left in the repository.
4. Tag the release `vx.y.z` (`git tag -a vx.y.z -m vx.y.z`), push the tag through the project's approved publish path, and create the GitHub release from the version's `CHANGELOG.md` section. The links at the bottom of `CHANGELOG.md` point at the tag and the release, so they stay broken until both exist.
5. If `assets/social-preview.png` changed (it is made from `assets/social-preview.svg`), re-upload it under the repository's **Settings → General → Social preview**. GitHub does not read it from the repository.
6. Check that private vulnerability reporting is on (**Settings → Code security**), so the channel in [SECURITY.md](SECURITY.md) works.

## AI-assisted contributions

AI-assisted contributions are welcome under two conditions:

- disclose the assistance in the pull request (the template has a place for it);
- review and understand every line you submit, and run the tests yourself.

You are responsible for the change, whoever or whatever wrote the first draft.

## License

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
