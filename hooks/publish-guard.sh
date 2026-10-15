#!/bin/sh
# resolve-issue publish guard: a PreToolUse hook for Bash and MCP tools (see hooks.json).
#
# It denies publishing commands: git push, GitHub writes through gh, hub, curl or wget, no-mistakes runs that
# can publish, and write tools of GitHub MCP servers. An MCP tool whose input has a command string (a shell tool)
# has that string read like a Bash command, in the session's directory. The rules:
# 1. Run rule. For 12 hours after a resolve-issue run starts or resumes in this session (run-marker.sh
#    records it; nothing clears the record when the run ends), no subagent in the session may publish
#    anywhere, whether or not it belongs to the run. For an MCP tool without a command string, this is the
#    only rule.
# 2. Worktree rule. In a resolve-issue worktree (a git worktree with a .resolve-issue/ folder), a subagent
#    may never publish, and the main session needs the one-time token .resolve-issue/publish-approved.
#    The /resolve-issue skill creates it only after the user approves; the token covers one tool call (every
#    hook process of that call shares it) and expires after 15 minutes.
# 3. Unknown directory. A subagent's publishing command whose directory cannot be resolved (a cd or git -C to
#    a variable or to a folder that does not exist yet, a cd - before any cd, a pushd with no argument when
#    nothing was pushed) is denied in every session and repository while the guard is on, with or without a
#    run or a worktree. The main session's passes.
# 4. Bounds. A command nested more than 16 levels deep, with more than 65536 bytes of text to read, with more
#    than 1024 subshells and directory changes, with more than 64 publishing commands, or that names programs so
#    often that checking it would read more than 200000 words, is not read past that point: the rest could
#    publish from anywhere. A subagent may not run it at all, in any session; the
#    main session's is judged in the directory where reading stopped.
# Everything else passes through untouched. Turn the guard off with the plugin's publish_guard option.
# If the command cannot be parsed, it is blocked (fail closed). Defense in depth, not a sandbox: see
# docs/safety.md for what it does not see.

case "${CLAUDE_PLUGIN_OPTION_PUBLISH_GUARD:-true}" in
  false | FALSE | False | 0 | off | no) exit 0 ;;
esac

# In the C locale every awk and every shell counts bytes, so the bounds mean the same with any awk, shell and locale.
LC_ALL=C
export LC_ALL
here=$(dirname "$0")
records=$(awk -f "$here/publish-guard.awk") || {
  echo "resolve-issue publish guard: could not parse this command, so it was blocked to be safe. If this keeps happening, report it and turn the guard off with the plugin's publish_guard option." >&2
  exit 2
}

us=$(printf '\037')
data="${CLAUDE_PLUGIN_DATA:-${TMPDIR:-/tmp}/resolve-issue}"
# cur and prev are the directory and the previous one, empty when unknown. The directory stack is d1..d$nd, top
# last; nd is -1 when it is unknown. Each subshell level lv saves them in sc$lv, sp$lv, sn$lv and s${lv}d$i.
cur="" prev="" t="" nd=0 lv=0 agent="" tuid="" sid="" tool="" active="" lastdir="" lasttop=""
ran="a resolve-issue run started in this session within the last 12 hours, so no subagent in this session may publish (docs/troubleshooting.md says how to lift this early)"

deny() { # the first denial decides the call
  printf 'resolve-issue publish guard: %s\n' "$1" >&2
  exit 2
}

run_active() { # a resolve-issue run started in this session within the last 12 hours (looked up once)
  if [ -z "$active" ]; then
    active=no
    case $sid in '' | *[!A-Za-z0-9._-]*) ;; *) [ -n "$(find "$data/runs" -maxdepth 1 -name "$sid" -mmin -720 2>/dev/null)" ] && active=yes ;; esac
  fi
  [ "$active" = yes ]
}

resolve() { # resolve <base dir> <path>: print the physical path of the directory; print nothing if it cannot be known.
  # Run it as $(resolve …): its cd stays in that subshell.
  p=$2
  case $p in "\$HOME" | "\${HOME}") p=$HOME ;; "\$HOME/"*) p="$HOME/${p#"\$HOME/"}" ;; "\${HOME}/"*) p="$HOME/${p#"\${HOME}/"}" ;; esac
  case $p in *'$'* | *'`'*) return 0 ;; esac
  case $1 in '' | *'$'* | *'`'*) case $p in /*) ;; *) return 0 ;; esac ;; esac
  case $p in
    /*) ;;
    "~") p=$HOME ;;
    \~/*) p="$HOME/${p#"~/"}" ;;
    *) p="$1/$p" ;;
  esac
  # A folder that does not exist yet is unknown: the command may create it, or the cd may fail and leave the shell
  # where it was. So is a path longer than any real one.
  [ ${#p} -le 4096 ] || return 0
  cd "$p" 2>/dev/null || return 0
  p=$(pwd -P)
  [ ${#p} -le 1024 ] && printf '%s\n' "$p"
}

chdir() { # chdir <path>: move cur as cd does; `-` is the previous directory (unknown before the first cd)
  if [ "$1" = - ]; then set -- "$prev"; else set -- "$(resolve "$cur" "$1")"; fi
  prev=$cur
  cur=$1
}

check() { # check <target dir or empty if unknown> <what>
  if [ -n "$agent" ] && run_active; then deny "blocked \`$2\`: $ran. Publishing happens only after the user approves the result."; fi
  if [ -z "$1" ]; then
    [ -n "$agent" ] && deny "blocked \`$2\`: its directory cannot be resolved, so a subagent may not run it. Use a literal path to a folder that exists."
    return 0
  fi
  if [ "$1" != "$lastdir" ]; then lastdir=$1 lasttop=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null) || lasttop=""; fi
  top=$lasttop
  [ -n "$top" ] || return 0
  state="$top/.resolve-issue"
  [ -d "$state" ] || return 0
  [ -n "$agent" ] && deny "blocked \`$2\` in the resolve-issue worktree $top. Subagents never publish from a resolve-issue worktree; publishing happens only after the user approves the result."
  # Every hook entry that matches one tool call runs at the same time, so its processes race for the token:
  # one renames it to the call's receipt (an atomic step), and the others find that receipt.
  used="$state/publish-approved.used.${tuid:-$$}"
  if [ -n "$tuid" ] && [ -e "$used" ]; then return 0; fi
  if [ -n "$(find "$state" -maxdepth 1 -name publish-approved -mmin -15 2>/dev/null)" ] && mv "$state/publish-approved" "$used" 2>/dev/null; then return 0; fi
  if [ -n "$tuid" ] && [ -e "$used" ]; then return 0; fi # a sibling process took it just now
  if [ -n "$(find "$state" -maxdepth 1 -name publish-approved ! -mmin -15 2>/dev/null)" ]; then
    rm -f "$state/publish-approved"
    deny "blocked \`$2\` in the resolve-issue worktree $top: the approval token was older than 15 minutes, so it was removed. Ask the user again before publishing."
  fi
  deny "blocked \`$2\` in the resolve-issue worktree $top. Publish only after the user explicitly approves this publish; then run \`touch '$state/publish-approved'\` as its own command and retry. A token covers one tool call, so run one publishing command per call."
}

while IFS="$us" read -r kind a b; do
  case $kind in
    CWD) cur=$a; [ ${#cur} -le 1024 ] || cur="" ;;
    AGENT) agent=$a ;;
    TUID) tuid=$a ;;
    SID) sid=$a ;;
    TOOL) tool=$a ;;
    OPEN) # a subshell's cd, pushd and popd stay inside it
      lv=$((lv + 1)); eval "sc$lv=\$cur sp$lv=\$prev sn$lv=\$nd"
      i=1; while [ "$i" -le "$nd" ]; do eval "s${lv}d$i=\$d$i"; i=$((i + 1)); done ;;
    CLOSE)
      if [ "$lv" -gt 0 ]; then
        eval "cur=\$sc$lv prev=\$sp$lv nd=\$sn$lv"
        i=1; while [ "$i" -le "$nd" ]; do eval "d$i=\$s${lv}d$i"; i=$((i + 1)); done
        lv=$((lv - 1))
      fi ;;
    CD) chdir "$a" ;;
    PUSHD)
      if [ -n "$a" ]; then # push the directory (past 16 entries the stack is unknown) and move
        if [ "$nd" -ge 0 ] && [ "$nd" -lt 16 ]; then nd=$((nd + 1)); eval "d$nd=\$cur"; else nd=-1; fi
        chdir "$a"
      elif [ "$nd" -gt 0 ]; then eval "t=\$d$nd d$nd=\$cur"; prev=$cur; cur=$t # with no argument, swap the top two
      elif [ "$nd" -lt 0 ]; then prev=$cur; cur=""
      else prev="" cur=""; fi ;; # nothing pushed: bash fails and zsh goes home, so both become unknown
    POPD) # each Bash call starts a new shell with an empty directory stack, so a popd past what the command
      # pushed fails and changes nothing
      if [ "$nd" -gt 0 ]; then prev=$cur; eval "cur=\$d$nd"; nd=$((nd - 1))
      elif [ "$nd" -lt 0 ]; then prev=$cur; cur=""; fi ;;
    PUB)
      target=$cur
      [ -n "$a" ] && target=$(resolve "$cur" "$a")
      check "$target" "$b"
      ;;
    LIMIT) # the rest of the command was not read, so it could publish from anywhere
      [ -n "$agent" ] && deny "blocked \`$b\`: the guard does not read past this bound, so a subagent may not run it. Split the command, or write long text to a file first and pass the file."
      check "$cur" "$b"
      ;;
  esac
done <<EOF
$records
EOF

# MCP tools: a command string was read above like a Bash command. A GitHub tool (its server's name contains github, or
# its own name starts with github_) writes when its name, without that github_ prefix, starts with a write verb or ends
# in _write or _trigger.
case $tool in
  mcp__*__*)
    lower=$(printf '%s' "$tool" | tr '[:upper:]' '[:lower:]')
    name=${lower##*__}
    case ${lower%__*}/$name in *github*/* | */github_*) ;; *) name="" ;; esac
    case ${name#github_} in
      create_* | update_* | merge_* | push_* | delete_* | fork_* | add_* | remove_* | edit_* | close_* | reopen_* | \
      submit_* | request_* | assign_* | run_* | rerun_* | cancel_* | dispatch_* | upload_* | lock_* | unlock_* | \
      transfer_* | star_* | unstar_* | manage_* | dismiss_* | mark_* | set_* | approve_* | enable_* | disable_* | \
      reprioritize_* | *_write | *_trigger)
        if [ -n "$agent" ] && run_active; then deny "blocked \`$tool\`: $ran."; fi ;;
    esac
    ;;
esac
exit 0
