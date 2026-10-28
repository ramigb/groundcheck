import { applyPatch, parsePatch, formatPatch } from 'diff'
import { hash } from './model.ts'
import type { Snapshot } from './snapshot.ts'
import { contentAt } from './snapshot.ts'

export function patchedSnapshot(repo: string, base: Snapshot, text: string) {
  const patches = parsePatch(text)
  if (!patches.length || patches.every(p => !p.oldFileName && !p.newFileName)) throw new Error('Patch contains no file changes')
  const entries = new Map([...base.entries].map(([name, entry]) => [name, { ...entry }]))
  const diffs = new Map<string, { diff: string; added: number; removed: number; binary: boolean }>()
  const seen = new Set<string>()
  const safePath = (value: string | undefined, git: boolean) => {
    if (!value || value === '/dev/null') return undefined
    const name = git ? value.replace(/^[ab]\//, '') : value
    if (!name || name.startsWith('/') || name.includes('\\') || name.includes(':') || name.includes('\0') || name.split('/').some(p => !p || p === '..' || p === '.' || p.toLowerCase() === '.git')) throw new Error(`Unsafe or unsupported patch path: ${name}`)
    return name
  }
  // Each file is applied against the immutable base. No target-repository writes.
  for (const patch of patches) {
    if (patch.isBinary) throw new Error('Binary patches cannot be reconstructed; review a Git range instead')
    if (patch.isRename || patch.isCopy) throw new Error('Rename/copy patches are not supported; generate the patch with git diff --no-renames')
    const oldPath = patch.isCreate ? undefined : safePath(patch.oldFileName, !!patch.isGit)
    const newPath = patch.isDelete ? undefined : safePath(patch.newFileName, !!patch.isGit)
    const name = newPath ?? oldPath
    if (!name || (oldPath && newPath && oldPath !== newPath)) throw new Error('Patch must use the same repository-relative path on both sides; generate with --no-renames')
    if (seen.has(name)) throw new Error(`Repeated patch file: ${name}`)
    seen.add(name)
    if (oldPath && !base.entries.has(oldPath)) throw new Error(`Patch base does not contain ${oldPath}`)
    if (!oldPath && base.entries.has(name)) throw new Error(`Patch creates existing file ${name}`)
    const old = oldPath ? base.entries.get(oldPath) : undefined
    if (patch.oldMode && patch.oldMode !== old?.mode) throw new Error(`Patch mode does not match base: ${name}`)
    if (old?.mode === '120000' || old?.mode === '160000' || (patch.newMode && !['100644', '100755'].includes(patch.newMode))) throw new Error('Symlink/submodule or unsupported mode patches require a Git range')
    const original = oldPath ? contentAt(repo, base, oldPath) : undefined
    if (original?.includes(0)) throw new Error(`Binary base for patch: ${name}`)
    const before = original?.toString('utf8') ?? ''
    // Reject offset/fuzzy application: all hunk coordinates and context must match.
    let oldEnd = 0, delta = 0
    const lines = before.split('\n')
    for (const hunk of patch.hunks) {
      const start = hunk.oldStart - 1, newStart = hunk.newStart - 1
      const lineCount = before === '' ? 0 : lines.length - (before.endsWith('\n') ? 1 : 0)
      if (start < oldEnd || start < 0 || start > lineCount || newStart !== start + delta) throw new Error(`Invalid or overlapping patch coordinates: ${name}`)
      let cursor = start
      for (const line of hunk.lines) if (line === '' || line[0] === ' ' || line[0] === '-') {
        if (cursor >= lineCount || lines[cursor] !== line.slice(1)) throw new Error(`Patch context does not match base at ${name}:${cursor + 1}`)
        cursor++
      }
      oldEnd = cursor
      delta += hunk.newLines - hunk.oldLines
    }
    const after = applyPatch(before, patch, { fuzzFactor: 0, autoConvertLineEndings: false })
    if (after === false) throw new Error(`Patch does not apply exactly: ${name}`)
    if (oldPath && newPath && before === after && (!patch.newMode || patch.newMode === old?.mode)) throw new Error(`Patch contains no file changes for ${name}`)
    if (!newPath) {
      if (after !== '') throw new Error(`Deletion patch does not remove the complete file: ${name}`)
      entries.delete(name)
    } else entries.set(name, { mode: patch.newMode ?? old?.mode ?? '100644', oid: hash(after), content: Buffer.from(after) })
    diffs.set(name, { diff: formatPatch(patch), added: patch.hunks.flatMap(h => h.lines).filter(l => l.startsWith('+')).length, removed: patch.hunks.flatMap(h => h.lines).filter(l => l.startsWith('-')).length, binary: false })
  }
  return { snapshot: { sha: `${base.sha}+patch:${hash(text)}`, entries } satisfies Snapshot, diffs }
}
