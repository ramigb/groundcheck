// Structural self-check for slice.json against SLICE_FORMAT v0.6.0.
// Usage: node tests/check-slice-shape.ts <slice.json>
// Prints one JSON object per violation on stdout; exit 1 if any, 0 if clean.
import { readFileSync } from 'node:fs'

const KINDS = ['component', 'hook', 'type', 'token', 'route', 'module'] as const
const STATUSES = ['added', 'modified', 'deleted', 'blast', 'context'] as const
const EDGE_TYPES = ['renders', 'consumes-type', 'calls', 'imports', 'uses-token'] as const

const TOP_KEYS = ['groundcheck', 'generated', 'epicenters', 'nodes', 'ungraphed', 'edges', 'hidden', 'excluded']
const GENERATED_KEYS = ['at', 'repo', 'range', 'headSha', 'baseSha', 'tsconfig', 'toolVersions']
const NODE_KEYS = ['id', 'file', 'symbol', 'kind', 'status', 'blastDepth', 'spans', 'stats', 'exportedSymbolsChanged', 'excerpt', 'members']
const EXCERPT_OPS = ['add', 'del', 'ctx', 'gap'] as const
const MAX_EXCERPT_LINES = 8 // DESIGN_CONTRACT § Panel structure, + one gap marker
const EDGE_KEYS = ['from', 'to', 'type', 'evidence']
const UNGRAPHED_KEYS = ['file', 'status', 'spans', 'stats', 'excerpt']

const ID_RE = /^[A-Za-z0-9._\-/]+(#[A-Za-z_$][A-Za-z0-9_$]*)?$/

const violations: { check: string; where: string; detail: string }[] = []
const fail = (check: string, where: string, detail: string) => violations.push({ check, where, detail })

/** Keys must appear in schema order; `allowed` may include optional keys. */
function checkKeyOrder(obj: object, allowed: string[], where: string) {
  const keys = Object.keys(obj)
  const unknown = keys.filter((k) => !allowed.includes(k))
  if (unknown.length) fail('key-unknown', where, `unknown keys: ${unknown.join(', ')}`)
  const ranks = keys.filter((k) => allowed.includes(k)).map((k) => allowed.indexOf(k))
  for (let i = 1; i < ranks.length; i++) {
    if (ranks[i] < ranks[i - 1]) {
      fail('key-order', where, `keys not in schema order: ${keys.join(', ')}`)
      break
    }
  }
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)

function main(path: string) {
  const text = readFileSync(path, 'utf8')
  const slice = JSON.parse(text)

  // determinism-relevant formatting
  if (text !== JSON.stringify(slice, null, 2) + '\n')
    fail('formatting', path, 'not exactly 2-space JSON.stringify output with one trailing newline')
  if (text.includes('\r')) fail('formatting', path, 'contains CR')

  if (typeof slice.groundcheck !== 'string' || !slice.groundcheck.startsWith('0.'))
    fail('version', 'groundcheck', `unknown major version: ${slice.groundcheck}`)
  checkKeyOrder(slice, TOP_KEYS, '$')
  for (const k of TOP_KEYS) if (!(k in slice)) fail('missing', k, 'required top-level key absent')

  if (slice.generated) {
    checkKeyOrder(slice.generated, GENERATED_KEYS, 'generated')
    for (const k of GENERATED_KEYS)
      if (!(k in slice.generated)) fail('missing', `generated.${k}`, 'required key absent')
  }

  const ids = new Set<string>()
  const nodes: any[] = slice.nodes ?? []
  const checkNode = (n: any, where: string, isMember: boolean) => {
    checkKeyOrder(n, NODE_KEYS, where)
    if (typeof n.id !== 'string' || !ID_RE.test(n.id)) fail('id-format', where, `bad id: ${n.id}`)
    if (!isMember) {
      if (ids.has(n.id)) fail('id-duplicate', where, 'id appears twice')
      ids.add(n.id)
    }
    if (typeof n.file !== 'string' || !n.file) fail('field', where, 'file must be a non-empty string')
    const hashed = typeof n.id === 'string' && n.id.includes('#')
    if (hashed && n.id.split('#')[1] !== n.symbol)
      fail('symbol-mismatch', where, `symbol "${n.symbol}" does not match id suffix`)
    if (!hashed && 'symbol' in n) fail('symbol-mismatch', where, 'file-level node carries a symbol')
    if (!KINDS.includes(n.kind)) fail('enum', where, `kind: ${n.kind}`)
    if (!STATUSES.includes(n.status)) fail('enum', where, `status: ${n.status}`)
    if (!Array.isArray(n.spans)) fail('field', where, 'spans must be an array')
    else
      n.spans.forEach((s: any, j: number) => {
        checkKeyOrder(s, ['start', 'end'], `${where}.spans[${j}]`)
        if (!isInt(s.start) || !isInt(s.end) || s.start < 1 || s.end < s.start)
          fail('span', where, `bad span ${JSON.stringify(s)}`)
      })
    checkKeyOrder(n.stats ?? {}, ['added', 'removed'], `${where}.stats`)
    if (!isInt(n.stats?.added) || !isInt(n.stats?.removed) || n.stats.added < 0 || n.stats.removed < 0)
      fail('stats', where, `bad stats ${JSON.stringify(n.stats)}`)
    if (!Array.isArray(n.exportedSymbolsChanged) || n.exportedSymbolsChanged.some((s: any) => typeof s !== 'string'))
      fail('field', where, 'exportedSymbolsChanged must be string[]')
    const changed = ['added', 'modified', 'deleted'].includes(n.status)
    if (!changed && n.spans?.length) fail('span', where, `${n.status} node must have empty spans`)
    if (!changed && (n.stats?.added || n.stats?.removed)) fail('stats', where, `${n.status} node must have zero stats`)
    if (changed && !n.stats?.added && !n.stats?.removed) fail('stats', where, 'changed node has zero stats')
    if ('blastDepth' in n && (!isInt(n.blastDepth) || n.blastDepth < 2))
      fail('field', where, 'blastDepth must be an integer >= 2')
    if ('blastDepth' in n && n.status !== 'blast') fail('field', where, 'blastDepth on a non-blast node')
    if ('excerpt' in n) {
      if (!changed) fail('excerpt', where, `${n.status} node carries a diff excerpt`)
      if (!Array.isArray(n.excerpt) || n.excerpt.length === 0) fail('excerpt', where, 'excerpt must be a non-empty array')
      else {
        n.excerpt.forEach((line: any, k: number) => {
          checkKeyOrder(line, ['op', 'text'], `${where}.excerpt[${k}]`)
          if (!EXCERPT_OPS.includes(line.op)) fail('enum', `${where}.excerpt[${k}]`, `op: ${line.op}`)
          if (typeof line.text !== 'string') fail('excerpt', `${where}.excerpt[${k}]`, 'text must be a string')
        })
        const diffLines = n.excerpt.filter((line: any) => line.op !== 'gap').length
        if (diffLines > MAX_EXCERPT_LINES)
          fail('excerpt', where, `${diffLines} diff lines exceeds the ${MAX_EXCERPT_LINES}-line cap`)
        const gaps = n.excerpt.filter((line: any) => line.op === 'gap')
        if (gaps.length > 1) fail('excerpt', where, 'more than one gap marker')
        if (gaps.length === 1 && n.excerpt[n.excerpt.length - 1].op !== 'gap')
          fail('excerpt', where, 'gap marker must be last')
      }
    }
    if ('members' in n) {
      if (isMember) fail('members', where, 'members may not nest')
      else if (!Array.isArray(n.members) || n.members.length === 0) fail('members', where, 'members must be a non-empty array')
      else {
        n.members.forEach((m: any, k: number) => checkNode(m, `${where}.members[${k}] ${m?.id}`, true))
        const memberIds = n.members.map((m: any) => m.id)
        if (JSON.stringify(memberIds) !== JSON.stringify([...memberIds].sort())) fail('sort', `${where}.members`, 'members not sorted by id')
        const summed = n.members.reduce((sum: number, m: any) => sum + (m.stats?.added ?? 0), 0)
        if (isInt(n.stats?.added) && summed !== n.stats.added)
          fail('members', where, `members' added lines sum to ${summed}, node says ${n.stats.added}`)
      }
    }
  }
  nodes.forEach((n, i) => checkNode(n, `nodes[${i}] ${n.id}`, false))
  const sortedIds = [...nodes.map((n) => n.id)].sort()
  if (JSON.stringify(nodes.map((n) => n.id)) !== JSON.stringify(sortedIds))
    fail('sort', 'nodes', 'nodes not sorted by id')

  const drawnFiles = new Set(nodes.flatMap((node) => (node.members ?? [node]).map((item: any) => item.file)))
  const ungraphed: any[] = slice.ungraphed ?? []
  ungraphed.forEach((file, i) => {
    const where = `ungraphed[${i}] ${file.file}`
    checkKeyOrder(file, UNGRAPHED_KEYS, where)
    if (typeof file.file !== 'string' || !file.file) fail('field', where, 'file must be a non-empty string')
    if (!['added', 'modified', 'deleted'].includes(file.status)) fail('enum', where, `status: ${file.status}`)
    if (!Array.isArray(file.spans)) fail('field', where, 'spans must be an array')
    else
      file.spans.forEach((span: any, j: number) => {
        checkKeyOrder(span, ['start', 'end'], `${where}.spans[${j}]`)
        if (!isInt(span.start) || !isInt(span.end) || span.start < 1 || span.end < span.start)
          fail('span', where, `bad span ${JSON.stringify(span)}`)
      })
    checkKeyOrder(file.stats ?? {}, ['added', 'removed'], `${where}.stats`)
    if (!isInt(file.stats?.added) || !isInt(file.stats?.removed) || file.stats.added < 0 || file.stats.removed < 0)
      fail('stats', where, `bad stats ${JSON.stringify(file.stats)}`)
    if ('excerpt' in file) {
      if (!Array.isArray(file.excerpt) || file.excerpt.length === 0) fail('excerpt', where, 'excerpt must be a non-empty array')
      else {
        file.excerpt.forEach((line: any, j: number) => {
          checkKeyOrder(line, ['op', 'text'], `${where}.excerpt[${j}]`)
          if (!EXCERPT_OPS.includes(line.op)) fail('enum', `${where}.excerpt[${j}]`, `op: ${line.op}`)
          if (typeof line.text !== 'string') fail('excerpt', `${where}.excerpt[${j}]`, 'text must be a string')
        })
        const diffLines = file.excerpt.filter((line: any) => line.op !== 'gap').length
        if (diffLines > MAX_EXCERPT_LINES)
          fail('excerpt', where, `${diffLines} diff lines exceeds the ${MAX_EXCERPT_LINES}-line cap`)
        const gaps = file.excerpt.filter((line: any) => line.op === 'gap')
        if (gaps.length > 1) fail('excerpt', where, 'more than one gap marker')
        if (gaps.length === 1 && file.excerpt[file.excerpt.length - 1].op !== 'gap')
          fail('excerpt', where, 'gap marker must be last')
      }
    }
    if (drawnFiles.has(file.file)) fail('ungraphed', where, 'file also belongs to a graph node')
  })
  const ungraphedPaths = ungraphed.map((file) => file.file)
  if (new Set(ungraphedPaths).size !== ungraphedPaths.length) fail('ungraphed', 'ungraphed', 'file appears twice')
  if (JSON.stringify(ungraphedPaths) !== JSON.stringify([...ungraphedPaths].sort()))
    fail('sort', 'ungraphed', 'files not sorted by path')

  const edgeKey = (e: any) => [e.from, e.to, e.type].join(' ')
  const seen = new Set<string>()
  const edges: any[] = slice.edges ?? []
  edges.forEach((e, i) => {
    const where = `edges[${i}] ${e.from} -> ${e.to} (${e.type})`
    checkKeyOrder(e, EDGE_KEYS, where)
    if (!ids.has(e.from)) fail('dangling', where, `from not in nodes: ${e.from}`)
    if (!ids.has(e.to)) fail('dangling', where, `to not in nodes: ${e.to}`)
    if (e.from === e.to) fail('self-edge', where, 'edge points at its own node')
    if (!EDGE_TYPES.includes(e.type)) fail('enum', where, `type: ${e.type}`)
    if (seen.has(edgeKey(e))) fail('edge-duplicate', where, 'duplicate (from, to, type)')
    seen.add(edgeKey(e))
    checkKeyOrder(e.evidence ?? {}, ['file', 'line', 'n'], `${where}.evidence`)
    if (typeof e.evidence?.file !== 'string' || !isInt(e.evidence?.line) || e.evidence.line < 1)
      fail('evidence', where, `bad evidence ${JSON.stringify(e.evidence)}`)
  })
  const edgeOrder = edges.map(edgeKey)
  if (JSON.stringify(edgeOrder) !== JSON.stringify([...edgeOrder].sort()))
    fail('sort', 'edges', 'edges not sorted by (from, to, type)')

  const eps: string[] = slice.epicenters ?? []
  eps.forEach((id) => {
    if (!ids.has(id)) fail('dangling', `epicenters ${id}`, 'epicenter not in nodes')
  })
  if (JSON.stringify(eps) !== JSON.stringify([...eps].sort())) fail('sort', 'epicenters', 'not sorted')

  const hidden = slice.hidden ?? {}
  checkKeyOrder(hidden, ['count', 'byKind'], 'hidden')
  if (!isInt(hidden.count) || hidden.count < 0) fail('field', 'hidden.count', `bad count: ${hidden.count}`)
  const byKind: Record<string, number> = hidden.byKind ?? {}
  const kindRanks = Object.keys(byKind).map((k) => KINDS.indexOf(k as any))
  if (kindRanks.some((r) => r < 0)) fail('enum', 'hidden.byKind', `unknown kind key: ${Object.keys(byKind).join(', ')}`)
  if (JSON.stringify(kindRanks) !== JSON.stringify([...kindRanks].sort((a, b) => a - b)))
    fail('key-order', 'hidden.byKind', 'kinds not in enum order')
  const excluded = slice.excluded ?? {}
  checkKeyOrder(excluded, ['count', 'files'], 'excluded')
  if (!isInt(excluded.count) || excluded.count < 0) fail('field', 'excluded.count', `bad count: ${excluded.count}`)
  if (!Array.isArray(excluded.files) || excluded.files.some((f: any) => typeof f !== 'string'))
    fail('field', 'excluded.files', 'files must be string[]')
  else {
    if (excluded.files.length !== excluded.count)
      fail('excluded', 'excluded', `${excluded.files.length} files listed, count says ${excluded.count}`)
    if (JSON.stringify(excluded.files) !== JSON.stringify([...excluded.files].sort()))
      fail('sort', 'excluded.files', 'not sorted')
    const drawn = new Set(nodes.map((n) => n.file))
    for (const file of excluded.files)
      if (drawn.has(file)) fail('excluded', 'excluded.files', `"${file}" is excluded but also drawn`)
  }

  const sum = Object.values(byKind).reduce((a, b) => a + (b as number), 0)
  if (sum !== hidden.count) fail('hidden-sum', 'hidden', `byKind sums to ${sum}, count is ${hidden.count}`)
  if (Object.values(byKind).some((v) => !isInt(v) || (v as number) < 1))
    fail('field', 'hidden.byKind', 'counts must be integers >= 1')

  // no floats anywhere (determinism rule)
  const walk = (v: any, p: string) => {
    if (typeof v === 'number' && !Number.isInteger(v)) fail('float', p, `non-integer number: ${v}`)
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`))
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${p}.${k}`)
  }
  walk(slice, '$')

  for (const v of violations) console.log(JSON.stringify(v))
  if (violations.length) {
    console.error(`${path}: ${violations.length} structural violation(s)`)
    process.exit(1)
  }
  console.error(`${path}: ok (${nodes.length} nodes, ${edges.length} edges)`)
}

const path = process.argv[2]
if (!path) {
  console.error('usage: node tests/check-slice-shape.ts <slice.json>')
  process.exit(2)
}
main(path)
