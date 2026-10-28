import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { analyze } from '../scripts/analyze.ts'
import { checkAnnotations, checkSlice } from '../scripts/check.ts'
import { renderHtml } from '../scripts/html.ts'
import type { Annotations, Criteria } from '../scripts/model.ts'
import { patchedSnapshot } from '../scripts/patch.ts'
import { contentAt, readSnapshot, readWorktree } from '../scripts/snapshot.ts'
import { createPatch } from 'diff'

const work = mkdtempSync(path.join(tmpdir(), 'groundcheck-test-'))
after(() => rmSync(work, { recursive: true, force: true }))
const repo = path.join(work, 'project'); mkdirSync(repo)
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
const put = (file: string, text: string | Buffer) => { mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); writeFileSync(path.join(repo, file), text) }
git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
git('config', 'core.autocrlf', 'false')
put('tsconfig.json', JSON.stringify({ compilerOptions: { allowJs: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', baseUrl: '.', paths: { '@src/*': ['src/*'] } }, include: ['src'] }))
put('src/default.ts', 'export function choose(input: number | null | undefined) { return input || 5000; }\n')
put('src/consumer.ts', 'import { choose } from "@src/default";\nexport const value = choose(0);\n')
put('src/local.ts', 'function helper() { return 1; }\nexport const value = helper();\n')
put('src/obsolete.ts', 'export function obsolete() { return 1; }\n')
put('src/old-consumer.ts', 'import { obsolete } from "./obsolete";\nexport const old = obsolete();\n')
put('src/flow.js', 'export function allowed(user) { if (!user.active) return false; return true; }\n')
put('src/view.tsx', 'export const View = () => <div>Before</div>;\n')
put('src/external.ts', 'import { unknown } from "not-installed";\nexport const x = unknown();\n')
put('outside.ts', 'export const outside = 1;\n')
put('style.css', '.button { color: red; }\n')
put('package.json', JSON.stringify({ scripts: { postinstall: 'touch SHOULD_NOT_EXIST' } }))
git('add', '-A'); git('commit', '-qm', 'base'); const base = git('rev-parse', 'HEAD')
put('src/default.ts', 'export function choose(input: number | null | undefined) { return input ?? 5000; }\n')
put('src/local.ts', 'function helper() { return 2; }\nexport const value = helper();\n')
rmSync(path.join(repo, 'src/obsolete.ts'))
rmSync(path.join(repo, 'src/old-consumer.ts'))
put('src/flow.js', 'export function allowed(user) { if (!user.active) return undefined; return true; }\n')
put('src/view.tsx', 'export const View = () => <div>After</div>;\n')
put('outside.ts', 'export const outside = 2;\n')
put('style.css', '.button { color: blue; }\n')
put('image.bin', Buffer.from([0, 1, 2]))
put('src/new.ts', 'export const added = true;\n')
put('src/long.ts', 'export function long() {\n' + Array.from({ length: 30 }, (_, i) => `  const v${i} = ${i};`).join('\n') + '\n  return 29;\n}\n')
git('add', '-A'); git('commit', '-qm', 'head'); const head = git('rev-parse', 'HEAD')
const range = `${base}..${head}`
const slice = analyze(repo, range)
const html = renderHtml(slice)
const root = path.resolve(import.meta.dirname, '..')
const change = slice.changes.find(c => c.name === 'choose')!

test('analysis is deterministic, uses both revisions, and does not mutate or execute target code', () => {
  checkSlice(slice)
  const again = analyze(repo, range)
  const { generated: _a, ...facts } = slice, { generated: _b, ...factsAgain } = again
  assert.deepEqual(factsAgain, facts)
  assert.equal(git('status', '--porcelain'), '')
  assert.throws(() => readFileSync(path.join(repo, 'SHOULD_NOT_EXIST')))
  assert.match(change.before!.code, /\|\|/); assert.match(change.after!.code, /\?\?/)
})
test('reference evidence resolves path aliases and includes deleted and local declarations', () => {
  assert.ok(slice.references.some(r => r.changeId === change.id && r.source.file === 'src/consumer.ts' && r.relationship === 'calls' && r.revision === 'after'))
  const deleted = slice.changes.find(c => c.name === 'obsolete')!
  assert.equal(deleted.status, 'deleted')
  assert.ok(slice.references.some(r => r.changeId === deleted.id && r.revision === 'before' && r.source.file === 'src/old-consumer.ts'))
  const local = slice.changes.find(c => c.name === 'helper')!
  assert.ok(slice.references.some(r => r.changeId === local.id && r.source.file === 'src/local.ts' && r.source.start === 2))
})
test('JS, excluded code, non-code, binary files and long changes remain accounted for', () => {
  assert.equal(slice.files.find(f => f.file === 'src/flow.js')!.analysis, 'syntax')
  assert.ok(slice.scopes.every(s => s.excludedFiles.includes('outside.ts')))
  assert.ok(slice.changes.some(c => c.file === 'outside.ts'))
  assert.equal(slice.files.find(f => f.file === 'style.css')!.analysis, 'source-only')
  assert.equal(slice.files.find(f => f.file === 'image.bin')!.binary, true)
  assert.match(slice.changes.find(c => c.name === 'long')!.after!.code, /const v29/)
  assert.match(slice.files.find(f => f.file === 'src/long.ts')!.diff, /const v29/)
  assert.ok(slice.scopes.every(s => s.unresolvedImports.some(i => i.specifier === 'not-installed')))
})
test('range analysis is independent of checkout and dirty worktree contents', () => {
  put('src/default.ts', 'THIS IS NOT THE ANALYZED COMMIT')
  const dirty = analyze(repo, range)
  assert.equal(dirty.snapshotId, slice.snapshotId)
  git('checkout', '--', 'src/default.ts')
  git('checkout', '--detach', base)
  try { assert.equal(analyze(repo, range).snapshotId, slice.snapshotId) } finally { git('checkout', 'main') }
})

test('Git ranges accept dotted ref names and reject three-dot or conflicting input modes', () => {
  git('tag', 'v1.0', base); git('tag', 'v1.1', head)
  assert.equal(analyze(repo, 'v1.0..v1.1').snapshotId, slice.snapshotId)
  assert.throws(() => analyze(repo, 'main...HEAD'), /range must/)
  assert.throws(() => analyze(repo, 'HEAD..', { worktree: true, patch: 'anything' }), /exactly one/)
})
test('worktree analysis captures staged, unstaged, untracked and deleted files', () => {
  put('src/default.ts', 'export function choose(input: number) { return input; }\n')
  git('add', 'src/default.ts')
  put('src/flow.js', 'export const changed = false;\n')
  put('untracked.js', 'export const untracked = true;\n')
  rmSync(path.join(repo, 'src/new.ts'))
  try {
    const wt = analyze(repo, `${head}..`, { worktree: true })
    assert.equal(wt.generated.worktree, true)
    assert.ok(wt.files.some(f => f.file === 'untracked.js' && f.status === 'added'))
    assert.ok(wt.files.some(f => f.file === 'src/new.ts' && f.status === 'deleted'))
    assert.ok(wt.files.some(f => f.file === 'src/default.ts'))
    assert.ok(wt.files.some(f => f.file === 'src/flow.js'))
    assert.notEqual(wt.snapshotId, slice.snapshotId)
    checkSlice(wt)
  } finally { git('reset', '--hard', head); rmSync(path.join(repo, 'untracked.js')) }
})
test('report requires neither an LLM nor annotations and contains no graph or remote resources', () => {
  assert.match(html, /No LLM required/)
  assert.doesNotMatch(html, /<svg|<canvas|data-view="graph"|<script[^>]+src=|<link[^>]+href=/)
  assert.match(html, /Potential exposure/)
  assert.match(html, /Intent coverage is unassessed/)
  assert.doesNotMatch(html, />Passed<|>Failed<|safe to merge/i)
  for (const f of slice.files) assert.ok(html.includes(`data-file="${f.file}"`))
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  assert.equal(scripts.length, 1); new Function(scripts[0][1])
})
test('optional interpretation cannot alter facts, scope, ordering or validation status', () => {
  const criteria: Criteria = { criteria: [{ id: 'AC1', text: 'Preserve zero timeout', source: 'user' }] }
  const notes: Annotations = { annotations: '1.0.0', for: { snapshotId: slice.snapshotId }, notes: [{ changeId: change.id, text: 'Verify the behavior at the caller.' }], criteriaMatches: [{ criterionId: 'AC1', changeIds: [change.id], note: 'This fallback is relevant; the criterion remains unverified.' }] }
  const annotated = renderHtml(slice, notes, criteria)
  assert.match(annotated, /Optional model\/reviewer interpretation — unverified/)
  assert.match(annotated, /Suggested evidence/)
  assert.match(annotated, />Unverified</)
  assert.throws(() => checkAnnotations({ ...notes, for: { snapshotId: 'old' } }, slice, criteria), /another snapshot/)
  assert.throws(() => checkAnnotations({ ...notes, layout: {} }, slice, criteria), /unexpected field/)
  assert.throws(() => checkAnnotations({ ...notes, notes: [{ changeId: 'invented', text: 'x' }] }, slice, criteria), /Dangling/)
  assert.throws(() => checkAnnotations({ ...notes, criteriaMatches: [{ criterionId: 'invented', changeIds: [change.id], note: 'x' }] }, slice, criteria), /Dangling/)
})
test('untrusted source, criteria and annotation text cannot terminate JSON scripts or inject markup', () => {
  const hostile = '</script><script>globalThis.PWNED=true</script><img src=x onerror=alert(1)>'
  const criteria: Criteria = { criteria: [{ id: 'attack', text: hostile, source: 'user' }] }
  const notes: Annotations = { annotations: '1.0.0', for: { snapshotId: slice.snapshotId }, notes: [{ changeId: change.id, text: hostile }] }
  const output = renderHtml(slice, notes, criteria)
  assert.doesNotMatch(output, /<script>globalThis|<img src=x/)
  assert.match(output, /\\u003c\/script>/)
  assert.match(output, /&lt;script&gt;globalThis/)
  const block = /id="gc-annotations">([\s\S]*?)<\/script>/.exec(output)![1]
  assert.equal(JSON.parse(block).notes[0].text, hostile)
})
test('validator rejects corrupted facts, rendered content, evidence, controls and interpretation', () => {
  const sliceFile = path.join(work, 'slice.json'), artifact = path.join(work, 'review.html')
  writeFileSync(sliceFile, JSON.stringify(slice))
  const run = () => spawnSync(process.execPath, [path.join(root, 'scripts/validate-slice.ts'), '--slice', sliceFile, '--artifact', artifact], { encoding: 'utf8' })
  writeFileSync(artifact, html); assert.equal(run().status, 0)
  const mutations = [
    html.replace(/<details class="change"[\s\S]*?<\/details>/, ''),
    html.replace('Potential exposure', 'Guaranteed safety'),
    html.replace('role="status"', 'role="none"'),
    html.replace('CALL', 'SKIP'),
    html.replace('data-reference=', 'data-fabricated='),
    html.replace('No LLM required', 'Verified safe'),
    html.replace('id="gc-slice"', 'id="missing-slice"'),
    html.replace('Intent coverage is unassessed', 'All criteria passed'),
  ]
  for (const mutant of mutations) { assert.notEqual(mutant, html); writeFileSync(artifact, mutant); const result = run(); assert.equal(result.status, 1, result.stdout + result.stderr) }
  const corrupt = structuredClone(slice); corrupt.changes[0].status = 'deleted'
  assert.throws(() => checkSlice(corrupt), /status/)
  const altered = structuredClone(slice); altered.changes[0].after!.steps[0].text = 'invented'
  assert.throws(() => checkSlice(altered), /fingerprint/)
})
test('single-command and staged CLI paths work with no annotations', () => {
  const out = path.join(work, 'cli.html'), facts = path.join(work, 'cli.json')
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/review.ts'), '--repo', repo, '--range', range, '--out', out, '--slice', facts], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const validate = spawnSync(process.execPath, [path.join(root, 'scripts/validate-slice.ts'), '--slice', facts, '--artifact', out], { encoding: 'utf8' })
  assert.equal(validate.status, 0, validate.stdout)
  const build = spawnSync(process.execPath, [path.join(root, 'scripts/build-slice.ts'), '--repo', repo, '--range', range, '--out', facts], { encoding: 'utf8' })
  assert.equal(build.status, 0, build.stderr)
  const render = spawnSync(process.execPath, [path.join(root, 'scripts/render-slice.ts'), '--slice', facts, '--out', out], { encoding: 'utf8' })
  assert.equal(render.status, 0, render.stderr)
  const staged = spawnSync(process.execPath, [path.join(root, 'scripts/validate-slice.ts'), '--slice', facts, '--artifact', out], { encoding: 'utf8' })
  assert.equal(staged.status, 0, staged.stdout)
  const invalid = spawnSync(process.execPath, [path.join(root, 'scripts/build-slice.ts'), '--repo', repo, '--range', 'HEAD', '--out', facts], { encoding: 'utf8' })
  assert.equal(invalid.status, 2)
})
test('syntax-only mode supports a JavaScript repository with no tsconfig', () => {
  const js = path.join(work, 'js'); mkdirSync(js)
  const run = (...args: string[]) => execFileSync('git', args, { cwd: js, encoding: 'utf8' })
  run('init', '-q', '-b', 'main'); run('config', 'core.autocrlf', 'false'); writeFileSync(path.join(js, 'index.js'), 'export const value = 1;\n'); run('add', '-A'); run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'one')
  writeFileSync(path.join(js, 'index.js'), 'export const value = 2;\n'); run('add', '-A'); run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'two')
  const result = analyze(js, 'HEAD~1..HEAD')
  assert.ok(result.scopes.every(s => s.mode === 'syntax-only'))
  assert.equal(result.changes.length, 1)
})

test('patch input reconstructs complete files from an immutable base and preserves the supplied patch', () => {
  const patch = git('diff', '--no-renames', base, head, '--', 'src/default.ts', 'src/local.ts', 'src/new.ts', 'src/obsolete.ts') + '\n'
  const file = path.join(work, 'changes.diff'); writeFileSync(file, patch)
  const result = analyze(repo, `${base}..`, { patch: file })
  assert.equal(result.input.kind, 'patch')
  assert.equal(result.input.patch, patch)
  const cli = spawnSync(process.execPath, [path.join(root, 'scripts/review.ts'), '--repo', repo, '--range', `${base}..`, '--patch', file, '--out', path.join(work, 'patch.html')], { encoding: 'utf8' })
  assert.equal(cli.status, 0, cli.stderr)
  assert.match(result.changes.find(c => c.name === 'choose')!.after!.code, /\?\? 5000/)
  assert.equal(result.changes.find(c => c.name === 'added')!.status, 'added')
  assert.equal(result.changes.find(c => c.name === 'obsolete')!.status, 'deleted')
  assert.ok(result.references.some(r => r.source.file === 'src/consumer.ts' && r.revision === 'after'))
  assert.equal(git('status', '--porcelain'), '')
  checkSlice(result)
  assert.throws(() => patchedSnapshot(repo, readSnapshot(repo, base), patch.replace('input || 5000', 'input || 42')), /context does not match/)
  assert.throws(() => patchedSnapshot(repo, readSnapshot(repo, base), patch.replaceAll('src/default.ts', '../escape.ts')), /Unsafe/)
})
test('patch input rejects incomplete, binary and ambiguous file operations', () => {
  const snapshot = readSnapshot(repo, base)
  assert.throws(() => patchedSnapshot(repo, snapshot, 'not a patch'), /no file changes/)
  const binary = 'diff --git a/image.bin b/image.bin\nnew file mode 100644\nBinary files /dev/null and b/image.bin differ\n'
  assert.throws(() => patchedSnapshot(repo, snapshot, binary), /Binary/)
  const rename = 'diff --git a/src/default.ts b/src/renamed.ts\nsimilarity index 100%\nrename from src/default.ts\nrename to src/renamed.ts\n'
  assert.throws(() => patchedSnapshot(repo, snapshot, rename), /Rename/)
})

test('patch input rejects shifted coordinates, truncated hunks, repeated files and unsafe paths', () => {
  const snapshot = readSnapshot(repo, base)
  const patch = git('diff', '--no-renames', base, head, '--', 'src/default.ts') + '\n'
  assert.throws(() => patchedSnapshot(repo, snapshot, patch.replace('@@ -1 +1 @@', '@@ -1 +2 @@')), /coordinates/)
  assert.throws(() => patchedSnapshot(repo, snapshot, patch.replace('@@ -1 +1 @@', '@@ -2 +2 @@')), /context|coordinates/)
  assert.throws(() => patchedSnapshot(repo, snapshot, patch.replace(/^\+export.*\n/m, '')), /line count|invalid line/)
  assert.throws(() => patchedSnapshot(repo, snapshot, patch + patch), /Repeated/)
  for (const name of ['../escape.ts', 'C:/escape.ts', '.GIT/config', 'src//file.ts']) {
    assert.throws(() => patchedSnapshot(repo, snapshot, patch.replaceAll('src/default.ts', name)), /Unsafe/)
  }
})

test('patch input preserves EOF changes, empty files and executable metadata', () => {
  const snapshot = readSnapshot(repo, base)
  const create = 'diff --git a/empty.ts b/empty.ts\nnew file mode 100644\nindex 0000000..e69de29\n'
  const empty = patchedSnapshot(repo, snapshot, create).snapshot
  assert.equal(contentAt(repo, empty, 'empty.ts')!.length, 0)
  const mode = 'diff --git a/src/default.ts b/src/default.ts\nold mode 100644\nnew mode 100755\n'
  assert.equal(patchedSnapshot(repo, snapshot, mode).snapshot.entries.get('src/default.ts')!.mode, '100755')
  assert.throws(() => patchedSnapshot(repo, snapshot, mode.replace('old mode 100644', 'old mode 100755')), /mode does not match/)
  const noNewline = 'diff --git a/no-newline.js b/no-newline.js\nnew file mode 100644\n--- /dev/null\n+++ b/no-newline.js\n@@ -0,0 +1 @@\n+export const x = 1;\n\\ No newline at end of file\n'
  assert.equal(contentAt(repo, patchedSnapshot(repo, snapshot, noNewline).snapshot, 'no-newline.js')!.toString(), 'export const x = 1;')
  const removed = '--- empty.ts\n+++ /dev/null\n'
  assert.equal(patchedSnapshot(repo, empty, removed).snapshot.entries.has('empty.ts'), false)
})

test('captured worktree content remains stable when a non-code file changes afterward', () => {
  const captured = readWorktree(repo, readSnapshot(repo, head))
  put('style.css', 'Changed after capture')
  try { assert.equal(contentAt(repo, captured, 'style.css')!.toString(), '.button { color: blue; }\n') }
  finally { git('checkout', '--', 'style.css') }
})

test('patch reconstruction preserves CRLF, blank lines and end-of-file newline changes', () => {
  for (const [before, after] of [['one\r\ntwo\r\n', 'one\r\nthree\r\n'], ['one\n\nthree\n', 'one\nnew\n\nthree\n'], ['one', 'one\n'], ['one\n', 'one']]) {
    const snapshot = { sha: base, entries: new Map([['text.js', { mode: '100644', oid: 'captured-content', content: Buffer.from(before) }]]) }
    const patch = createPatch('text.js', before, after)
    assert.equal(contentAt(repo, patchedSnapshot(repo, snapshot, patch).snapshot, 'text.js')!.toString(), after)
  }
})

test('Git paths containing pattern characters select only the named file diff', () => {
  put('file[1].js', 'export const literal = true;\n')
  put('file1.js', 'export const other = true;\n')
  git('add', 'file[1].js', 'file1.js')
  try {
    const result = analyze(repo, `${head}..`, { worktree: true })
    assert.doesNotMatch(result.files.find(f => f.file === 'file[1].js')!.diff, /export const other/)
    assert.match(result.files.find(f => f.file === 'file[1].js')!.diff, /export const literal/)
  } finally { git('reset', '--hard', head) }
})

test('Git-range metadata accounts for symlinks and gitlinks without following their contents', () => {
  const link = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: '../outside-secret.ts', encoding: 'utf8' }).trim()
  writeFileSync(path.join(work, 'outside-secret.ts'), 'SECRET_HOST_CONTENT')
  git('update-index', '--add', '--cacheinfo', `120000,${link},link.ts`)
  git('update-index', '--add', '--cacheinfo', `160000,${base},module.ts`)
  git('commit', '-qm', 'metadata')
  const metadata = git('rev-parse', 'HEAD')
  try {
    const snapshot = readSnapshot(repo, metadata)
    assert.equal(contentAt(repo, snapshot, 'link.ts'), undefined)
    assert.equal(contentAt(repo, snapshot, 'module.ts'), undefined)
    const result = analyze(repo, `${head}..${metadata}`)
    for (const name of ['link.ts', 'module.ts']) {
      assert.equal(result.files.find(f => f.file === name)!.analysis, 'source-only')
      assert.equal(result.files.find(f => f.file === name)!.changeIds.length, 0)
    }
    assert.doesNotMatch(JSON.stringify(result), /SECRET_HOST_CONTENT/)
    assert.throws(() => analyze(repo, `${metadata}..`, { worktree: true }), /submodule changes require a Git range/)
  } finally { git('reset', '--hard', head) }
})
