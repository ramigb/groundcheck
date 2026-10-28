import { createHash } from 'node:crypto'

export const VERSION = '1.0.0'
export const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
export const isCode = (path: string) => /\.[cm]?[jt]sx?$/.test(path)

export type Location = { file: string; start: number; end: number }
export type Step = { kind: string; text: string; source: Location; children?: Step[] }
export type Gap = { reason: string; source: Location; code: string }
export type Logic = {
  name: string; kind: string; source: Location; code: string
  steps: Step[]; gaps: Gap[]; coverage: 'translated' | 'partial' | 'source-only'
}
export type Change = {
  id: string; file: string; name: string; kind: string
  status: 'added' | 'modified' | 'deleted'
  before?: Logic; after?: Logic
  patterns: string[]
}
export type FileChange = {
  file: string; status: 'added' | 'modified' | 'deleted'; added: number; removed: number
  binary: boolean; beforeMode?: string; afterMode?: string
  diff: string; analysis: 'syntax' | 'source-only' | 'binary'; changeIds: string[]
}
export type Reference = {
  changeId: string; revision: 'before' | 'after'
  relationship: 'calls' | 'renders' | 'uses-type' | 'imports' | 'references'
  source: Location; code: string
}
export type Scope = {
  revision: 'before' | 'after'; mode: 'configured' | 'syntax-only'; config: string | null
  includedFiles: string[]; excludedFiles: string[]; limitations: string[]
  unresolvedImports: { file: string; line: number; specifier: string }[]
}
export type Slice = {
  groundcheck: string
  generated: { at: string; repo: string; range: string; baseSha: string; headSha: string; worktree: boolean; toolVersions: Record<string, string> }
  snapshotId: string; input: { kind: 'git-range' | 'worktree' | 'patch'; patch?: string }; trees: { before: string; after: string }; files: FileChange[]; changes: Change[]; references: Reference[]; scopes: Scope[]
}
export type Criteria = { criteria: { id: string; text: string; source: string }[] }
export type Annotations = {
  annotations: string; for: { snapshotId: string }
  notes?: { changeId: string; text: string }[]
  criteriaMatches?: { criterionId: string; changeIds: string[]; note: string }[]
}
export function snapshotId(slice: Pick<Slice, 'input' | 'trees' | 'files' | 'changes' | 'references' | 'scopes'>): string {
  return hash(JSON.stringify({ input: slice.input, trees: slice.trees, files: slice.files, changes: slice.changes, references: slice.references, scopes: slice.scopes }))
}
