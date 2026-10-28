import { Project, Node, SyntaxKind, ts } from 'ts-morph'
import { compare, hash, isCode, snapshotId, VERSION } from './model.ts'
import type { Change, Reference, Scope, Slice } from './model.ts'
import { compareLogic } from './logic.ts'
import { contentAt, git, readSnapshot, readWorktree } from './snapshot.ts'
import type { Snapshot } from './snapshot.ts'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { patchedSnapshot } from './patch.ts'

function projectFor(snapshot: Snapshot, revision: 'before' | 'after', config?: string) {
  let project = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true, noEmit: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.Preserve } })
  const fs = project.getFileSystem()
  for (const [name, entry] of snapshot.entries) if (entry.content) fs.writeFileSync(`/repo/${name}`, entry.content.toString('utf8'))
  const configPath = config ?? ['tsconfig.json', 'jsconfig.json'].find(name => snapshot.entries.has(name))
  const scope: Scope = { revision, mode: 'syntax-only', config: configPath ?? null, includedFiles: [], excludedFiles: [], limitations: [], unresolvedImports: [] }
  if (configPath) {
    try {
      // addSourceFilesFromTsConfig alone does not adopt compilerOptions/paths.
      // Reuse the populated virtual FS in a project constructed from the config.
      project = new Project({ fileSystem: fs, tsConfigFilePath: `/repo/${configPath}`, compilerOptions: { noEmit: true } })
      if (project.getSourceFiles().length) scope.mode = 'configured'
      else scope.limitations.push('The selected config includes no source files; project-reference traversal is not implemented.')
    } catch (error) { scope.limitations.push(`Cannot load config: ${String(error).replaceAll('/repo/', '')}`) }
  } else scope.limitations.push('No tsconfig.json or jsconfig.json: reference analysis uses default compiler options.')
  if (scope.mode === 'syntax-only') {
    // A config that includes no files still replaces the default options; without
    // allowJs the language service drops .js files and reference lookup throws.
    if (!project.getCompilerOptions().allowJs) project.compilerOptions.set({ allowJs: true })
    for (const [name, entry] of snapshot.entries) if (isCode(name) && entry.content) project.addSourceFileAtPath(`/repo/${name}`)
  }
  scope.includedFiles = project.getSourceFiles().map(f => f.getFilePath().slice(6)).sort(compare)
  const included = new Set(scope.includedFiles)
  scope.excludedFiles = [...snapshot.entries.keys()].filter(name => isCode(name) && !included.has(name)).sort(compare)
  scope.limitations.push('Static references are potential exposure, not proof of behavioral impact. Dynamic wiring and runtime dispatch are not resolved.')
  scope.limitations.push('Only repository snapshot files are loaded. Installed node_modules, package-manager installs and target-repository scripts are never used.')
  for (const sf of project.getSourceFiles()) {
    for (const imp of [...sf.getImportDeclarations(), ...sf.getExportDeclarations()]) {
      const specifier = imp.getModuleSpecifierValue()
      if (specifier && !imp.getModuleSpecifierSourceFile()) scope.unresolvedImports.push({ file: sf.getFilePath().slice(6), line: imp.getStartLineNumber(), specifier })
    }
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expression = call.getExpression().getText()
      if (expression === 'require' || expression === 'import') scope.limitations.push(`${sf.getFilePath().slice(6)}:${call.getStartLineNumber()}: ${expression}() reference resolution is not supported.`)
    }
    for (const diagnostic of sf.getPreEmitDiagnostics().filter(d => [2307, 2688].includes(d.getCode()))) {
      const message = ts.flattenDiagnosticMessageText(diagnostic.compilerObject.messageText, '\n')
      scope.limitations.push(`${sf.getFilePath().slice(6)}: ${message}`)
    }
  }
  scope.unresolvedImports.sort((a, b) => compare(a.file, b.file) || a.line - b.line || compare(a.specifier, b.specifier))
  scope.limitations = [...new Set(scope.limitations)].sort(compare)
  return { project, scope }
}

function collectReferences(project: Project, changes: Change[], revision: 'before' | 'after', scope: Scope): Reference[] {
  const references: Reference[] = []
  const seen = new Set<string>()
  for (const change of changes) {
    const logic = change[revision]
    if (!logic) continue
    const sf = project.getSourceFile(`/repo/${change.file}`)
    if (!sf) continue
    // Find declarations in the changed logical unit, including non-exported bindings.
    const declarations = sf.getDescendants().filter(n => {
      if (n.getStartLineNumber() < logic.source.start || n.getStartLineNumber() > logic.source.end) return false
      return (Node.isFunctionDeclaration(n) || Node.isVariableDeclaration(n) || Node.isClassDeclaration(n) || Node.isInterfaceDeclaration(n) || Node.isTypeAliasDeclaration(n) || Node.isEnumDeclaration(n)) && Node.isReferenceFindable(n)
    })
    for (const declaration of declarations) {
      if (!Node.isReferenceFindable(declaration)) continue
      // One failed lookup must not abort the review; disclose it as a scope limitation.
      let found: Node[]
      try { found = declaration.findReferencesAsNodes() } catch (error) {
        scope.limitations.push(`${change.file}:${declaration.getStartLineNumber()}: reference lookup failed: ${String(error).replaceAll('/repo/', '')}`)
        continue
      }
      for (const ref of found) {
        const refFile = ref.getSourceFile().getFilePath().slice(6)
        const line = ref.getStartLineNumber()
        if (refFile === change.file && line >= logic.source.start && line <= logic.source.end) continue
        const parent = ref.getParent()
        let relationship: Reference['relationship'] = 'references'
        if (ref.getFirstAncestorByKind(SyntaxKind.ImportDeclaration) || ref.getFirstAncestorByKind(SyntaxKind.ExportDeclaration)) relationship = 'imports'
        else if (ref.getFirstAncestor(n => Node.isTypeNode(n))) relationship = 'uses-type'
        else if (parent && (Node.isJsxOpeningElement(parent) || Node.isJsxSelfClosingElement(parent) || Node.isJsxClosingElement(parent))) relationship = 'renders'
        else if (parent && Node.isCallExpression(parent) && parent.getExpression() === ref) relationship = 'calls'
        const code = ref.getSourceFile().getFullText().split(/\r?\n/)[line - 1] ?? ''
        const item: Reference = { changeId: change.id, revision, relationship, source: { file: refFile, start: line, end: line }, code }
        const key = JSON.stringify(item)
        if (!seen.has(key)) { seen.add(key); references.push(item) }
      }
    }
  }
  scope.limitations = [...new Set(scope.limitations)].sort(compare)
  return references.sort((a, b) => compare(a.changeId, b.changeId) || compare(a.revision, b.revision) || compare(a.source.file, b.source.file) || a.source.start - b.source.start || compare(a.relationship, b.relationship))
}

export function analyze(repo: string, range: string, options: { worktree?: boolean; tsconfig?: string; patch?: string } = {}): Slice {
  const [baseRef, headRef, ...extra] = range.split('..')
  if (!baseRef || headRef === undefined || extra.length || baseRef.endsWith('.') || headRef.startsWith('.')) throw new Error('range must be <base>..<head>; use --worktree with <base>.. for uncommitted changes')
  if ((options.patch && options.worktree) || (!(options.worktree || options.patch) && !headRef) || ((options.worktree || options.patch) && headRef)) throw new Error('Use <base>..<head>, or <base>.. with exactly one of --worktree / --patch')
  if (options.tsconfig && (path.isAbsolute(options.tsconfig) || options.tsconfig.split(/[\\/]/).includes('..'))) throw new Error('--tsconfig must be a repository-relative snapshot path')
  const before = readSnapshot(repo, baseRef)
  const patchText = options.patch ? readFileSync(options.patch, 'utf8') : undefined
  const patched = patchText === undefined ? undefined : patchedSnapshot(repo, before, patchText)
  const after = patched ? patched.snapshot : options.worktree ? readWorktree(repo, readSnapshot(repo, 'HEAD')) : readSnapshot(repo, headRef)
  const args = options.worktree ? [before.sha] : [before.sha, after.sha]
  const files: Slice['files'] = []
  const changes: Change[] = []
  const paths = new Set<string>()
  const stats = new Map<string, { added: number; removed: number; binary: boolean }>(patched?.diffs)
  for (const record of (patched ? [] : git(repo, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--numstat', '-z', ...args]).toString().split('\0').filter(Boolean))) {
    const first = record.indexOf('\t'), second = record.indexOf('\t', first + 1)
    const added = record.slice(0, first), removed = record.slice(first + 1, second)
    stats.set(record.slice(second + 1), { added: added === '-' ? 0 : Number(added), removed: removed === '-' ? 0 : Number(removed), binary: added === '-' || removed === '-' })
  }
  const statuses = patched ? [] : git(repo, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z', ...args]).toString().split('\0')
  if (patched) for (const name of patched.diffs.keys()) paths.add(name)
  for (let i = 0; i + 1 < statuses.length; i += 2) if (statuses[i]) paths.add(statuses[i + 1])
  if (options.worktree) for (const name of git(repo, ['ls-files', '--others', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean)) paths.add(name)
  if (!paths.size) throw new Error('range contains no file changes')
  for (const file of [...paths].sort(compare)) {
    const b = before.entries.get(file), a = after.entries.get(file)
    if (options.worktree && (b?.mode === '160000' || a?.mode === '160000')) throw new Error('Worktree submodule changes require a Git range; submodule contents are not traversed')
    const oldContent = contentAt(repo, before, file), newContent = contentAt(repo, after, file)
    const binary = stats.get(file)?.binary || !!(oldContent?.includes(0) || newContent?.includes(0))
    const oldText = oldContent?.toString('utf8'), newText = newContent?.toString('utf8')
    const status = !b ? 'added' : !a ? 'deleted' : 'modified'
    const untracked = options.worktree && !before.entries.has(file) && !readSnapshotEntryTracked(repo, file)
    const diff = patched?.diffs.get(file)?.diff ?? (untracked ? `New untracked file: ${file}\n${newText ?? '[no text]'}` : git(repo, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--unified=3', ...args, '--', file]).toString())
    const added = untracked ? newText?.split('\n').filter((line, i, all) => i < all.length - 1 || line !== '').length ?? 0 : stats.get(file)?.added ?? 0
    const removed = stats.get(file)?.removed ?? 0
    const syntax = isCode(file) && !binary && ![b?.mode, a?.mode].some(mode => mode === '120000' || mode === '160000')
    const fileChanges = syntax ? compareLogic(file, oldText, newText) : []
    changes.push(...fileChanges)
    files.push({ file, status, added, removed, binary, ...(b ? { beforeMode: b.mode } : {}), ...(a ? { afterMode: a.mode } : {}), diff, analysis: binary ? 'binary' : syntax ? 'syntax' : 'source-only', changeIds: fileChanges.map(c => c.id) })
  }
  const baseProject = projectFor(before, 'before', options.tsconfig)
  const headProject = projectFor(after, 'after', options.tsconfig)
  const scopes = [baseProject.scope, headProject.scope]
  const references = [...collectReferences(baseProject.project, changes, 'before', baseProject.scope), ...collectReferences(headProject.project, changes, 'after', headProject.scope)]
  const treeHash = (snapshot: Snapshot) => hash(JSON.stringify([...snapshot.entries].sort(([a], [b]) => compare(a, b)).map(([name, entry]) => [name, entry.mode, entry.oid])))
  const input: Slice['input'] = patched ? { kind: 'patch', patch: patchText } : { kind: options.worktree ? 'worktree' : 'git-range' }
  const data = { input, trees: { before: treeHash(before), after: treeHash(after) }, files, changes, references, scopes }
  return { groundcheck: VERSION, generated: { at: new Date().toISOString(), repo: path.basename(path.resolve(repo)), range, baseSha: before.sha, headSha: after.sha, worktree: !!options.worktree, toolVersions: { node: process.versions.node, typescript: ts.version } }, snapshotId: snapshotId(data), ...data }
}
function readSnapshotEntryTracked(repo: string, file: string): boolean {
  return git(repo, ['ls-files', '-z', '--', file]).length > 0
}
