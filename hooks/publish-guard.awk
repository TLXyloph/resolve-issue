# Parser for publish-guard.sh. Reads the PreToolUse hook JSON on stdin and prints one record per line,
# fields separated by ASCII unit separator (\037) so empty fields survive the shell's read:
#   CWD <us> dir         the shell's working directory before the command runs
#   AGENT <us> id        set when a subagent (including a workflow agent) makes the call
#   TUID <us> id         the tool_use_id, shared by every hook process for this call
#   SID <us> id          the session_id (subagents share their session's id)
#   TOOL <us> name       the tool name (Bash, or an MCP tool such as mcp__github__create_pull_request)
#   OPEN / CLOSE         a subshell starts / ends: ( … ), $( … ), `…`, a heredoc body or here-string read as
#                        commands, the text of sh -c, or the string of env -S; a cd inside it does not leak out
#   CD <us> path         a `cd` at command position, in command order; the path `-` is the previous directory
#   PUSHD <us> path      a `pushd`; an empty path swaps the top two directories
#   POPD                 a `popd`
#   PUB <us> dir <us> what   a publishing command; dir is its `git -C` path, if any
#   LIMIT <us> <us> what     the command passed a fail-safe bound; the rest of it was not read
# A path that holds a newline prints as `$?`, which the shell side cannot resolve.
# Segments split on unquoted ; & | ( ) ` and newlines; a backslash-newline continues the line; # comments are
# dropped. A $( ) or ` ` inside double quotes stays in its word and is also parsed one level deeper.
# A heredoc body is data, except for the $( ) and ` ` of an unquoted one, unless it can run as commands: its
# command, or a later one on its line, names a shell (bash <<EOF, cat <<EOF | sh), or it is in the text of sh -c
# or eval.
# Publishing programs (git push, gh and gh-axi writes, no-mistakes publishing runs, curl, wget and hub writes to
# GitHub) are found at any word position, so keywords and wrappers (if, !, {, nice -n 10, timeout 30, sudo -u x,
# xargs …) do not hide them, except in the arguments of a program that never runs them (echo, grep …). The
# argument of sh/bash/zsh -c, a here-string given to a shell, the string of env -S and the text of eval are parsed
# one level deeper too; eval runs in the shell itself, so a cd in its text does move the directory. A cd behind a
# wrapper that starts a program (env cd, nice cd …) does not.
# Fail-safe bounds keep the hook far inside its timeout: a command nested more than MAXD levels deep, with more
# than MAXTEXT bytes of text to read (text read again one level deeper counts again), with more than MAXREC
# subshells and directory changes, with more than MAXPUB publishing commands, or whose checks would read more
# than MAXWORK words after the program names they find, is not read further (a LIMIT record), and counts as
# publishing.
# Plain POSIX awk: works with BWK awk (macOS), gawk and mawk. publish-guard.sh runs it with LC_ALL=C, so every
# awk counts bytes.

# The string value of the first "key": in the hook JSON. A string value equal to the key is not a key: it is
# not followed by a colon.
function jstr(json, key,    i, n, c, out) {
  if (!match(json, "\"" key "\"[ \t\r\n]*:")) return ""
  i = RSTART + RLENGTH
  n = length(json)
  while (i <= n && index(" \t\r\n:", substr(json, i, 1)) > 0) i++
  if (substr(json, i, 1) != "\"") return ""
  i++
  out = ""
  while (i <= n) {
    c = substr(json, i, 1)
    if (c == "\\") {
      i++
      c = substr(json, i, 1)
      if (c == "n") out = out "\n"
      else if (c == "t") out = out "\t"
      else if (c == "r") out = out "\r"
      else if (c == "b" || c == "f") out = out " "
      else if (c == "u") { out = out "?"; i += 4 }
      else out = out c
    } else if (c == "\"") {
      break
    } else {
      out = out c
    }
    i++
  }
  return out
}

# The index of the quote that closes the '…' or $'…' starting at s[i]; length(s) if it never closes.
function q_end(s, i,    n, c, ansi) {
  n = length(s); ansi = (substr(s, i, 1) == "$")
  for (i += 1 + ansi; i <= n; i++) { c = substr(s, i, 1); if (c == "\\" && ansi) i++; else if (c == "'") return i }
  return n
}

# The index of the character that closes the text starting at s[i]: e is ")" for $( ), "`" for backticks and
# "\"" for double quotes. Quotes, nested substitutions, comments and heredoc bodies are skipped; inside $(( ))
# or (( )), << is a shift. Returns length(s) + 1 if it never closes.
function close_of(s, i, e,    n, c, pd, ar, bnd, hq, H, nh, k) {
  n = length(s); pd = 0; ar = 0; bnd = 1; hq = ""
  for (; i <= n; i++) {
    c = substr(s, i, 1)
    if (c == "\\") { i++; bnd = 0; continue }
    if (e == "`") { if (c == "`") return i; continue }
    if (substr(s, i, 2) == "$$") { i++; bnd = 0; continue } # the shell's PID: neither $' nor $( starts here
    if (e == "\"") { if (c == "\"") return i; if (c == "$" || c == "`") { k = sub_at(s, i); if (k) i = k } continue }
    if (c == "'" || substr(s, i, 2) == "$'") { i = q_end(s, i); bnd = 0; continue }
    if (c == "\"") { i = close_of(s, i + 1, "\""); bnd = 0; continue }
    if (c == "`") { i = close_of(s, i + 1, "`"); bnd = 0; continue }
    if (c == "#" && bnd) { while (i < n && substr(s, i + 1, 1) != "\n") i++; continue }
    if (substr(s, i, 3) == "<<<") { i += 2; bnd = 1; continue }
    if (substr(s, i, 2) == "<<" && !ar) { i = heredoc(s, i); hq = hq HREC; bnd = 0; continue }
    if (c == "(") { if (substr(s, i + 1, 1) == "(" && !ar) ar = pd + 1; pd++; bnd = 1; continue }
    if (c == ")") { if (pd == 0) return i; if (--pd < ar) ar = 0; bnd = 1; continue }
    if (c == "\n" && hq != "") { nh = split(hq, H, "\036"); hq = ""; for (k = 1; k < nh; k++) i = hd_end(s, i + 1, H[k]); bnd = 1; continue }
    bnd = (index(" \t\n;&|<>", c) > 0)
  }
  return n + 1
}

# If a command substitution $( ) or ` ` starts at s[i], the index of its last character; else 0. A $(( is arithmetic
# only when its parentheses close as )); otherwise, as in bash, it is a $( ) whose command starts with a subshell.
function sub_at(s, i,    j) {
  if (substr(s, i, 1) == "`") return close_of(s, i + 1, "`")
  if (substr(s, i, 2) != "$(") return 0
  j = close_of(s, i + 2, ")")
  if (substr(s, i + 2, 1) == "(" && close_of(s, i + 3, ")") == j - 1) return 0
  return j
}

# Add a SUB segment to SEG[d] for each $( ) and ` ` in s, the text of double quotes or of an unquoted
# heredoc body (where only a backslash quotes); return the new segment count.
function subs(s, d, ns,    i, j, k, n, c) {
  if (!index(s, "$(") && !index(s, "`")) return ns
  n = length(s)
  for (i = 1; i <= n; i++) {
    c = substr(s, i, 1)
    if (c == "\\" || substr(s, i, 2) == "$$") { i++; continue }
    if (c != "$" && c != "`") continue
    j = sub_at(s, i)
    if (!j) continue
    k = i + 1 + (c == "$")
    SEG[d, ++ns] = SUB substr(s, k, j - k); i = j
  }
  return ns
}

# Read the heredoc operator (<< or <<-) at s[i] and its delimiter word: 'EOF', "EOF", \EOF, E"O"F or EOF.
# Sets HREC to the pending heredoc (strip-tabs flag, quoted flag, delimiter, \036), or to "" if there is no
# word; returns the index of the word's last character.
function heredoc(s, i,    n, c, dl, dq, strip) {
  n = length(s); strip = (substr(s, i + 2, 1) == "-"); dl = ""; dq = 0
  for (i += 2 + strip; substr(s, i, 1) == " " || substr(s, i, 1) == "\t"; i++) ;
  for (; i <= n; i++) {
    c = substr(s, i, 1)
    if (c == "\\") { dq = 1; dl = dl substr(s, ++i, 1); continue }
    if (c == "'" || c == "\"") { dq = 1; for (i++; i <= n && substr(s, i, 1) != c; i++) dl = dl substr(s, i, 1); continue }
    if (index(" \t\n;&|()<>", c)) break
    dl = dl c
  }
  HREC = (dl == "" && !dq) ? "" : ((strip ? "-" : "+") (dq ? "q" : "u") dl "\036")
  return i - 1
}

# Skip the body of the pending heredoc rec, which starts at s[i]: return the index of the newline that ends
# its delimiter line (length(s) if the body runs to the end). Sets BE to the index just past the body.
# In an unquoted body, a line that ends in an odd number of backslashes continues on the next line.
function hd_end(s, i, rec,    n, j, k, line) {
  n = length(s)
  for (; i <= n; i = j + 1) {
    for (j = i; j <= n && substr(s, j, 1) != "\n"; j++) ;
    line = substr(s, i, j - i)
    while (substr(rec, 2, 1) == "u" && j <= n && match(line, /\\+$/) && RLENGTH % 2) {
      for (k = j + 1; k <= n && substr(s, k, 1) != "\n"; k++) ;
      line = substr(line, 1, length(line) - 1) substr(s, j + 1, k - j - 1); j = k
    }
    if (substr(rec, 1, 1) == "-") sub(/^\t+/, "", line)
    if (line == substr(rec, 3)) { BE = i; return j > n ? n : j }
  }
  BE = n + 1
  return n
}

# Split cmd into SEG[d, 1..n] on unquoted separators; return n. A subshell's bounds become OPEN and CLOSE
# segments, and the text of each $( ) or ` ` inside double quotes or an unquoted heredoc body becomes a SUB
# segment. Comments are dropped, and so are heredoc bodies unless x is set or a shell is named from the start
# of the heredoc's command (after the last ;, &, && or || before it; a pipe does not end it) to the end of its
# line: that covers cat <<EOF | sh and cat > f <<EOF && sh f, but not source venv/bin/activate && python - <<EOF.
# A heredoc on a loop's or group's closer (done <<EOF, } <<EOF) feeds the whole loop, so it is tested from the
# start of its line. Each stretch of the line is tested once, from the last heredoc back.
function split_segments(cmd, d, x,    i, j, n, c, seg, ns, bt, bnd, pd, ar, hq, es, ls, ces, cls, run, e, H, nh, k, bs, HS, RUN, CL, nhs, nl, p1, rp, pq, pv) {
  n = length(cmd); seg = ""; ns = 0; bt = 0; bnd = 1; pd = 0; ar = 0; hq = ""; es = 1; ls = 1; ces = 0; nhs = 0; rp = 0; pq = 1; pv = 0
  for (i = 1; i <= n; i++) {
    c = substr(cmd, i, 1)
    if (c == "\\") { if (substr(cmd, i + 1, 1) != "\n") { seg = seg c substr(cmd, i + 1, 1); bnd = 0 } i++; continue }
    if (substr(cmd, i, 2) == "$$") { seg = seg "$$"; i++; bnd = 0; continue }
    if (c == "'" || substr(cmd, i, 2) == "$'") { j = q_end(cmd, i); seg = seg substr(cmd, i, j - i + 1); i = j; bnd = 0; continue }
    if (c == "\"") { j = close_of(cmd, i + 1, "\""); ns = subs(substr(cmd, i + 1, j - i - 1), d, ns); seg = seg substr(cmd, i, j - i + 1); i = j; bnd = 0; continue }
    if (c == "#" && bnd) { while (i < n && substr(cmd, i + 1, 1) != "\n" && !(bt && substr(cmd, i + 1, 1) == "`")) i++; continue }
    if (substr(cmd, i, 3) == "<<<") { seg = seg "<<<"; i += 2; bnd = 1; continue }
    if (substr(cmd, i, 2) == "<<" && !ar) {
      j = heredoc(cmd, i)
      if (HREC != "") {
        if (es != ces) { ces = es; cls = substr(cmd, es, 64) ~ /^([ \t]|\\\n)*(done|fi|esac|[})])([^A-Za-z0-9_]|$)/ }
        CL[++nhs] = cls || (rp >= es && substr(cmd, rp + 1, i - rp - 1) ~ /^([ \t]|\\\n|[0-9]*[<>]+&?[^ \t<>]*)*$/) # a loop's, group's or subshell's closer
        HS[nhs] = CL[nhs] ? ls : es
      }
      hq = hq HREC; seg = seg substr(cmd, i, j - i + 1); i = j; bnd = 0; continue
    }
    if (c == "(" || (c == "`" && !bt)) {
      if (c == "`") bt = 1; else { if (substr(cmd, i + 1, 1) == "(" && !ar) ar = pd + 1; pd++ }
      SEG[d, ++ns] = seg; seg = ""; SEG[d, ++ns] = OPEN; bnd = 1; continue
    }
    if (c == ")" || (c == "`" && bt)) {
      if (c == "`") bt = 0; else { if (--pd < ar) ar = 0; rp = i }
      SEG[d, ++ns] = seg; seg = ""; SEG[d, ++ns] = CLOSE; bnd = 1; continue
    }
    if (c == "&" && i > 1 && (index("<>", substr(cmd, i - 1, 1)) || substr(cmd, i + 1, 1) == ">")) { seg = seg c; bnd = 0; continue } # a redirection's & (>&, <&, &>) stays in its word
    if (index(";&|\n", c) > 0) {
      SEG[d, ++ns] = seg; seg = ""; bnd = 1
      # A new command starts after ; and after an & or | that is not part of a pipe (|, |&) or a redirection
      # (>&, <&, &>): so after &&, || and a background &.
      p1 = (i > 1) ? substr(cmd, i - 1, 1) : ""
      if (c == ";" || (c == "&" && p1 != ">" && p1 != "<" && p1 != "|" && substr(cmd, i + 1, 1) != ">") || (c == "|" && (p1 == "|" || substr(cmd, i + 1, 1) == "|"))) es = i + 1
      if (c != "\n") continue
      if (hq != "") { # the bodies start on the next line, in order
        nh = split(hq, H, "\036"); hq = ""; nl = i
        # Every HS[k] follows a separator, so testing the stretches between them one by one equals testing each
        # heredoc's whole span, at one pass over the line.
        run = x; e = nl
        for (k = nh - 1; k >= 1; k--) {
          if (!run && HS[k] < e) run = substr(cmd, HS[k], e - HS[k]) ~ /(^|[^A-Za-z0-9_.-])(sh|bash|zsh|dash|ksh|ssh|eval|source)([^A-Za-z0-9_.-]|$)/
          RUN[k] = run
          if (HS[k] < e) e = HS[k]
        }
        for (k = 1; k < nh; k++) if (CL[k] && !RUN[k]) { # a closer's loop or group may start on an earlier line
          if (!pv && pq < ls) pv = substr(cmd, pq, ls - pq) ~ /(^|[^A-Za-z0-9_.-])(sh|bash|zsh|dash|ksh|ssh|eval|source)([^A-Za-z0-9_.-]|$)/
          pq = ls; RUN[k] = pv
        }
        for (k = 1; k < nh; k++) {
          bs = i + 1; i = hd_end(cmd, bs, H[k])
          if (RUN[k]) SEG[d, ++ns] = SUB substr(cmd, bs, BE - bs)
          else if (substr(H[k], 2, 1) == "u") ns = subs(substr(cmd, bs, BE - bs), d, ns)
        }
      }
      es = ls = i + 1; nhs = 0; continue
    }
    seg = seg c; bnd = (c == " " || c == "\t" || c == "<" || c == ">")
  }
  SEG[d, ++ns] = seg
  return ns
}

# Split seg into words W[d, 1..n], removing quotes; return n. A $'…' word keeps a $, so it reads as computed.
# The shell does not expand a quoted ~ or a single-quoted $ at the start of a word, so such a word starts with
# ./ to stay a literal relative path ("~/x" is not $HOME/x).
function words(seg, d,    i, j, n, c, q, w, nw, inw) {
  n = length(seg); q = ""; w = ""; nw = 0; inw = 0
  for (i = 1; i <= n; i++) {
    c = substr(seg, i, 1)
    if (q == "'") { if (c == q) q = ""; else w = w c; continue }
    if (q == "\"") {
      if (c == q) { q = ""; continue }
      if (c == "\\") { i++; if (substr(seg, i, 1) != "\n") w = w substr(seg, i, 1); continue }
      j = 0
      if (substr(seg, i, 2) == "$$") j = i + 1
      else if (c == "$" || c == "`") j = sub_at(seg, i)
      if (!j) j = i
      w = w substr(seg, i, j - i + 1); i = j
      continue
    }
    if (substr(seg, i, 2) == "$$") { w = w "$$"; i++; inw = 1; continue }
    if (substr(seg, i, 2) == "$'") { j = q_end(seg, i); w = w "$" substr(seg, i + 2, j - i - 2); i = j; inw = 1; continue }
    if (c == "'" || c == "\"") { if (!inw && (substr(seg, i + 1, 1) == "~" || (c == "'" && substr(seg, i + 1, 1) == "$"))) w = "./"; q = c; inw = 1; continue }
    if (c == "\\") { i++; c = substr(seg, i, 1); if (c != "\n") { if (!inw && (c == "~" || c == "$")) w = "./"; w = w c; inw = 1 } continue }
    if (c == " " || c == "\t" || c == "\r" || c == "\n") { if (inw) { W[d, ++nw] = w; w = ""; inw = 0 } continue }
    w = w c; inw = 1
  }
  if (inw) W[d, ++nw] = w
  return nw
}

function has_all(list, a, b, c,    parts, k, n, seen) {
  n = split(list, parts, ",")
  for (k = 1; k <= n; k++) seen[parts[k]] = 1
  return (a in seen) && (b in seen) && (c in seen)
}

function prog(word,    k) { # the program name without its directory
  k = split(word, PARTS, "/")
  return PARTS[k]
}

# Stop reading: print a LIMIT record (once) and parse nothing more.
function stop(what) { if (!STOP) print "LIMIT" US US what; STOP = 1 }

# A path for a record. One that holds a newline would split the record, so it becomes `$?`, which the shell side
# cannot resolve.
function arg(p) { return p ~ /\n/ ? "$?" : p }

# Print a record that costs the shell side work (a subshell or a directory change) and return 1; past MAXREC
# of them, stop instead and return 0.
function rec(s) {
  if (STOP) return 0
  if (++NREC > MAXREC) { stop("a command with more than " MAXREC " subshells and directory changes"); return 0 }
  print s
  return 1
}

# Print a publishing record; past MAXPUB of them, stop instead.
function pub(dir, what) {
  if (STOP) return
  if (++NPUB > MAXPUB) stop("a command with more than " MAXPUB " publishing commands")
  else print "PUB" US arg(dir) US what
}

# Go one level deeper and return 1; past MAXD levels, stop instead and return 0.
function deeper() {
  if (++LV <= MAXD) return 1
  stop("a command nested more than " MAXD " levels deep")
  return 0
}

function shallower() { if (LV > 0) LV-- } # a stray ) (a case pattern's) can close more levels than opened

# A subshell: one level deeper, with its own directory.
function opened() { return deeper() && rec("OPEN") }

function closed() { shallower(); print "CLOSE" }

# Parse cmd at depth d; x is set when its heredoc bodies may run as commands (the text of sh -c or eval).
function parse(cmd, d, x,    ns, s, nw) {
  if (STOP) return
  if ((READ += length(cmd)) > MAXTEXT) { stop("a command too long to check (more than " MAXTEXT " bytes to read)"); return }
  ns = split_segments(cmd, d, x)
  for (s = 1; s <= ns && !STOP; s++) {
    if (SEG[d, s] == OPEN) opened()
    else if (SEG[d, s] == CLOSE) closed()
    else if (substr(SEG[d, s], 1, 2) == SUB) { if (opened()) { parse(substr(SEG[d, s], 3), d + 1, x); closed() } }
    else { nw = words(SEG[d, s], d); classify(SEG[d, s], nw, d) }
  }
}

# The index of the command word: skip env assignments, shell keywords, and wrappers with their options. Sets EXT
# when a wrapper runs the command as a program of its own (env, nice, sudo …, not command or builtin), and ENVS
# to the command string of env -S (--split-string).
function command_word(nw, d,    i, p, prev) {
  i = 1; prev = ""; EXT = 0; ENVS = ""
  while (i <= nw) {
    p = prog(W[d, i])
    if (W[d, i] == "time") { i++; if (i <= nw && W[d, i] == "-p") i++; continue } # the shell keyword (a path such as /usr/bin/time is a wrapper)
    if (W[d, i] ~ /^[A-Za-z_][A-Za-z0-9_]*=/ || p ~ /^(if|then|else|elif|do|while|until|!|\{)$/) { i++; continue }
    if (p ~ /^(env|command|builtin|exec|nohup|nice|sudo|doas|xargs|timeout|stdbuf|caffeinate|time)$/) { prev = p; if (p != "command" && p != "builtin") EXT = 1; i++; continue }
    if (prev == "env" && W[d, i] ~ /^(-S|--split-string)$/) { ENVS = W[d, i + 1]; i += 2; continue }
    if (prev == "env" && W[d, i] ~ /^(-S.|--split-string=)/) { ENVS = W[d, i]; sub(/^(-S|--split-string=)/, "", ENVS); i++; continue }
    if (prev != "" && W[d, i] ~ /^-/) { if (W[d, i] ~ /^-[nugCIskS]$/) i++; i++; continue }
    if (prev == "timeout" && W[d, i] ~ /^[0-9.]+[smhd]?$/) { prev = "-"; i++; continue }
    break
  }
  return i
}

# Whether a help option (--help, and -h when h is set) comes among W[d, j..nw], before any --: the program only
# prints its usage. hub pull-request and hub create, gh repo create and gh repo edit take -h with a value, and
# gh-axi passes -h on as a flag.
function helped(j, nw, d, h,    m) {
  for (m = j; m <= nw; m++) { if (W[d, m] == "--") return 0; if (W[d, m] == "--help" || (h && W[d, m] == "-h")) return 1 }
  return 0
}

# Skip git's global options after W[d, k] and return the index of its subcommand. Sets GDIR to the -C path, if
# any (each -C is relative to the one before, as git applies them), and GALIAS when a -c option defines an alias.
function git_opts(k, nw, d,    j, p) {
  GDIR = ""; GALIAS = 0
  for (j = k + 1; j <= nw; j++) {
    if (W[d, j] == "-C") { p = W[d, j + 1]; if (p != "") GDIR = (GDIR == "" || p ~ /^[\/~$]/) ? p : GDIR "/" p; j++; continue }
    if (W[d, j] == "-c") { if (W[d, j + 1] ~ /^alias\./) GALIAS = 1; j++; continue }
    if (W[d, j] ~ /^(--git-dir|--work-tree|--namespace|--exec-path|--config-env)$/) { j++; continue }
    if (W[d, j] ~ /^-/) continue
    break
  }
  return j
}

function git_push(k, nw, d,    j) {
  j = git_opts(k, nw, d)
  if (j <= nw && W[d, j] ~ /[$`]/) { pub(GDIR, "git with a subcommand computed at run time"); return 1 }
  if (j <= nw && (W[d, j] == "push" || GALIAS) && !helped(j + 1, nw, d, 1)) { pub(GDIR, GALIAS ? "git with an alias" : "git push"); return 1 }
  return 0
}

# gh, or the gh-axi wrapper. In a group that can write (GH_READS), every subcommand but a known read counts as a
# write, so gh's own aliases (pr new, secret remove) and newer subcommands count too. In a nested group (issue
# subissue, repo deploy-key) the next word is the subcommand. gh api writes with a write method, a field or a
# positional write method (gh-axi api POST …), and gh api graphql with a mutation.
function gh_write(k, nw, d, seg, axi,    j, a, b, c, v, w, ch, m, method, field) {
  a = ""; b = ""; c = ""
  for (j = k + 1; j <= nw; j++) {
    if (W[d, j] ~ /^(-R|--repo|--hostname)$/) { j++; continue }
    if (W[d, j] ~ /^-/) continue
    if (a == "") { a = W[d, j]; continue }
    if (b == "") { b = W[d, j]; continue }
    c = W[d, j]
    break
  }
  if (helped(k + 1, nw, d, !axi && !(a == "repo" && b ~ /^(create|new|edit)$/))) return 0
  if (a in GH_READS) {
    v = (b ~ /^(subissue|sub-issue|items?|fields?|deploy-key|autolink)$/) ? c : b
    if (v != "" && index(GH_READS[a], "|" v "|") == 0) { pub("", "gh " a " " b); return 1 }
    return 0
  }
  if (a == "api") {
    if (b == "graphql") { if (seg ~ /mutation/) { pub("", "gh api graphql mutation"); return 1 } return 0 }
    method = toupper(b) ~ /^(GET|HEAD|POST|PUT|PATCH|DELETE)$/ ? toupper(b) : ""; field = 0
    for (j = k + 1; j <= nw; j++) {
      w = W[d, j]
      if (w == "-X" || w == "--method") { method = toupper(W[d, j + 1]); j++; continue }
      if (w ~ /^--method=/) { method = toupper(substr(w, 10)); continue }
      if (w ~ /^(-f|-F|--field|--raw-field|--input)$/ || w ~ /^(--field=|--raw-field=|--input=)/) { field = 1; continue }
      if (w ~ /^-[A-Za-z]/ && match(w, /[FfHpqtX]/)) { # a short-option cluster: its first option that takes a value takes the rest or the next word
        m = RSTART; ch = substr(w, m, 1)
        if (ch == "X") { method = (m < length(w)) ? substr(w, m + 1) : W[d, j + 1]; sub(/^=/, "", method); method = toupper(method) }
        else if (ch == "f" || ch == "F") field = 1
        if (m == length(w)) j++
      }
    }
    if ((method != "" && method != "GET" && method != "HEAD") || (method == "" && field && !axi)) { pub("", "gh api " (method == "" ? "POST" : method)); return 1 }
  }
  return 0
}

function nm_publish(k, nw, d,    j, skip, intent, yes, s1, s2) {
  skip = ""; intent = 0; yes = 0; s1 = ""; s2 = ""
  for (j = k + 1; j <= nw; j++) {
    if (W[d, j] == "--skip") { skip = W[d, j + 1]; j++; continue }
    if (W[d, j] ~ /^--skip=/) { skip = substr(W[d, j], 8); continue }
    if (W[d, j] == "--intent" || W[d, j] ~ /^--intent=/) intent = 1
    if (W[d, j] == "--yes" || W[d, j] == "-y") yes = 1
    if (W[d, j] ~ /^-/) continue
    if (s1 == "") s1 = W[d, j]
    else if (s2 == "") s2 = W[d, j]
  }
  if (s1 == "axi") s1 = s2
  if (yes) { pub("", "no-mistakes --yes"); return 1 }
  if (s1 == "respond") { pub("", "no-mistakes axi respond"); return 1 }
  if (((s1 == "run" && intent) || s1 == "rerun") && !has_all(skip, "push", "pr", "ci")) { pub("", "no-mistakes " s1 " without --skip push,pr,ci"); return 1 }
  return 0
}

# Is u a URL whose host is github.com or one of its subdomains (api.github.com, uploads.github.com)?
function ghurl(u,    h) {
  h = tolower(u); sub(/^[a-z][a-z0-9+.-]*:\/\//, "", h); sub(/[\/?#].*/, "", h); sub(/^.*@/, "", h); sub(/:[0-9]*$/, "", h)
  return h == "github.com" || h ~ /\.github\.com$/
}

# A write method (-X, also at the end of a short-option cluster or with the method attached), an upload (-T)
# or a body (-d, -F, --data…, --form, --json, also inside a cluster) sent to a GitHub URL. -G/--get makes a body
# a query. Only the request URLs count (the operands and --url), not a GitHub URL inside an option's value such
# as a body or a header: in a short-option cluster, the first option that takes a value takes the rest of the
# word, or the next word.
function curl_write(k, nw, d,    j, w, m, ch, gh, method, body, up, get) {
  gh = 0; method = ""; body = 0; up = 0; get = 0
  for (j = k + 1; j <= nw; j++) {
    w = W[d, j]
    if (w == "--") { for (j++; j <= nw; j++) if (ghurl(W[d, j])) gh = 1; break }
    if (w ~ /^--/) {
      if (w ~ /^--url=/) { if (ghurl(substr(w, 7))) gh = 1; continue }
      if (w == "--url") { if (ghurl(W[d, j + 1])) gh = 1; j++; continue }
      if (w ~ /^--request=/) method = toupper(substr(w, 11))
      if (w == "--request") method = toupper(W[d, j + 1])
      if (w ~ /^--(data|form|json)/) body = 1
      if (w ~ /^--upload-file/) up = 1
      if (w == "--get") get = 1
      if (w !~ /=/ && w ~ CURL_LONG_VALUE) j++ # the option's value is the next word
      continue
    }
    if (w ~ /^-./) { # the first option in the cluster that takes a value takes the rest of the word, or the next word
      if (match(w, "[" CURL_SHORT_VALUE "]")) {
        m = RSTART; ch = substr(w, m, 1)
        if (index(substr(w, 2, m - 2), "G")) get = 1
        if (ch == "X") method = toupper(m < length(w) ? substr(w, m + 1) : W[d, j + 1])
        if (ch == "d" || ch == "F") body = 1
        if (ch == "T") up = 1
        if (m == length(w)) j++
      } else if (index(w, "G")) get = 1
      continue
    }
    if (ghurl(w)) gh = 1
  }
  if (gh && ((method != "" && method !~ /^(GET|HEAD)$/) || up || (body && !get))) { pub("", "curl write to GitHub"); return 1 }
  return 0
}

function hub_write(k, nw, d,    j, a, b) {
  a = ""; b = ""
  for (j = k + 1; j <= nw; j++) {
    if (W[d, j] ~ /^-/) continue
    if (a == "") { a = W[d, j]; continue }
    b = W[d, j]
    break
  }
  if (helped(k + 1, nw, d, 0)) return 0
  if (a ~ /^(push|pull-request|fork|create|delete|merge|sync)$/ || ((a == "issue" || a == "release") && b ~ /^(create|edit|update|delete|transfer)$/) || (a == "api" && nw > k + 2)) { pub("", "hub " a); return 1 }
  return 0
}

# A body (--post-data, --post-file, --body-data, --body-file) or a write --method sent to a GitHub URL; as for
# curl, only the request URLs count, not the values of options.
function wget_write(k, nw, d,    j, w, m, gh, write) {
  gh = 0; write = 0
  for (j = k + 1; j <= nw; j++) {
    w = W[d, j]
    if (w ~ /^--(post-data|post-file|body-data|body-file)/ || toupper(w) ~ /^--METHOD=(POST|PUT|PATCH|DELETE)/) write = 1
    if (w == "--method" && toupper(W[d, j + 1]) ~ /^(POST|PUT|PATCH|DELETE)$/) write = 1
    if (w == "--") { for (j++; j <= nw; j++) if (ghurl(W[d, j])) gh = 1; break }
    if (w ~ /^--/) { if (w !~ /=/ && w ~ WGET_LONG_VALUE) j++; continue }
    if (w ~ /^-./) {
      if (match(w, "[" WGET_SHORT_VALUE "]") && RSTART == length(w)) j++
      continue
    }
    if (ghurl(w)) gh = 1
  }
  if (gh && write) { pub("", "wget write to GitHub"); return 1 }
  return 0
}

function classify(seg, nw, d,    i, j, k, m, p, joined, c, s, w, t) {
  i = command_word(nw, d)
  if (ENVS != "") { # env -S runs its string as a command, with the words after it as more arguments
    joined = ENVS
    for (j = i; j <= nw; j++) joined = joined " " W[d, j]
    if (opened()) { parse(joined, d + 1, 0); closed() }
    return
  }
  if (i <= nw) {
    p = prog(W[d, i])
    if (p == "cd" || p == "pushd" || p == "popd") {
      if (EXT) return # run as a program of its own (env cd, nice cd …), it cannot move the shell
      j = i + 1 # skip options and redirections (>/dev/null, or > /dev/null with its target)
      while (j <= nw && (W[d, j] ~ /^-[LPeq@]+$/ || W[d, j] ~ /^[0-9]*[<>]/)) j += (W[d, j] ~ /^[0-9]*[<>]+[|&]?$/) ? 2 : 1
      if (j <= nw && W[d, j] == "--") j++
      if (p == "cd") rec("CD" US arg(j <= nw ? W[d, j] : "~"))
      else if (j <= nw && (p == "popd" || W[d, j] ~ /^([-+][0-9]+|-n)$/)) rec("CD" US "$?") # a stack rotation: unknowable, like any path with a $
      else rec(p == "popd" ? "POPD" : "PUSHD" US arg(j <= nw ? W[d, j] : ""))
      return
    }
    if (p == "eval") { # eval runs its text in this shell, so a cd in it moves the directory: a level, not a subshell
      joined = ""
      for (j = i + 1; j <= nw; j++) joined = joined (j > i + 1 ? " " : "") W[d, j]
      if (deeper()) { parse(joined, d + 1, 1); shallower() }
      return
    }
    if (p ~ /^(echo|printf|grep|egrep|fgrep|which|whereis|type)$/) return # these never run their arguments
  }
  if (i <= nw && W[d, i] ~ /[$`]/) { # the program itself is computed at run time: read it as git, which publishes when its subcommand is push
    j = git_opts(i, nw, d)
    if (j <= nw && (W[d, j] == "push" || GALIAS) && !helped(j + 1, nw, d, 1)) { pub(GDIR, "a command computed at run time, with push"); return }
  }
  for (k = 1; k <= nw && !STOP; k++) {
    p = prog(W[d, k])
    if (p !~ /^(sh|bash|zsh|dash|ksh|git|gh|no-mistakes|curl|hub|wget)$/ && p !~ /^gh-axi(@|$)/) continue
    # Each check below reads the words after the program, so a segment that names programs many times costs
    # their product: past MAXWORK words read, stop.
    if ((WORK += nw - k) > MAXWORK) { stop("a command too complex to check"); return }
    if (p ~ /^(sh|bash|zsh|dash|ksh)$/) { # the script is the first operand after the options, or a here-string
      c = 0; s = 0
      for (j = k + 1; j <= nw; j++) {
        w = W[d, j]
        if (w == "--" || w == "-") { j++; break }
        if (w ~ /^-[A-Za-z]*c[A-Za-z]*$/) c = 1
        if (w ~ /^-[A-Za-z]*s[A-Za-z]*$/) s = 1
        if (w ~ /^[-+][A-Za-z]+$/) { t = w; j += gsub(/[oO]/, "", t) } # each o or O in an option word takes the next word
        else if (w ~ /^--(rcfile|init-file)$/) j++
        else if (w ~ /^([0-9]*[<>]|&>)/ && substr(w, 1, 3) != "<<<") { if (w ~ /^([0-9]*[<>]+[|&]?|&>>?)$/) j++ } # a redirection (and its target), not an operand
        else if (w !~ /^[-+]/) break
      }
      if (c && j <= nw) { if (opened()) { parse(W[d, j], d + 1, 1); closed() } return }
      # Without -c, a here-string is the shell's input, so its text runs as commands: when it comes before any
      # script operand, or anywhere with -s (bash <<< 'cmd', sh -s arg <<< "cmd").
      if (!c) for (m = j; m <= nw; m++) if (substr(W[d, m], 1, 3) == "<<<" && (m == j || s)) {
        t = (W[d, m] == "<<<") ? W[d, m + 1] : substr(W[d, m], 4)
        if (opened()) { parse(t, d + 1, 1); closed() }
        return
      }
    }
    else if (p == "git") { if (git_push(k, nw, d)) return }
    else if (p == "gh" || p ~ /^gh-axi(@|$)/) { if (gh_write(k, nw, d, seg, p != "gh")) return }
    else if (p == "no-mistakes") { if (nm_publish(k, nw, d)) return }
    else if (p == "curl") { if (curl_write(k, nw, d)) return }
    else if (p == "hub") { if (hub_write(k, nw, d)) return }
    else if (p == "wget") { if (wget_write(k, nw, d)) return }
  }
}

BEGIN {
  US = "\037"; OPEN = "\001("; CLOSE = "\001)"; SUB = "\001$"
  MAXD = 16; MAXTEXT = 65536; MAXREC = 1024; MAXPUB = 64; MAXWORK = 200000
  # gh groups that can write, with their reads; every other subcommand of these groups counts as a write
  GH_READS["pr"] = "|list|ls|view|status|checkout|co|checks|diff|"
  GH_READS["issue"] = "|list|ls|view|status|"
  GH_READS["repo"] = "|list|ls|view|clone|set-default|gitignore|license|read-file|read-dir|"
  GH_READS["release"] = "|list|ls|view|download|verify|verify-asset|"
  GH_READS["gist"] = "|list|ls|view|clone|"
  GH_READS["run"] = "|list|ls|view|watch|download|"
  GH_READS["workflow"] = "|list|ls|view|"
  GH_READS["label"] = "|list|ls|"
  GH_READS["secret"] = "|list|ls|"
  GH_READS["variable"] = "|list|ls|get|"
  GH_READS["cache"] = "|list|ls|"
  GH_READS["project"] = "|list|ls|view|field-list|item-list|"
  GH_READS["discussion"] = "|list|ls|view|"
  GH_READS["agent-task"] = "|list|ls|view|"
  GH_READS["stack"] = "|view|checkout|up|down|top|bottom|trunk|"
  GH_READS["skill"] = "|list|ls|search|preview|install|update|"
  # curl and wget options whose value is the next word (or the rest of a short-option cluster), never a URL
  CURL_SHORT_VALUE = "AbcCdDeEFHKmoPQrtTuUwxXyYz"
  CURL_LONG_VALUE = "^--(data(-ascii|-binary|-raw|-urlencode)?|json|form(-string)?|header|proxy-header|user(-agent)?|referer|output(-dir)?|upload-file|cookie(-jar)?|config|write-out|url-query|request|proxy(-user)?|preproxy|noproxy|max-time|connect-timeout|range|continue-at|dump-header|cert|key|cacert|capath|resolve|connect-to|retry(-delay|-max-time)?|limit-rate|unix-socket|oauth2-bearer|aws-sigv4|variable|trace(-ascii)?|stderr|max-redirs|time-cond|hsts|alt-svc|etag-(save|compare)|expect100-timeout|keepalive-time|mail-(from|rcpt|auth)|proto(-redir)?|interface|local-port|speed-(limit|time)|ciphers|max-filesize|create-file-mode|quote|ftp-port|socks(4a?|5|5-hostname)|doh-url)$"
  WGET_SHORT_VALUE = "eoaiBtOTwQUPlARDIXn"
  WGET_LONG_VALUE = "^--(post-data|post-file|body-data|body-file|method|header|user|password|http-user|http-password|proxy-user|proxy-password|user-agent|referer|output-document|output-file|append-output|input-file|base|directory-prefix|load-cookies|save-cookies|tries|timeout|dns-timeout|connect-timeout|read-timeout|wait|waitretry|quota|level|accept|reject|domains|exclude-domains|include-directories|exclude-directories|execute|limit-rate|bind-address|ca-certificate|certificate|private-key|ca-directory|default-page|restrict-file-names|progress|cut-dirs|accept-regex|reject-regex|config)$"
}

{ buf = buf $0 "\n" }

END {
  cwd = jstr(buf, "cwd")
  print "CWD" US (cwd ~ /\n/ ? "" : cwd)
  print "AGENT" US jstr(buf, "agent_id")
  print "TUID" US jstr(buf, "tool_use_id")
  print "SID" US jstr(buf, "session_id")
  print "TOOL" US jstr(buf, "tool_name")
  # Only a command is read: Bash's, or the command string of an MCP tool that has one (a shell tool), in the session's directory. Any other
  # MCP tool is judged by its name alone, whatever the size of its input.
  if (!match(buf, /"command"[ \t\r\n]*:[ \t\r\n]*"/)) exit
  # Decoding the command costs time in proportion to the square of the input's length in some awks, so a hook
  # input too long to hold a short enough command is refused before decoding (JSON escapes can double the length).
  if (length(buf) > 2 * MAXTEXT + 4096) stop("a command too long to check (more than " MAXTEXT " bytes to read)")
  else parse(jstr(buf, "command"), 1, 0)
}
