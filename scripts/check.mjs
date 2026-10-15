#!/usr/bin/env node
// Repository consistency checks for resolve-issue. Zero dependencies; Node 20+. Run with `npm run lint`.
// Prints every failure as `FAIL <file>[:<line>]: <reason>` and exits 1 if there is any.
// Set RELEASE=1 to also fail on leftover TODO(measure) placeholders (they are warnings otherwise).
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname, relative, resolve, sep, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import vm from 'node:vm'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SELF = 'scripts/check.mjs'
const RELEASE = process.env.RELEASE === '1'
const PLUGIN_NAME = 'resolve-issue'

const failures = []
const warnings = []
const fail = (file, reason, line) => failures.push({ file, line, reason })
const warn = (file, reason, line) => warnings.push({ file, line, reason })

// ── Files: what git would track (committed or not ignored), or a directory walk without git.
function listFiles() {
  try {
    const out = execFileSync('git', ['-C', ROOT, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const files = out.split('\0').filter(Boolean).filter(f => existsSync(join(ROOT, f)))
    if (files.length) return files.sort()
  } catch { /* not a git checkout: walk instead */ }
  const skip = new Set(['.git', 'node_modules', 'coverage', 'results'])
  const files = []
  const walk = dir => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (skip.has(e.name) || e.name === '.DS_Store') continue
      const rel = dir ? `${dir}/${e.name}` : e.name
      if (e.isDirectory()) walk(rel)
      else if (e.isFile()) files.push(rel)
    }
  }
  walk('')
  return files.sort()
}
const FILES = listFiles()
const textCache = new Map()
function readText(rel) {
  if (textCache.has(rel)) return textCache.get(rel)
  let text = null
  try {
    const buf = readFileSync(join(ROOT, rel))
    if (!buf.subarray(0, 8192).includes(0)) text = buf.toString('utf8')
  } catch { /* unreadable */ }
  textCache.set(rel, text)
  return text
}
const TEXT_FILES = FILES.filter(f => !/\.(png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|otf|mp4|webm|zip|gz)$/i.test(f) && readText(f) != null)
const lineOf = (text, index) => text.slice(0, index).split('\n').length

// ── Reading JavaScript object literals without running the file around them.
// Returns the source text of the balanced {...} that starts at `start`, skipping strings and comments.
function sliceObjectLiteral(src, start) {
  let depth = 0
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++
    } else if (c === '/' && src[i + 1] === '/') {
      i = src.indexOf('\n', i); if (i < 0) return null
    } else if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2) + 1; if (i <= 0) return null
    } else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return src.slice(start, i + 1)
  }
  return null
}
// Evaluates a literal in an empty sandbox. Any identifier lookup (a variable, a global, `undefined`) throws,
// so a literal that evaluates here has no free identifiers.
function evalLiteral(text) {
  const scope = new Proxy({}, {
    has: (_, key) => typeof key === 'string',
    get: (_, key) => { if (typeof key === 'symbol') return undefined; throw new Error(`free identifier \`${key}\``) },
  })
  if (/\$\{/.test(text)) throw new Error('template substitution `${...}` inside the literal')
  return vm.runInNewContext(`(function () { with (__scope) { return (${text}) } })()`, { __scope: scope }, { timeout: 1000 })
}
function readLiteral(file, src, declaration) {
  const at = src.indexOf(declaration)
  if (at < 0) { fail(file, `cannot find \`${declaration}\``); return null }
  const text = sliceObjectLiteral(src, at + declaration.length - 1)
  if (!text) { fail(file, `the literal after \`${declaration}\` is not balanced`, lineOf(src, at)); return null }
  try { return { value: evalLiteral(text), end: at + declaration.length - 1 + text.length } } catch (e) {
    fail(file, `the literal after \`${declaration}\` does not evaluate on its own: ${e.message}`, lineOf(src, at)); return null
  }
}

// ── (a) Every JSON file parses.
const json = {}
for (const f of TEXT_FILES.filter(f => f.endsWith('.json'))) {
  try { json[f] = JSON.parse(readText(f)) } catch (e) { fail(f, `invalid JSON: ${e.message}`) }
}
const PLUGIN_JSON = '.claude-plugin/plugin.json', MARKET_JSON = '.claude-plugin/marketplace.json', PACKAGE_JSON = 'package.json'
for (const f of [PLUGIN_JSON, MARKET_JSON, PACKAGE_JSON]) if (!FILES.includes(f)) fail(f, 'missing')
const plugin = json[PLUGIN_JSON] || {}, market = json[MARKET_JSON] || {}, pkg = json[PACKAGE_JSON] || {}
const marketPlugins = Array.isArray(market.plugins) ? market.plugins.filter(p => p && typeof p === 'object') : []
const namedEntry = marketPlugins.find(p => p.name === PLUGIN_NAME)
if (json[MARKET_JSON] && !namedEntry) fail(MARKET_JSON, `no entry named "${PLUGIN_NAME}" in plugins[]`)
// With a single entry, check it even when its name is wrong, so the name and version checks below report it.
const marketEntry = namedEntry || (marketPlugins.length === 1 ? marketPlugins[0] : undefined)

// ── (b) One version everywhere: plugin.json, the marketplace entry, package.json, the top CHANGELOG release and the README badge.
const versions = [[PLUGIN_JSON, plugin.version], [`${MARKET_JSON} (plugins[${PLUGIN_NAME}])`, marketEntry && marketEntry.version], [PACKAGE_JSON, pkg.version]]
const changelog = FILES.includes('CHANGELOG.md') ? readText('CHANGELOG.md') : null
if (changelog == null) fail('CHANGELOG.md', 'missing')
else {
  const released = [...changelog.matchAll(/^## \[([^\]]+)\]/gm)].find(m => !/^unreleased$/i.test(m[1]))
  if (!released) fail('CHANGELOG.md', 'no released entry (## [x.y.z] - YYYY-MM-DD)')
  else {
    versions.push([`CHANGELOG.md:${lineOf(changelog, released.index)}`, released[1]])
    const heading = changelog.slice(released.index).split('\n')[0]
    if (!/^## \[\d+\.\d+\.\d+[^\]]*\] - \d{4}-\d{2}-\d{2}$/.test(heading)) fail('CHANGELOG.md', `release heading should read "## [x.y.z] - YYYY-MM-DD": ${heading}`, lineOf(changelog, released.index))
  }
}
// The README version badge names the version twice: in its alt text and in its shields.io URL (where `--` is a literal `-`).
const README = 'README.md'
const readme = FILES.includes(README) ? readText(README) : null
if (readme == null) fail(README, 'missing')
else {
  const badges = [...readme.matchAll(/<img\b[^>]*\balt="Version ([^"]*)"[^>]*>/g)]
  if (!badges.length) fail(README, 'no version badge (<img alt="Version x.y.z" src="https://img.shields.io/badge/version-x.y.z-<color>">)')
  for (const b of badges) {
    const line = lineOf(readme, b.index)
    const url = /\bsrc="[^"]*\/badge\/version-((?:[^-"]|--)+)-[^"]*"/.exec(b[0])
    versions.push([`${README}:${line} (version badge alt text)`, b[1]])
    if (!url) fail(README, 'the version badge URL should contain /badge/version-x.y.z-<color>', line)
    else versions.push([`${README}:${line} (version badge URL)`, url[1].replace(/--/g, '-')])
  }
}
const version = plugin.version
for (const [where, v] of versions) {
  if (typeof v !== 'string' || !v) fail(where, 'no version')
  else if (v !== version) fail(where, `version ${v} differs from ${PLUGIN_JSON} (${version})`)
}

// ── (c) One plugin name everywhere.
for (const [where, n] of [[PLUGIN_JSON, plugin.name], [`${MARKET_JSON} (plugins[])`, marketEntry && marketEntry.name], [PACKAGE_JSON, pkg.name]]) {
  if (n !== PLUGIN_NAME) fail(where, `plugin name is ${JSON.stringify(n)}, expected "${PLUGIN_NAME}"`)
}

// ── (e) workflows/pipeline.js: meta literal, phases, and the MODES table.
const PIPELINE = 'workflows/pipeline.js'
const pipeline = FILES.includes(PIPELINE) ? readText(PIPELINE) : null
let meta = null, modes = null
if (pipeline == null) fail(PIPELINE, 'missing')
else {
  if (!pipeline.startsWith('export const meta = {')) fail(PIPELINE, "must start with 'export const meta = {' (the workflow runtime reads meta from the top of the file)", 1)
  const m = readLiteral(PIPELINE, pipeline, 'export const meta = {')
  if (m) {
    meta = m.value
    if (typeof meta.name !== 'string' || !meta.name) fail(PIPELINE, 'meta.name is missing')
    if (typeof meta.description !== 'string' || !meta.description) fail(PIPELINE, 'meta.description is missing')
    if (!Array.isArray(meta.phases) || !meta.phases.length) fail(PIPELINE, 'meta.phases is missing or empty')
    const titles = new Set((meta.phases || []).map(p => p && p.title))
    for (const [i, p] of (meta.phases || []).entries()) if (!p || typeof p.title !== 'string' || !p.title) fail(PIPELINE, `meta.phases[${i}] has no title`)
    const body = pipeline.slice(m.end)
    const offset = m.end
    for (const call of body.matchAll(/(^|[^.\w$])phase\(\s*([^)]*)\)/g)) {
      const arg = call[2].trim(), line = lineOf(pipeline, offset + call.index + call[1].length)
      const lit = /^(['"`])([^'"`$]*)\1$/.exec(arg)
      if (!lit) fail(PIPELINE, `phase() takes a string literal title so it can be matched to meta.phases; got ${arg || 'nothing'}`, line)
      else if (!titles.has(lit[2])) fail(PIPELINE, `phase('${lit[2]}') has no matching title in meta.phases`, line)
    }
    // Agent options name their phase too ({ label, phase: '<title>' }); those must match as well.
    for (const opt of body.matchAll(/\bphase:\s*(['"])([^'"]*)\1/g)) {
      if (!titles.has(opt[2])) fail(PIPELINE, `agent option phase: '${opt[2]}' has no matching title in meta.phases`, lineOf(pipeline, offset + opt.index))
    }
  }
  const md = readLiteral(PIPELINE, pipeline, 'const MODES = {')
  if (md) modes = md.value
}

// ── (d) skills/resolve-issue/SKILL.md: frontmatter and Workflow references.
const SKILL = 'skills/resolve-issue/SKILL.md'
const skill = FILES.includes(SKILL) ? readText(SKILL) : null
if (skill == null) fail(SKILL, 'missing')
else {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(skill)
  if (!fm) fail(SKILL, 'no YAML frontmatter (--- ... --- at the top)', 1)
  else {
    for (const key of ['name', 'description']) if (!new RegExp(`^${key}:[ \\t]*\\S`, 'm').test(fm[1])) fail(SKILL, `frontmatter has no \`${key}\``, 1)
    const nm = /^name:[ \t]*['"]?([^'"\n]+?)['"]?[ \t]*$/m.exec(fm[1])
    if (nm && nm[1] !== 'resolve-issue') fail(SKILL, `frontmatter name is "${nm[1]}"; it should match the skill folder "resolve-issue"`, 1)
  }
  const expected = meta && meta.name ? `${PLUGIN_NAME}:${meta.name}` : null
  const refs = [
    ...[...skill.matchAll(/\bWorkflow\(\s*([A-Za-z0-9_.:-]+)\s*\)/g)],
    ...[...skill.matchAll(/\bWorkflow\(\s*\{\s*name:\s*["']([^"']+)["']/g)],
    ...[...skill.matchAll(new RegExp(`(?<![/\\w])\`(${PLUGIN_NAME}:[A-Za-z0-9_-]+)\``, 'g'))],
  ]
  if (!refs.length) fail(SKILL, 'references no Workflow name')
  if (expected) for (const r of refs) if (r[1] !== expected) fail(SKILL, `Workflow name "${r[1]}" should be "${expected}" (<plugin name>:<meta.name of ${PIPELINE}>)`, lineOf(skill, r.index))
  const sp = [...skill.matchAll(/scriptPath:\s*["']([^"']+)["']/g)]
  if (!sp.length) fail(SKILL, 'no scriptPath fallback for the Workflow call')
  for (const s of sp) {
    const p = s[1].replace(/^\$\{CLAUDE_PLUGIN_ROOT\}\/?/, '')
    if (p === s[1]) fail(SKILL, `scriptPath "${s[1]}" should start with \${CLAUDE_PLUGIN_ROOT}/`, lineOf(skill, s.index))
    else if (!existsSync(join(ROOT, p))) fail(SKILL, `scriptPath "${s[1]}" points at a missing file`, lineOf(skill, s.index))
  }
}

// ── (f) Mode tables (SKILL.md, plus any other doc table with Mode and Cap columns) agree with MODES.
function modeTables(text) {
  const tables = [], lines = text.split('\n')
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i]) || !/^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) continue
    const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim().replace(/[`*]/g, ''))
    const head = cells(lines[i]).map(h => h.toLowerCase())
    const iMode = head.indexOf('mode'), iCap = head.indexOf('cap'), iTyp = head.findIndex(h => h.startsWith('typical'))
    if (iMode < 0 || iCap < 0) continue
    const rows = []
    for (let j = i + 2; j < lines.length && /^\s*\|/.test(lines[j]); j++) {
      const c = cells(lines[j])
      rows.push({ line: j + 1, mode: c[iMode], cap: c[iCap], typical: iTyp >= 0 ? c[iTyp] : undefined })
    }
    tables.push({ line: i + 1, rows })
  }
  return tables
}
const num = s => { const m = /\d+/.exec(s || ''); return m ? Number(m[0]) : NaN }
if (skill != null && modes) {
  const skillTables = modeTables(skill)
  if (!skillTables.length) fail(SKILL, 'no mode table (columns Mode, Typical agents, Cap)')
  const skillTypical = {}
  for (const t of skillTables) {
    const seen = new Set()
    for (const r of t.rows) {
      seen.add(r.mode)
      if (!modes[r.mode]) { fail(SKILL, `mode table lists "${r.mode}", which is not in MODES of ${PIPELINE}`, r.line); continue }
      if (num(r.cap) !== modes[r.mode].maxAgents) fail(SKILL, `mode table cap for ${r.mode} is ${r.cap}; MODES.${r.mode}.maxAgents is ${modes[r.mode].maxAgents}`, r.line)
      const typ = num(r.typical)
      if (r.typical === undefined || Number.isNaN(typ)) fail(SKILL, `mode table has no typical agent count for ${r.mode}`, r.line)
      else if (typ > modes[r.mode].maxAgents) fail(SKILL, `typical agents for ${r.mode} (${typ}) exceed its cap (${modes[r.mode].maxAgents})`, r.line)
      else skillTypical[r.mode] = typ
    }
    for (const k of Object.keys(modes)) if (!seen.has(k)) fail(SKILL, `mode table is missing mode "${k}"`, t.line)
  }
  for (const f of TEXT_FILES.filter(f => f.endsWith('.md') && f !== SKILL)) {
    for (const t of modeTables(readText(f))) for (const r of t.rows) {
      if (!modes[r.mode]) continue
      if (num(r.cap) !== modes[r.mode].maxAgents) fail(f, `mode table cap for ${r.mode} is ${r.cap}; MODES.${r.mode}.maxAgents is ${modes[r.mode].maxAgents}`, r.line)
      if (r.typical !== undefined && skillTypical[r.mode] !== undefined && num(r.typical) !== skillTypical[r.mode]) fail(f, `typical agents for ${r.mode} is ${r.typical}; ${SKILL} says ${skillTypical[r.mode]}`, r.line)
    }
  }
}

// ── (g) Relative Markdown links and images point at existing files.
const stripCode = text => text
  .replace(/^(\s*)(```|~~~)[^\n]*\n[\s\S]*?\n\s*\2[^\n]*$/gm, m => m.replace(/[^\n]/g, ' '))
  .replace(/`[^`\n]*`/g, m => ' '.repeat(m.length))
for (const f of TEXT_FILES.filter(f => f.endsWith('.md'))) {
  const text = stripCode(readText(f))
  const targets = [
    ...[...text.matchAll(/\]\(\s*<([^>\n]+)>[^)\n]*\)/g)],
    ...[...text.matchAll(/\]\(\s*([^)<>\s]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g)],
    ...[...text.matchAll(/^\s{0,3}\[[^\]\n]+\]:\s*<?([^>\s]+)>?/gm)],
    ...[...text.matchAll(/<(?:img|a|source)\b[^>]*?\s(?:src|href|srcset)=["']([^"']+)["']/gi)],
  ]
  for (const t of targets) {
    const raw = t[1].trim()
    if (!raw || raw.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) continue
    let path = raw.replace(/[?#].*$/, '')
    try { path = decodeURIComponent(path) } catch { /* keep as written */ }
    const abs = path.startsWith('/') ? join(ROOT, path) : join(ROOT, dirname(f), path)
    const line = lineOf(text, t.index)
    if (relative(ROOT, abs).split(sep)[0] === '..') fail(f, `link "${raw}" leaves the repository`, line)
    else if (!existsSync(abs)) fail(f, `link "${raw}" points at a missing file`, line)
  }
}

// ── (h) No machine-specific paths, and (i) leftover measurement placeholders.
// Checks (h) and (i) skip this script's own pattern list: the lines between the two marker comments.
// patterns:begin
const MACHINE_PATTERNS = ['/Users/', '/home/', 'osContribution', 'scratchpad', '/private/tmp/', '/private/var/folders/', '/var/folders/', 'C:\\Users\\']
const TODO_MEASURE = '<!-- TODO(measure)'
// patterns:end
for (const f of TEXT_FILES) {
  const lines = readText(f).split('\n')
  let exempt = false
  lines.forEach((l, i) => {
    if (f === SELF && l.trim() === '// patterns:begin') exempt = true
    if (exempt) { if (l.trim() === '// patterns:end') exempt = false; return }
    for (const p of MACHINE_PATTERNS) if (l.includes(p)) fail(f, `machine-specific path (${p}) in a tracked file`, i + 1)
    if (l.includes(TODO_MEASURE)) (RELEASE ? fail : warn)(f, `unmeasured placeholder: ${l.trim().slice(0, 120)}`, i + 1)
  })
}

// ── (j) hooks/hooks.json: commands point into ${CLAUDE_PLUGIN_ROOT}/hooks/, and `if` rules are Bash(...).
const HOOKS = 'hooks/hooks.json'
if (!FILES.includes(HOOKS)) fail(HOOKS, 'missing')
else if (json[HOOKS]) {
  const events = json[HOOKS].hooks
  let count = 0
  if (!events || typeof events !== 'object') fail(HOOKS, 'no "hooks" object')
  else for (const [event, groups] of Object.entries(events)) {
    for (const [gi, g] of (Array.isArray(groups) ? groups : []).entries()) {
      for (const [hi, h] of (Array.isArray(g && g.hooks) ? g.hooks : []).entries()) {
        const where = `${event}[${gi}].hooks[${hi}]`
        count++
        if (h.type === 'command') {
          const m = /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/([A-Za-z0-9._/-]+)/.exec(h.command || '')
          if (!m) fail(HOOKS, `${where}: command does not reference \${CLAUDE_PLUGIN_ROOT}/hooks/<file>: ${h.command}`)
          else if (!existsSync(join(ROOT, 'hooks', m[1])) || !statSync(join(ROOT, 'hooks', m[1])).isFile()) fail(HOOKS, `${where}: hooks/${m[1]} does not exist`)
        }
        if ('if' in h && !(typeof h.if === 'string' && /^Bash\(.+\)$/.test(h.if))) fail(HOOKS, `${where}: "if" should look like Bash(<pattern>); got ${JSON.stringify(h.if)}`)
      }
    }
  }
  if (!count) fail(HOOKS, 'registers no hooks')
}

// ── (k) the hook scripts are POSIX sh.
for (const SCRIPT of ['hooks/publish-guard.sh', 'hooks/run-marker.sh']) {
  const text = FILES.includes(SCRIPT) ? readText(SCRIPT) : null
  if (text == null) { fail(SCRIPT, 'missing'); continue }
  if (text.split('\n')[0] !== '#!/bin/sh') fail(SCRIPT, "first line must be '#!/bin/sh'", 1)
  text.split('\n').forEach((l, i) => {
    if (/^\s*#/.test(l)) return
    if (/\[\[\s/.test(l)) fail(SCRIPT, "'[[ ... ]]' is not POSIX sh; use '[ ... ]' or case", i + 1) // [[:space:]] in a regex is fine
    if (/^\s*function\s/.test(l)) fail(SCRIPT, "'function' is not POSIX sh; use name() { ... }", i + 1)
    if (/^\s*local\s/.test(l)) fail(SCRIPT, "'local' is not POSIX sh", i + 1)
    if (l.includes('$(<')) fail(SCRIPT, "'$(<file)' is not POSIX sh; use $(cat file)", i + 1)
  })
}

// ── Report.
const fmt = x => `${x.file.split(sep).join(posix.sep)}${x.line ? `:${x.line}` : ''}: ${x.reason}`
for (const w of warnings) console.log(`WARN ${fmt(w)}`)
for (const f of failures) console.log(`FAIL ${fmt(f)}`)
const tail = warnings.length ? `, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}${RELEASE ? '' : ' (RELEASE=1 turns placeholders into failures)'}` : ''
if (failures.length) {
  console.log(`check: ${failures.length} failure${failures.length === 1 ? '' : 's'}${tail} in ${FILES.length} files`)
  process.exit(1)
}
console.log(`check: ok, ${FILES.length} files${tail}`)
