import { snapshotId, VERSION } from './model.ts'
import type { Annotations, Criteria, Slice } from './model.ts'

const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
function assert(test: unknown, message: string): asserts test { if (!test) throw new Error(message) }
function keys(v: Record<string, any>, allowed: string[], where: string) {
  assert(Object.keys(v).every(k => allowed.includes(k)), `${where}: unexpected field`)
}
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0
function unique(values: string[], where: string) { assert(new Set(values).size === values.length, `${where}: duplicate id`) }

export function checkSlice(value: unknown): asserts value is Slice {
  assert(object(value) && value.groundcheck === VERSION, `Unsupported slice version; expected ${VERSION}`)
  assert(object(value.generated) && nonempty(value.generated.baseSha) && nonempty(value.generated.headSha), 'Missing Git provenance')
  assert(object(value.trees) && nonempty(value.trees.before) && nonempty(value.trees.after), 'Missing snapshot fingerprints')
  assert(object(value.input) && ['git-range', 'worktree', 'patch'].includes(value.input.kind) && (value.input.kind !== 'patch' || typeof value.input.patch === 'string'), 'Invalid input provenance')
  assert(Array.isArray(value.files) && Array.isArray(value.changes) && Array.isArray(value.references) && Array.isArray(value.scopes), 'Invalid slice collections')
  unique(value.files.map((f: any) => f.file), 'files')
  unique(value.changes.map((c: any) => c.id), 'changes')
  const files = new Map(value.files.map((f: any) => [f.file, f]))
  const changes = new Map(value.changes.map((c: any) => [c.id, c]))
  for (const f of value.files) {
    assert(nonempty(f.file) && ['added', 'modified', 'deleted'].includes(f.status) && typeof f.diff === 'string' && Array.isArray(f.changeIds), 'Invalid changed file')
    assert(['syntax', 'source-only', 'binary'].includes(f.analysis) && typeof f.binary === 'boolean', 'Invalid file analysis coverage')
    assert(Number.isSafeInteger(f.added) && f.added >= 0 && Number.isSafeInteger(f.removed) && f.removed >= 0, 'Invalid file statistics')
    unique(f.changeIds, 'file changes')
    for (const id of f.changeIds) assert(changes.get(id)?.file === f.file, 'Dangling file change')
  }
  for (const c of value.changes) {
    assert(nonempty(c.id) && nonempty(c.name) && files.get(c.file)?.changeIds.includes(c.id), 'Unaccounted logical change')
    assert(['added', 'modified', 'deleted'].includes(c.status), 'Invalid change status')
    assert(c.status === 'added' ? !c.before && c.after : c.status === 'deleted' ? c.before && !c.after : c.before && c.after, 'Change status does not match before/after')
    for (const side of ['before', 'after']) {
      const logic = c[side]
      if (!logic) continue
      assert(typeof logic.code === 'string' && Array.isArray(logic.steps) && Array.isArray(logic.gaps), 'Missing logic/source')
      assert(['translated', 'partial', 'source-only'].includes(logic.coverage), 'Invalid translation coverage')
      assert(logic.coverage !== 'translated' || logic.gaps.length === 0, 'Translated logic contains explanation gaps')
      const loc = (source: any) => assert(source && source.file === c.file && Number.isSafeInteger(source.start) && Number.isSafeInteger(source.end) && source.start >= logic.source.start && source.end <= logic.source.end && source.end >= source.start, 'Invalid source location')
      assert(logic.source && logic.source.start >= 1 && logic.source.end >= logic.source.start, 'Invalid logical unit location')
      loc(logic.source)
      const steps = (items: any[]) => { for (const s of items) { assert(typeof s.text === 'string' && typeof s.kind === 'string', 'Invalid pseudocode step'); loc(s.source); if (s.children) { assert(Array.isArray(s.children), 'Invalid nested steps'); steps(s.children) } } }
      steps(logic.steps)
      for (const g of logic.gaps) { assert(nonempty(g.reason) && typeof g.code === 'string', 'Invalid explanation gap'); loc(g.source) }
    }
  }
  for (const r of value.references) {
    assert(changes.has(r.changeId) && ['before', 'after'].includes(r.revision) && changes.get(r.changeId)[r.revision], 'Dangling reference')
    assert(['calls', 'renders', 'uses-type', 'imports', 'references'].includes(r.relationship) && nonempty(r.source?.file) && Number.isSafeInteger(r.source.start) && r.source.start >= 1 && typeof r.code === 'string', 'Invalid reference evidence')
  }
  assert(value.scopes.length === 2 && value.scopes[0].revision === 'before' && value.scopes[1].revision === 'after', 'Missing revision scopes')
  for (const scope of value.scopes) assert(['configured', 'syntax-only'].includes(scope.mode) && Array.isArray(scope.includedFiles) && Array.isArray(scope.excludedFiles) && Array.isArray(scope.limitations) && Array.isArray(scope.unresolvedImports), 'Invalid analysis scope')
  assert(value.snapshotId === snapshotId(value as Slice), 'Snapshot fingerprint does not match facts')
}
export function checkCriteria(value: unknown): asserts value is Criteria {
  assert(object(value) && Array.isArray(value.criteria), 'Expected { criteria: [...] }')
  keys(value, ['criteria'], 'criteria')
  unique(value.criteria.map((c: any) => c.id), 'criteria')
  for (const c of value.criteria) { assert(object(c), 'Invalid criterion'); keys(c, ['id', 'text', 'source'], 'criterion'); assert(nonempty(c.id) && nonempty(c.text) && nonempty(c.source), 'Criteria require id, text and an explicit source') }
}
export function checkAnnotations(value: unknown, slice: Slice, criteria: Criteria): asserts value is Annotations {
  assert(object(value) && value.annotations === VERSION, `Unsupported annotations version; expected ${VERSION}`)
  keys(value, ['annotations', 'for', 'notes', 'criteriaMatches'], 'annotations')
  assert(object(value.for) && value.for.snapshotId === slice.snapshotId, 'Annotations belong to another snapshot')
  keys(value.for, ['snapshotId'], 'annotations.for')
  const changes = new Set(slice.changes.map(c => c.id)), ids = new Set(criteria.criteria.map(c => c.id))
  assert(value.notes === undefined || Array.isArray(value.notes), 'notes must be an array')
  assert(value.criteriaMatches === undefined || Array.isArray(value.criteriaMatches), 'criteriaMatches must be an array')
  unique((value.notes ?? []).map((n: any) => n.changeId), 'notes')
  for (const n of value.notes ?? []) { assert(object(n), 'Invalid note'); keys(n, ['changeId', 'text'], 'note'); assert(changes.has(n.changeId) && nonempty(n.text), 'Dangling or empty note') }
  unique((value.criteriaMatches ?? []).map((m: any) => m.criterionId), 'criteriaMatches')
  for (const m of value.criteriaMatches ?? []) { assert(object(m), 'Invalid criteria match'); keys(m, ['criterionId', 'changeIds', 'note'], 'match'); assert(ids.has(m.criterionId) && Array.isArray(m.changeIds) && m.changeIds.length > 0 && m.changeIds.every((id: string) => changes.has(id)) && nonempty(m.note), 'Dangling or empty criteria match'); unique(m.changeIds, 'criteria match') }
}
