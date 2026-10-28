import { execFileSync } from 'node:child_process'
import { readFileSync, lstatSync, readlinkSync } from 'node:fs'
import path from 'node:path'
import { hash, isCode } from './model.ts'

export type Entry = { mode: string; oid: string; content?: Buffer }
export type Snapshot = { sha: string; entries: Map<string, Entry> }
export function git(repo: string, args: string[], input?: Buffer | string): Buffer {
  return execFileSync('git', ['--literal-pathspecs', ...args], { cwd: repo, input, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } })
}
const needsContent = (name: string) => isCode(name) || name.endsWith('.json')
export function readSnapshot(repo: string, ref: string): Snapshot {
  const sha = git(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).toString().trim()
  const entries = new Map<string, Entry>()
  for (const row of git(repo, ['ls-tree', '-rz', sha]).toString().split('\0').filter(Boolean)) {
    const split = row.indexOf('\t'), [mode, type, oid] = row.slice(0, split).split(' '), name = row.slice(split + 1)
    if (type === 'blob' || type === 'commit') entries.set(name, { mode, oid })
  }
  // Batch by object id rather than path: quoted paths and embedded newlines remain safe.
  const wanted = [...entries].filter(([name, e]) => needsContent(name) && e.mode.startsWith('100'))
  if (wanted.length) {
    const output = git(repo, ['cat-file', '--batch'], wanted.map(([, e]) => e.oid).join('\n') + '\n')
    let cursor = 0
    for (const [, entry] of wanted) {
      const end = output.indexOf(10, cursor), header = output.subarray(cursor, end).toString().split(' '), size = Number(header[2])
      if (!Number.isSafeInteger(size) || size < 0 || header[1] !== 'blob') throw new Error('Cannot read snapshot blob')
      entry.content = output.subarray(end + 1, end + 1 + size)
      cursor = end + 1 + size + 1
    }
  }
  return { sha, entries }
}
export function readWorktree(repo: string, head: Snapshot): Snapshot {
  const entries = new Map<string, Entry>()
  const paths = git(repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).toString().split('\0').filter(Boolean)
  for (const name of [...new Set(paths)].sort()) {
    let stat
    try { stat = lstatSync(path.join(repo, name)) } catch { continue }
    if (stat.isSymbolicLink()) {
      // Never follow a repository symlink into the host filesystem.
      entries.set(name, { mode: '120000', oid: hash(readlinkSync(path.join(repo, name))) }); continue
    }
    if (!stat.isFile()) continue
    const content = readFileSync(path.join(repo, name))
    entries.set(name, { mode: process.platform === 'win32' ? head.entries.get(name)?.mode ?? '100644' : stat.mode & 0o111 ? '100755' : '100644', oid: hash(content), content })
  }
  return { sha: `${head.sha}+worktree`, entries }
}
export function contentAt(repo: string, snapshot: Snapshot, name: string): Buffer | undefined {
  const entry = snapshot.entries.get(name)
  if (!entry || entry.mode === '120000' || entry.mode === '160000') return undefined
  if (entry.content) return entry.content
  return snapshot.sha.endsWith('+worktree') ? readFileSync(path.join(repo, name)) : git(repo, ['cat-file', 'blob', entry.oid])
}
