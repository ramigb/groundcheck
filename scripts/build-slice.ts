// build-slice.ts — computes slice.json (facts only) for a git range.
// SLICE_FORMAT v0.6.0. No judgment, no prose, no model calls: every field here
// is derived from git plus the TypeScript type checker.
//
// Usage:
//   node scripts/build-slice.ts --repo <path> --range <a..b> [--depth 1]
//        [--tokens <glob>] [--routes <glob>] [--collapse dir] [--tsconfig <path>]
//        [--worktree] [--pr <n> [--pr-state open|merged|closed]] --out slice.json
// --tokens and --routes are repeatable; defaults `**/tokens.{ts,js}` and
// `**/pages/**` + `**/app/**`.
//
// Exit codes: 0 success · 2 empty or invalid range · 3 project load failure.
import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as nodePath from 'node:path'
import { parseArgs } from 'node:util'
import { Node, Project, SyntaxKind, type SourceFile } from 'ts-morph'

const SLICE_VERSION = '0.6.0'
const MAX_DRAWN_NODES_HINT = 20

type Kind = 'component' | 'hook' | 'type' | 'token' | 'route' | 'module'
type Status = 'added' | 'modified' | 'deleted' | 'blast' | 'context'
type EdgeType = 'renders' | 'consumes-type' | 'calls' | 'imports' | 'uses-token'

/** Kind precedence — SLICE_FORMAT enum order; first match wins. */
const KIND_ORDER: Kind[] = ['component', 'hook', 'type', 'token', 'route', 'module']

type Span = { start: number; end: number }

type SliceNode = {
  id: string
  file: string
  symbol?: string
  kind: Kind
  status: Status
  blastDepth?: number
  spans: Span[]
  stats: { added: number; removed: number }
  exportedSymbolsChanged: string[]
  /** Diff lines as git reports them; only on changed nodes, <= 8 + gap marker. */
  excerpt?: { op: 'add' | 'del' | 'ctx' | 'gap'; text: string }[]
  /** Only on `--collapse dir` meta-nodes: the nodes this one stands for. */
  members?: SliceNode[]
}

type SliceEdge = {
  from: string
  to: string
  type: EdgeType
  evidence: { file: string; line: number; n?: number }
}

type ChangedFile = {
  path: string // repo-relative
  status: 'added' | 'modified' | 'deleted'
  added: number
  removed: number
  changedLines: Span[] // head-side line ranges (base-side for deletions)
}

type UngraphedFile = {
  file: string
  status: ChangedFile['status']
  spans: Span[]
  stats: { added: number; removed: number }
  excerpt?: ExcerptLine[]
}

function die(code: number, message: string): never {
  console.error(`build-slice: ${message}`)
  process.exit(code)
}

function git(repo: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error)
    die(2, `git ${args.join(' ')} failed: ${detail}`)
  }
}

/** Minimal glob support: `**`, `*`, `?`, `{a,b}`. Enough for --tokens / --routes. */
function globToRegExp(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` may match zero directories, so the slash is part of the group
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else out += '[^/]*'
    } else if (c === '?') out += '[^/]'
    else if (c === '{') {
      const close = glob.indexOf('}', i)
      if (close === -1) out += '\\{'
      else {
        out += `(?:${glob
          .slice(i + 1, close)
          .split(',')
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('|')})`
        i = close
      }
    } else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

const matchesAny = (relPath: string, globs: RegExp[]) => globs.some((re) => re.test(relPath))

/**
 * Codepoint order, matching plain `Array#sort` and the structural self-check.
 * `localeCompare` reorders punctuation (`/`, `-`) by locale, which broke sort
 * order on a monorepo and would make output machine-dependent.
 */
const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

// ── CLI ────────────────────────────────────────────────────────────────────
const { values } = (() => {
  try {
    return parseArgs({
      options: {
        repo: { type: 'string', default: '.' },
        range: { type: 'string' },
        depth: { type: 'string', default: '1' },
        tokens: { type: 'string', multiple: true },
        routes: { type: 'string', multiple: true },
        collapse: { type: 'string' },
        tsconfig: { type: 'string' },
        worktree: { type: 'boolean', default: false },
        pr: { type: 'string' },
        'pr-state': { type: 'string' },
        out: { type: 'string' },
      },
      allowPositionals: false,
    })
  } catch (error) {
    die(2, `${error instanceof Error ? error.message : String(error)}\n` + 'usage: build-slice.ts --repo <path> --range <a..b> --out <slice.json>')
  }
})()

if (!values.range) die(2, 'missing --range <a..b>')
if (!values.out) die(2, 'missing --out <slice.json>')
if (values.collapse && values.collapse !== 'dir') die(2, `--collapse accepts only "dir" (got "${values.collapse}")`)

// --pr is provenance, not a fact about the code: it lands in `generated` (the one
// nondeterministic block) so it cannot affect determinism of the slice proper.
const PR_STATES = ['open', 'merged', 'closed']
if (values['pr-state'] && !values.pr) die(2, '--pr-state needs --pr <number>')
if (values['pr-state'] && !PR_STATES.includes(values['pr-state']))
  die(2, `--pr-state accepts ${PR_STATES.join(' | ')} (got "${values['pr-state']}")`)
if (values.pr !== undefined && !/^\d+$/.test(values.pr)) die(2, `--pr must be a number (got "${values.pr}")`)
const pr = values.pr ? { number: Number(values.pr), state: values['pr-state'] ?? 'open' } : undefined

const repo = nodePath.resolve(values.repo!)
const worktreeMode = values.worktree === true
const depth = Number.parseInt(values.depth!, 10)
if (!Number.isInteger(depth) || depth < 1) die(2, `--depth must be an integer >= 1 (got "${values.depth}")`)

// Repeat the flag for several globs; commas are not separators (they occur
// inside brace groups such as `**/tokens.{ts,js}`).
const tokenGlobs = (values.tokens ?? ['**/tokens.{ts,js}']).map(globToRegExp)
const routeGlobs = (values.routes ?? ['**/pages/**', '**/app/**']).map(globToRegExp)

if (!values.range.includes('..')) die(2, `--range must be "<base>..<head>" (got "${values.range}")`)
const [baseRef, headRefRaw] = values.range.split('..')
if (!baseRef) die(2, `--range must name a base: "<base>..<head>" (got "${values.range}")`)
if (worktreeMode && headRefRaw && headRefRaw !== 'worktree')
  die(2, `--worktree diffs the base against the working tree, so --range must be "${baseRef}.." (got "${values.range}")`)
if (!worktreeMode && !headRefRaw)
  die(2, `--range must name both ends: "<base>..<head>" — or pass --worktree to diff "${baseRef}" against uncommitted work`)
if (!existsSync(nodePath.join(repo, '.git'))) die(2, `not a git worktree: ${repo}`)

const baseSha = git(repo, ['rev-parse', baseRef]).trim()
const worktreeSha = git(repo, ['rev-parse', 'HEAD']).trim()
const headSha = worktreeMode ? worktreeSha : git(repo, ['rev-parse', headRefRaw]).trim()
if (!worktreeMode && worktreeSha !== headSha)
  die(
    2,
    `worktree is at ${worktreeSha.slice(0, 7)} but --range head "${headRefRaw}" is ${headSha.slice(0, 7)}; ` +
      `check out ${headRefRaw} first, or pass --worktree to analyse uncommitted work`,
  )
// Recorded range and head: in worktree mode the head is not a commit, so say so
// rather than implying the uncommitted state is the sha it sits on.
const range = worktreeMode ? `${baseRef}..worktree` : values.range
const recordedHeadSha = worktreeMode ? `${headSha.slice(0, 7)}+worktree` : headSha.slice(0, 7)

// ── changed files from git ─────────────────────────────────────────────────
// Worktree mode: `git diff <base>` (no `..<head>`) compares base to the working
// tree, staged and unstaged together; untracked files are collected separately.
const diffTarget = worktreeMode ? [baseSha] : [`${baseSha}..${headSha}`]
const nameStatus = git(repo, ['diff', '--no-renames', '--name-status', ...diffTarget]).trim()
const untracked = worktreeMode
  ? git(repo, ['ls-files', '--others', '--exclude-standard'])
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  : []
if (!nameStatus && untracked.length === 0)
  die(2, `range "${range}" contains no file changes${worktreeMode ? ' (working tree is clean against the base)' : ''}`)

const STATUS_LETTERS: Record<string, ChangedFile['status']> = { A: 'added', M: 'modified', D: 'deleted' }
const changedFiles = new Map<string, ChangedFile>()
for (const line of nameStatus.split('\n')) {
  const [letter, filePath] = line.split('\t')
  const status = STATUS_LETTERS[letter?.[0] ?? '']
  if (!status || !filePath) continue
  changedFiles.set(filePath, { path: filePath, status, added: 0, removed: 0, changedLines: [] })
}

// Untracked files are part of the change under review in worktree mode; git
// diff cannot see them, so they are added whole.
for (const filePath of untracked) {
  if (changedFiles.has(filePath)) continue
  let lineCount = 0
  try {
    lineCount = readFileSync(nodePath.join(repo, filePath), 'utf8').split('\n').filter((_, index, all) => index < all.length - 1 || all[index] !== '').length
  } catch {
    continue // unreadable (binary, permissions): not reviewable, not invented
  }
  changedFiles.set(filePath, {
    path: filePath,
    status: 'added',
    added: lineCount,
    removed: 0,
    changedLines: [{ start: 1, end: Math.max(1, lineCount) }],
  })
}

for (const line of git(repo, ['diff', '--no-renames', '--numstat', ...diffTarget]).trim().split('\n')) {
  const [added, removed, filePath] = line.split('\t')
  const entry = filePath ? changedFiles.get(filePath) : undefined
  if (!entry) continue
  entry.added = Number.parseInt(added, 10) || 0
  entry.removed = Number.parseInt(removed, 10) || 0
}

/** Head-side changed line ranges per file, from a zero-context diff. */
function collectChangedLines() {
  const diff = git(repo, ['diff', '--no-renames', '--no-color', '-U0', ...diffTarget])
  let current: ChangedFile | undefined
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const filePath = line.slice(6) // strip "+++ b/"
      current = changedFiles.get(filePath)
      continue
    }
    if (!line.startsWith('@@') || !current) continue
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (!header) continue
    const start = Number.parseInt(header[1], 10)
    const count = header[2] === undefined ? 1 : Number.parseInt(header[2], 10)
    // A pure deletion has count 0; anchor it on the surviving line so the range
    // still intersects the symbol the lines were removed from.
    current.changedLines.push(count === 0 ? { start: Math.max(1, start), end: Math.max(1, start) } : { start, end: start + count - 1 })
  }
  for (const file of changedFiles.values()) {
    if (file.status === 'deleted') {
      const baseText = git(repo, ['show', `${baseSha}:${file.path}`])
      file.changedLines = [{ start: 1, end: Math.max(1, baseText.split('\n').length - 1) }]
    }
  }
}
collectChangedLines()

// ── diff excerpts (facts, not prose: the bytes git reports) ────────────────
const EXCERPT_CONTEXT_LINES = 2
const MAX_EXCERPT_LINES = 8 // DESIGN_CONTRACT § Panel structure

type ExcerptLine = { op: 'add' | 'del' | 'ctx' | 'gap'; text: string }
type Hunk = { changed: Span; lines: ExcerptLine[] }

/**
 * Hunks per file with a little context, keyed by repo-relative path. `changed`
 * is the head-side range of the hunk's +/- lines, so a symbol node can take the
 * hunks that touch it and leave the rest of the file alone.
 */
function collectHunks(): Map<string, Hunk[]> {
  const byFile = new Map<string, Hunk[]>()
  const diff = git(repo, ['diff', '--no-renames', '--no-color', `-U${EXCERPT_CONTEXT_LINES}`, ...diffTarget])
  let hunks: Hunk[] | undefined
  let hunk: Hunk | undefined
  let baseFilePath: string | undefined
  let headLine = 0
  for (const line of diff.split('\n')) {
    // File headers first: `--- a/x` starts with '-' and would otherwise be read
    // as a deleted line belonging to the previous file's last hunk.
    if (line.startsWith('diff --git ')) {
      hunks = undefined
      hunk = undefined
      baseFilePath = undefined
      continue
    }
    if (line.startsWith('--- ')) {
      baseFilePath = line === '--- /dev/null' ? undefined : line.slice(6) // strip "--- a/"
      continue
    }
    if (line.startsWith('+++ ')) {
      const filePath = line === '+++ /dev/null' ? baseFilePath : line.slice(6) // strip "+++ b/"
      hunks = filePath && changedFiles.has(filePath) ? [] : undefined
      if (hunks && filePath) byFile.set(filePath, hunks)
      hunk = undefined
      continue
    }
    if (line.startsWith('@@')) {
      const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      if (!header || !hunks) continue
      headLine = Number.parseInt(header[1], 10)
      hunk = { changed: { start: headLine, end: headLine }, lines: [] }
      hunks.push(hunk)
      continue
    }
    if (!hunk || !hunks) continue
    if (line.startsWith('\\')) continue // "\ No newline at end of file"
    if (line.startsWith('+')) {
      hunk.lines.push({ op: 'add', text: line.slice(1) })
      hunk.changed = { start: Math.min(hunk.changed.start, headLine), end: Math.max(hunk.changed.end, headLine) }
      headLine += 1
    } else if (line.startsWith('-')) {
      hunk.lines.push({ op: 'del', text: line.slice(1) })
      hunk.changed = { start: Math.min(hunk.changed.start, headLine), end: Math.max(hunk.changed.end, headLine) }
    } else if (line.startsWith(' ')) {
      hunk.lines.push({ op: 'ctx', text: line.slice(1) })
      headLine += 1
    }
  }
  return byFile
}
const hunksByFile = collectHunks()

/** First MAX_EXCERPT_LINES diff lines touching `spans`, plus an honest gap marker. */
function excerptFor(file: ChangedFile, spans: Span[]): ExcerptLine[] {
  const hunks = hunksByFile.get(file.path) ?? []
  const relevant = spans.length === 0 ? hunks : hunks.filter((hunk) => spans.some((span) => overlaps(span, hunk.changed)))
  const lines = (relevant.length ? relevant : hunks).flatMap((hunk) => hunk.lines)
  if (lines.length === 0 && file.status === 'added') {
    // Untracked file in --worktree mode: git diff cannot see it, so read it.
    try {
      const text = readFileSync(nodePath.join(repo, file.path), 'utf8').split('\n')
      const body = text[text.length - 1] === '' ? text.slice(0, -1) : text
      const head = body.slice(0, MAX_EXCERPT_LINES).map((text): ExcerptLine => ({ op: 'add', text }))
      return body.length > head.length
        ? [...head, { op: 'gap', text: `… ${body.length - head.length} more added lines` }]
        : head
    } catch {
      return []
    }
  }
  if (lines.length <= MAX_EXCERPT_LINES) return lines
  const kept = lines.slice(0, MAX_EXCERPT_LINES)
  const droppedChanges = lines.slice(MAX_EXCERPT_LINES).filter((line) => line.op !== 'ctx').length
  return [...kept, { op: 'gap', text: `… ${lines.length - kept.length} more diff lines (${droppedChanges} changed)` }]
}

// ── project ───────────────────────────────────────────────────────────────
// A monorepo root config is often solution-style (`"include": []` plus
// `references`), which resolves zero files; --tsconfig points at a real one.
const tsConfigFilePath = (() => {
  if (!values.tsconfig) return nodePath.join(repo, 'tsconfig.json')
  const candidates = [nodePath.resolve(values.tsconfig), nodePath.resolve(repo, values.tsconfig)]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) die(3, `--tsconfig "${values.tsconfig}" not found (looked in ${candidates.join(' and ')})`)
  return found
})()
if (!existsSync(tsConfigFilePath))
  die(3, `no tsconfig.json at ${repo} (groundcheck needs a resolvable TS project; pass --tsconfig <path> for a monorepo)`)

let project: Project
try {
  project = new Project({ tsConfigFilePath })
} catch (error) {
  die(3, `could not load ${tsConfigFilePath}: ${error instanceof Error ? error.message : String(error)}`)
}

const relative = (absolutePath: string) => nodePath.relative(repo, absolutePath).split(nodePath.sep).join('/')
const projectFiles = project
  .getSourceFiles()
  .filter((f) => !f.isDeclarationFile() && !f.getFilePath().includes('/node_modules/'))
  .filter((f) => !relative(f.getFilePath()).startsWith('..'))
if (projectFiles.length === 0) {
  const isSolutionStyle = (() => {
    try {
      const raw = readFileSync(tsConfigFilePath, 'utf8')
      return /"references"\s*:/.test(raw)
    } catch {
      return false
    }
  })()
  die(
    3,
    `${tsConfigFilePath} resolved zero source files` +
      (isSolutionStyle
        ? ' — it is solution-style (has "references"). Pass --tsconfig <path to one config whose include covers every changed package>; for a cross-package diff that is usually a synthetic config extending the repo base (see SKILL.md § Monorepos)'
        : '; pass --tsconfig <path to one config whose include covers every changed package>'),
  )
}

/**
 * Node ids drop the project source root (`src/`), matching every example in
 * SLICE_FORMAT; `file` keeps the repo-relative path. See reports/M0.md § 1.
 */
const sourceRoot = (() => {
  const configured = project.getCompilerOptions().rootDir
  if (configured) {
    const rel = relative(configured)
    return rel && !rel.startsWith('..') ? rel : ''
  }
  const dirs = projectFiles.map((f) => relative(f.getFilePath()).split('/').slice(0, -1))
  if (dirs.length === 0) return ''
  let commonPrefix = dirs[0]
  for (const dir of dirs.slice(1)) {
    let i = 0
    while (i < commonPrefix.length && i < dir.length && commonPrefix[i] === dir[i]) i++
    commonPrefix = commonPrefix.slice(0, i)
  }
  return commonPrefix.join('/')
})()

const stripSourceRoot = (relPath: string) =>
  sourceRoot && relPath.startsWith(`${sourceRoot}/`) ? relPath.slice(sourceRoot.length + 1) : relPath

const nodeId = (relPath: string, symbol?: string) => `${stripSourceRoot(relPath)}${symbol ? `#${symbol}` : ''}`

const fileByRelPath = new Map(projectFiles.map((f) => [relative(f.getFilePath()), f]))

// ── kind classification ───────────────────────────────────────────────────
const isPascalCase = (name: string) => /^[A-Z][A-Za-z0-9]*$/.test(name)
const isHookName = (name: string) => /^use[A-Z]/.test(name)

function containsJsx(declaration: Node): boolean {
  return (
    declaration.getFirstDescendantByKind(SyntaxKind.JsxElement) !== undefined ||
    declaration.getFirstDescendantByKind(SyntaxKind.JsxSelfClosingElement) !== undefined ||
    declaration.getFirstDescendantByKind(SyntaxKind.JsxFragment) !== undefined
  )
}

const isFunctionLike = (declaration: Node) =>
  Node.isFunctionDeclaration(declaration) ||
  Node.isArrowFunction(declaration) ||
  Node.isFunctionExpression(declaration) ||
  (Node.isVariableDeclaration(declaration) &&
    (Node.isArrowFunction(declaration.getInitializer() ?? declaration) ||
      Node.isFunctionExpression(declaration.getInitializer() ?? declaration)))

const isTypeDeclaration = (declaration: Node) =>
  Node.isInterfaceDeclaration(declaration) || Node.isTypeAliasDeclaration(declaration) || Node.isEnumDeclaration(declaration)

/** Exported declarations of a file, in source order, own-file only. */
function ownExports(file: SourceFile): { name: string; declaration: Node }[] {
  const found: { name: string; declaration: Node }[] = []
  for (const [name, declarations] of file.getExportedDeclarations()) {
    for (const declaration of declarations) {
      if (declaration.getSourceFile() === file) found.push({ name, declaration })
    }
  }
  return found.sort((a, b) => a.declaration.getStart() - b.declaration.getStart() || byString(a.name, b.name))
}

function classifyKind(relPath: string, exported?: { name: string; declaration: Node }): Kind {
  const declaration = exported?.declaration
  const name = exported?.name
  for (const kind of KIND_ORDER) {
    if (kind === 'component' && name && declaration && relPath.endsWith('.tsx') && isPascalCase(name) && isFunctionLike(declaration) && containsJsx(declaration)) return 'component'
    if (kind === 'hook' && name && declaration && isHookName(name) && isFunctionLike(declaration)) return 'hook'
    if (kind === 'type' && declaration && isTypeDeclaration(declaration)) return 'type'
    if (kind === 'token' && matchesAny(relPath, tokenGlobs)) return 'token'
    if (kind === 'route' && matchesAny(relPath, routeGlobs)) return 'route'
  }
  return 'module'
}

/** Kind of a whole file = kind of its first exported declaration. */
function fileKind(relPath: string): Kind {
  const file = fileByRelPath.get(relPath)
  if (!file) return matchesAny(relPath, tokenGlobs) ? 'token' : matchesAny(relPath, routeGlobs) ? 'route' : 'module'
  return classifyKind(relPath, ownExports(file)[0])
}

// ── changed nodes and changed exported symbols ────────────────────────────
const overlaps = (a: Span, b: Span) => a.start <= b.end && b.start <= a.end
const clip = (a: Span, b: Span): Span => ({ start: Math.max(a.start, b.start), end: Math.min(a.end, b.end) })

function mergeSpans(spans: Span[]): Span[] {
  const sorted = [...spans].sort((x, y) => x.start - y.start || x.end - y.end)
  const merged: Span[] = []
  for (const span of sorted) {
    const last = merged[merged.length - 1]
    if (last && span.start <= last.end + 1) last.end = Math.max(last.end, span.end)
    else merged.push({ ...span })
  }
  return merged
}

const nodes = new Map<string, SliceNode>()
/** symbol name -> declaration, for reference search; keyed by node id. */
const changedSymbolDeclarations: { nodeId: string; name: string; declaration: Node }[] = []
const TS_SOURCE_RE = /\.(m|c)?tsx?$/

for (const file of [...changedFiles.values()].sort((a, b) => byString(a.path, b.path))) {
  if (file.status === 'deleted' && TS_SOURCE_RE.test(file.path) && !file.path.endsWith('.d.ts')) {
    // The file is gone at head, so there is nothing to parse: base-revision
    // metadata only (see reports/M0.md § open questions — untested path).
    const id = nodeId(file.path)
    nodes.set(id, {
      id,
      file: file.path,
      kind: fileKind(file.path),
      status: 'deleted',
      spans: file.changedLines,
      stats: { added: file.added, removed: file.removed },
      exportedSymbolsChanged: [],
      excerpt: excerptFor(file, []),
    })
    continue
  }

  const sourceFile = fileByRelPath.get(file.path)
  if (!sourceFile) continue // retained below as an ungraphed changed file

  const changedExports = ownExports(sourceFile).filter((exported) => {
    const declarationSpan = { start: exported.declaration.getStartLineNumber(), end: exported.declaration.getEndLineNumber() }
    return file.changedLines.some((changed) => overlaps(changed, declarationSpan))
  })

  if (changedExports.length === 0) {
    const id = nodeId(file.path)
    nodes.set(id, {
      id,
      file: file.path,
      kind: fileKind(file.path),
      status: file.status,
      spans: mergeSpans(file.changedLines),
      stats: { added: file.added, removed: file.removed },
      exportedSymbolsChanged: [],
      excerpt: excerptFor(file, []),
    })
    continue
  }

  for (const exported of changedExports) {
    const declarationSpan = { start: exported.declaration.getStartLineNumber(), end: exported.declaration.getEndLineNumber() }
    const id = nodeId(file.path, exported.name)
    const spans = mergeSpans(file.changedLines.filter((changed) => overlaps(changed, declarationSpan)).map((changed) => clip(changed, declarationSpan)))
    nodes.set(id, {
      id,
      file: file.path,
      symbol: exported.name,
      kind: classifyKind(file.path, exported),
      status: file.status,
      spans,
      // stats are per-file (see reports/M0.md § 5)
      stats: { added: file.added, removed: file.removed },
      exportedSymbolsChanged: [exported.name],
      excerpt: excerptFor(file, spans),
    })
    changedSymbolDeclarations.push({ nodeId: id, name: exported.name, declaration: exported.declaration })
  }
}

/**
 * Changed TypeScript files the project does not cover produce no graph node.
 * With a hand-written or narrow --tsconfig that is the difference between a
 * partial slice and a wrong one, so it is recorded in the slice (and shown in
 * the honesty badge), not just warned about on a stream nobody keeps.
 */
const analysedFiles = new Set([...nodes.values()].map((node) => node.file))
const ungraphedFiles: UngraphedFile[] = [...changedFiles.values()]
  .filter((file) => !analysedFiles.has(file.path))
  .sort((a, b) => byString(a.path, b.path))
  .map((file) => {
    const excerpt = excerptFor(file, [])
    return {
      file: file.path,
      status: file.status,
      spans: mergeSpans(file.changedLines),
      stats: { added: file.added, removed: file.removed },
      ...(excerpt.length ? { excerpt } : {}),
    }
  })
const excludedFiles = [...changedFiles.values()]
  .filter((file) => TS_SOURCE_RE.test(file.path) && !file.path.endsWith('.d.ts') && !analysedFiles.has(file.path))
  .map((file) => file.path)
  .sort()
if (excludedFiles.length)
  console.error(
    `build-slice: ${excludedFiles.length} changed TypeScript file(s) are outside ${relative(tsConfigFilePath) || tsConfigFilePath} ` +
      `and are listed without graph analysis: ${excludedFiles.slice(0, 5).join(', ')}${excludedFiles.length > 5 ? ', …' : ''} — widen --tsconfig to include them`,
  )

// ── blast radius via reference search ─────────────────────────────────────
type RawEdge = { from: string; to: string; type: EdgeType; file: string; line: number; column: number; count: number }
const rawEdges = new Map<string, RawEdge>()

function classifyReference(reference: Node, targetIsToken: boolean): EdgeType {
  if (
    reference.getFirstAncestorByKind(SyntaxKind.ImportDeclaration) ||
    reference.getFirstAncestorByKind(SyntaxKind.ImportEqualsDeclaration) ||
    reference.getFirstAncestorByKind(SyntaxKind.ExportDeclaration)
  )
    return 'imports'

  const jsxParent =
    reference.getParentIfKind(SyntaxKind.JsxSelfClosingElement) ??
    reference.getParentIfKind(SyntaxKind.JsxOpeningElement) ??
    reference.getParentIfKind(SyntaxKind.JsxClosingElement)
  if (jsxParent && jsxParent.getTagNameNode() === reference) return 'renders'

  if (reference.getFirstAncestor((ancestor) => Node.isTypeNode(ancestor))) return 'consumes-type'

  if (targetIsToken && reference.getParentIfKind(SyntaxKind.PropertyAccessExpression)) return 'uses-token'

  const call = reference.getParentIfKind(SyntaxKind.CallExpression)
  if (call && call.getExpression() === reference) return 'calls'

  return 'imports'
}

/** The slice node that owns a reference site inside an already-drawn file. */
function ownerNodeId(relPath: string, line: number): string | undefined {
  const candidates = [...nodes.values()].filter((n) => n.file === relPath).sort((a, b) => byString(a.id, b.id))
  if (candidates.length === 0) return undefined
  const containing = candidates.find((n) => n.spans.some((span) => line >= span.start && line <= span.end))
  return (containing ?? candidates[0]).id
}

function recordEdge(from: string, to: string, type: EdgeType, file: string, line: number, column: number) {
  if (from === to) return
  const key = `${from} ${to} ${type}`
  const existing = rawEdges.get(key)
  if (!existing) {
    rawEdges.set(key, { from, to, type, file, line, column, count: 1 })
    return
  }
  existing.count += 1
  if (line < existing.line || (line === existing.line && column < existing.column)) {
    existing.file = file
    existing.line = line
    existing.column = column
  }
}

/** One depth level of reference search; returns ids of newly created blast nodes. */
function expandBlast(sources: { nodeId: string; name: string; declaration: Node }[], blastDepth: number): string[] {
  const created: string[] = []
  for (const source of [...sources].sort((a, b) => byString(a.nodeId, b.nodeId) || byString(a.name, b.name))) {
    const declaration = source.declaration
    if (!Node.isReferenceFindable(declaration)) continue
    const targetNode = nodes.get(source.nodeId)
    const targetIsToken = targetNode?.kind === 'token'
    let references: Node[]
    try {
      references = declaration.findReferencesAsNodes()
    } catch {
      continue // unresolvable symbol: skip rather than invent an edge
    }
    for (const reference of references) {
      const referenceFile = reference.getSourceFile()
      if (referenceFile.isDeclarationFile() || referenceFile.getFilePath().includes('/node_modules/')) continue
      const referenceRelPath = relative(referenceFile.getFilePath())
      if (referenceRelPath === targetNode?.file) continue // self-reference
      if (!fileByRelPath.has(referenceRelPath)) continue

      const line = reference.getStartLineNumber()
      const column = reference.getStart() - referenceFile.getLineAndColumnAtPos(reference.getStart()).column
      let fromId = ownerNodeId(referenceRelPath, line)
      if (!fromId) {
        fromId = nodeId(referenceRelPath)
        nodes.set(fromId, {
          id: fromId,
          file: referenceRelPath,
          kind: fileKind(referenceRelPath),
          status: 'blast',
          ...(blastDepth > 1 ? { blastDepth } : {}),
          spans: [],
          stats: { added: 0, removed: 0 },
          exportedSymbolsChanged: [],
        })
        created.push(fromId)
      }
      recordEdge(fromId, source.nodeId, classifyReference(reference, targetIsToken), referenceRelPath, line, reference.getStart())
    }
  }
  return created
}

expandBlast(changedSymbolDeclarations, 1)

for (let level = 2; level <= depth; level++) {
  const frontier = [...nodes.values()].filter((n) => n.status === 'blast' && (n.blastDepth ?? 1) === level - 1)
  const sources: { nodeId: string; name: string; declaration: Node }[] = []
  for (const blastNode of frontier) {
    const file = fileByRelPath.get(blastNode.file)
    if (!file) continue
    for (const exported of ownExports(file)) sources.push({ nodeId: blastNode.id, name: exported.name, declaration: exported.declaration })
  }
  if (sources.length === 0) break
  expandBlast(sources, level)
}

// `imports` is the fallback classification; drop it when the same pair also has
// a specific relationship, or every type-only import would double its edge.
const pairsWithSpecificEdge = new Set(
  [...rawEdges.values()].filter((e) => e.type !== 'imports').map((e) => `${e.from} ${e.to}`),
)
const edges: SliceEdge[] = [...rawEdges.values()]
  .filter((edge) => edge.type !== 'imports' || !pairsWithSpecificEdge.has(`${edge.from} ${edge.to}`))
  .sort((a, b) => byString(a.from, b.from) || byString(a.to, b.to) || byString(a.type, b.type))
  .map((edge) => ({ from: edge.from, to: edge.to, type: edge.type, evidence: { file: edge.file, line: edge.line } }))

// ── hidden: import-graph reachable, not drawn ─────────────────────────────
const drawnFiles = new Set([...nodes.values()].map((n) => n.file))
const reachable = new Set<string>()
const queue = [...drawnFiles]
while (queue.length) {
  const relPath = queue.shift()!
  const file = fileByRelPath.get(relPath)
  if (!file) continue
  for (const referenced of file.getReferencedSourceFiles()) {
    if (referenced.isDeclarationFile() || referenced.getFilePath().includes('/node_modules/')) continue
    const referencedRelPath = relative(referenced.getFilePath())
    if (!fileByRelPath.has(referencedRelPath) || reachable.has(referencedRelPath)) continue
    reachable.add(referencedRelPath)
    queue.push(referencedRelPath)
  }
}
const hiddenFiles = [...reachable].filter((relPath) => !drawnFiles.has(relPath)).sort()
const hiddenByKind: Partial<Record<Kind, number>> = {}
for (const relPath of hiddenFiles) {
  const kind = fileKind(relPath)
  hiddenByKind[kind] = (hiddenByKind[kind] ?? 0) + 1
}

// ── optional directory collapse ───────────────────────────────────────────
const STATUS_RANK: Status[] = ['modified', 'added', 'deleted', 'blast', 'context']
function collapseToDirectories(): { nodes: SliceNode[]; edges: SliceEdge[] } {
  const groups = new Map<string, SliceNode[]>()
  for (const node of nodes.values()) {
    const dir = node.id.includes('/') ? node.id.slice(0, node.id.lastIndexOf('/')) : '.'
    ;(groups.get(dir) ?? groups.set(dir, []).get(dir)!).push(node)
  }
  const collapsedNodes: SliceNode[] = [...groups.entries()]
    .map(([dir, members]) => {
      const status = STATUS_RANK.find((s) => members.some((m) => m.status === s))!
      const kinds = new Set(members.map((m) => m.kind))
      return {
        id: dir,
        file: sourceRoot ? `${sourceRoot}/${dir}` : dir,
        kind: (kinds.size === 1 ? [...kinds][0] : 'module') as Kind,
        status,
        spans: [],
        stats: {
          added: members.reduce((sum, m) => sum + m.stats.added, 0),
          removed: members.reduce((sum, m) => sum + m.stats.removed, 0),
        },
        exportedSymbolsChanged: [...new Set(members.flatMap((m) => m.exportedSymbolsChanged))].sort(),
        // Collapsing must not lose the symbol-level facts it groups: the panel
        // and the annotator address members by their uncollapsed id.
        members: [...members].sort((a, b) => byString(a.id, b.id)),
      }
    })
    .sort((a, b) => byString(a.id, b.id))
  const dirOf = (id: string) => (id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '.')
  const collapsedEdges = new Map<string, SliceEdge>()
  for (const edge of edges) {
    const from = dirOf(edge.from)
    const to = dirOf(edge.to)
    if (from === to) continue
    const key = `${from} ${to} ${edge.type}`
    if (!collapsedEdges.has(key)) collapsedEdges.set(key, { from, to, type: edge.type, evidence: edge.evidence })
  }
  return {
    nodes: collapsedNodes,
    edges: [...collapsedEdges.values()].sort((a, b) => byString(a.from, b.from) || byString(a.to, b.to) || byString(a.type, b.type)),
  }
}

const collapsed = values.collapse === 'dir' ? collapseToDirectories() : undefined
const finalNodes = (collapsed?.nodes ?? [...nodes.values()]).sort((a, b) => byString(a.id, b.id))
const finalEdges = collapsed?.edges ?? edges

// ── epicenters: changed nodes with the most incoming edges (>= 2) ─────────
const inDegree = new Map<string, number>()
for (const edge of finalEdges) inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1)
const changedStatuses: Status[] = ['added', 'modified', 'deleted']
const changedNodeIds = finalNodes.filter((n) => changedStatuses.includes(n.status)).map((n) => n.id)
const maxInDegree = Math.max(0, ...changedNodeIds.map((id) => inDegree.get(id) ?? 0))
const epicenters = maxInDegree >= 2 ? changedNodeIds.filter((id) => (inDegree.get(id) ?? 0) === maxInDegree).sort() : []

// ── emit ──────────────────────────────────────────────────────────────────
const require = createRequire(import.meta.url)
const tsMorphVersion = JSON.parse(readFileSync(require.resolve('ts-morph/package.json'), 'utf8')).version

const emitNode = (node: SliceNode): Record<string, unknown> => ({
  id: node.id,
  file: node.file,
  ...(node.symbol ? { symbol: node.symbol } : {}),
  kind: node.kind,
  status: node.status,
  ...(node.blastDepth ? { blastDepth: node.blastDepth } : {}),
  spans: node.spans,
  stats: node.stats,
  exportedSymbolsChanged: node.exportedSymbolsChanged,
  ...(node.excerpt?.length ? { excerpt: node.excerpt } : {}),
  ...(node.members ? { members: node.members.map(emitNode) } : {}),
})

const slice = {
  groundcheck: SLICE_VERSION,
  generated: {
    at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    repo: nodePath.basename(repo),
    range,
    headSha: recordedHeadSha,
    baseSha: baseSha.slice(0, 7),
    ...(pr ? { pr } : {}),
    // Which program produced these facts: in a monorepo the tsconfig decides the
    // graph's scope, so a slice is not reproducible without it.
    tsconfig: relative(tsConfigFilePath).startsWith('..') ? tsConfigFilePath : relative(tsConfigFilePath),
    toolVersions: { node: process.versions.node, 'ts-morph': tsMorphVersion },
  },
  epicenters,
  nodes: finalNodes.map(emitNode),
  ungraphed: ungraphedFiles,
  edges: finalEdges,
  hidden: {
    count: hiddenFiles.length,
    byKind: Object.fromEntries(KIND_ORDER.filter((kind) => hiddenByKind[kind]).map((kind) => [kind, hiddenByKind[kind]!])),
  },
  excluded: { count: excludedFiles.length, files: excludedFiles },
}

writeFileSync(nodePath.resolve(values.out!), `${JSON.stringify(slice, null, 2)}\n`)
console.error(
  `build-slice: ${slice.nodes.length} nodes, ${slice.ungraphed.length} ungraphed files, ${slice.edges.length} edges, ${slice.hidden.count} hidden${slice.excluded.count ? `, ${slice.excluded.count} changed files excluded` : ''} → ${values.out}` +
    (slice.nodes.length > MAX_DRAWN_NODES_HINT ? `\nbuild-slice: ${slice.nodes.length} nodes exceeds the ${MAX_DRAWN_NODES_HINT}-node render cap; re-run with --collapse dir` : ''),
)
