// render-slice.ts — the only writer of the review artifact.
// Consumes slice.json (facts) + annotations.json (judgment), emits one
// self-contained HTML file per references/DESIGN_CONTRACT.md v0.4.0.
//
// Usage:
//   node scripts/render-slice.ts --slice slice.json --annotations annotations.json --out review.html
//
// Exit codes: 0 success · 2 unusable inputs (bad JSON or invalid small-slice layout).
import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import {
  LARGE_FILE_WARNING_THRESHOLD,
  MANUAL_LAYOUT_THRESHOLD,
  NODE_BOX,
  resolveGraphLayout,
} from './layout-slice.ts'

const NODE = NODE_BOX
const RING_RADII = [78, 122, 168]
const CHANGED_STATUSES = ['added', 'modified', 'deleted']

type Span = { start: number; end: number }
type ExcerptLine = { op: 'add' | 'del' | 'ctx' | 'gap'; text: string }
type SliceNode = {
  id: string
  file: string
  symbol?: string
  kind: string
  status: string
  blastDepth?: number
  spans: Span[]
  stats: { added: number; removed: number }
  exportedSymbolsChanged: string[]
  excerpt?: ExcerptLine[]
  members?: SliceNode[]
}
type UngraphedFile = {
  file: string
  status: 'added' | 'modified' | 'deleted'
  spans: Span[]
  stats: { added: number; removed: number }
  excerpt?: ExcerptLine[]
}
type SliceEdge = { from: string; to: string; type: string; evidence: { file: string; line: number } }

/** Sign badge glyph. Status, not kind: the contract's node anatomy table. */
const SIGN: Record<string, string> = {
  added: '+',
  modified: '+',
  deleted: '-',
  blast: '+',
  context: '=',
}
/** Byte-identical to the sidebar filter labels and the legend. */
const STATUS_LABEL: Record<string, string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  blast: 'Consumed (low risk)',
  context: 'Context',
}
const EDGE_CLASS: Record<string, string> = {
  'consumes-type': 'type',
  renders: 'renders',
  calls: 'calls',
  'uses-token': 'token',
  imports: 'imports',
}
/** Change-type filter groups, per the contract's sidebar table. */
const EDGE_GROUPS: { key: string; label: string; types: string[]; sample: string }[] = [
  { key: 'flow', label: 'Renders / Calls', types: ['renders', 'calls'], sample: 'solid' },
  { key: 'type', label: 'Consumes type', types: ['consumes-type'], sample: 'dash' },
  { key: 'token', label: 'Uses token', types: ['uses-token'], sample: 'dots' },
  { key: 'imports', label: 'Imports', types: ['imports'], sample: 'thin' },
]

function die(code: number, message: string): never {
  console.error(`render-slice: ${message}`)
  process.exit(code)
}

const { values } = parseArgs({
  options: { slice: { type: 'string' }, annotations: { type: 'string' }, out: { type: 'string' } },
  allowPositionals: false,
})
if (!values.slice) die(2, 'missing --slice slice.json')
if (!values.annotations) die(2, 'missing --annotations annotations.json')
if (!values.out) die(2, 'missing --out review.html')

// Read as text: the embedded blocks must be byte-identical to the inputs, so the
// text is what gets written and the parse is only used for rendering decisions.
const sliceText = readFileSync(values.slice, 'utf8')
const annotationsText = readFileSync(values.annotations, 'utf8')
for (const [label, text] of [
  ['slice', sliceText],
  ['annotations', annotationsText],
] as const) {
  if (/<\/script/i.test(text)) die(2, `${label} JSON contains "</script"; it cannot be embedded verbatim`)
}

let slice: {
  groundcheck: string
  generated: any
  epicenters: string[]
  nodes: SliceNode[]
  ungraphed?: UngraphedFile[]
  edges: SliceEdge[]
  hidden: { count: number; byKind: Record<string, number> }
  excluded?: { count: number; files: string[] }
}
let annotations: any
try {
  slice = JSON.parse(sliceText)
} catch (error) {
  die(2, `--slice is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
}
try {
  annotations = JSON.parse(annotationsText)
} catch (error) {
  die(2, `--annotations is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
}

if (!slice.groundcheck?.startsWith('0.')) die(2, `unknown slice major version "${slice.groundcheck}"`)
const annotatedLayout: Record<string, { x: number; y: number }> = annotations.layout ?? {}
const graphLayout = resolveGraphLayout(slice.nodes, slice.edges ?? [], slice.epicenters ?? [], annotatedLayout)
const layout = graphLayout.positions
const CANVAS = graphLayout.canvas
if (graphLayout.mode === 'manual') {
  const missingLayout = slice.nodes.filter((node) => !layout[node.id]).map((node) => node.id)
  if (missingLayout.length) die(2, `annotations.layout is missing ${missingLayout.length} node(s): ${missingLayout.join(', ')}`)
}

const escapeHtml = (value: unknown) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const basename = (path: string) => path.split('/').pop() ?? path
const round = (value: number) => Math.round(value * 100) / 100

const orphans: string[] = annotations.orphans ?? []
const risk: Record<string, string> = annotations.risk ?? {}
const notes: Record<string, string> = annotations.notes ?? {}
const criteria: any[] = annotations.criteria ?? []
const flags: any[] = annotations.flags ?? []
const hasCriteria = criteria.length > 0

const spanText = (node: SliceNode) =>
  node.spans.length ? node.spans.map((s) => (s.start === s.end ? `L${s.start}` : `L${s.start}–L${s.end}`)).join(', ') : ''

// ── inline icons (no image requests, no icon dependency) ───────────────────
const ICON: Record<string, string> = {
  overview: '<circle cx="8" cy="8" r="6.2"/><circle cx="8" cy="8" r="2"/>',
  files: '<path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3"/>',
  graph: '<circle cx="4" cy="4" r="1.8"/><circle cx="12" cy="8" r="1.8"/><circle cx="4" cy="12" r="1.8"/><path d="M5.6 4.8 10.4 7.2M5.6 11.2 10.4 8.8"/>',
  criteria: '<circle cx="8" cy="8" r="6.2"/><path d="M5.2 8.2 7.2 10.2 11 6"/>',
  flags: '<path d="M8 2.6 14.2 13H1.8z"/><path d="M8 6.4v3.2M8 11.2v.6"/>',
  search: '<circle cx="7" cy="7" r="4.4"/><path d="M10.4 10.4 14 14"/>',
  zoomin: '<circle cx="7" cy="7" r="4.4"/><path d="M10.4 10.4 14 14M5 7h4M7 5v4"/>',
  zoomout: '<circle cx="7" cy="7" r="4.4"/><path d="M10.4 10.4 14 14M5 7h4"/>',
  save: '<path d="M4 2.6h8v11l-4-3-4 3z"/>',
  chevron: '<path d="M4 6.5 8 10.5 12 6.5"/>',
}
const icon = (name: string) =>
  `<svg class="ic" viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`

// ── canvas: rings, edges, nodes, canvas labels ─────────────────────────────
const ringsSvg = slice.epicenters
  .filter((id) => layout[id])
  .flatMap((id) =>
    RING_RADII.map(
      (radius, index) =>
        `<circle class="ring r${index + 1}" cx="${layout[id].x}" cy="${layout[id].y}" r="${radius}" stroke-width="1.4"></circle>`,
    ),
  )
  .join('\n        ')

/** Trim an edge to the node borders, same geometry as the v0.1.0 mock. */
function edgeGeometry(from: { x: number; y: number }, to: { x: number; y: number }) {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy) || 1
  const border = 0.5 * Math.min(NODE.width / Math.abs(dx / length || 1e-9), NODE.height / Math.abs(dy / length || 1e-9))
  const endPad = Math.min(border, length / 2) + 6
  const startPad = Math.min(border, length / 2)
  return {
    x1: round(from.x + (dx / length) * startPad),
    y1: round(from.y + (dy / length) * startPad),
    x2: round(to.x - (dx / length) * endPad),
    y2: round(to.y - (dy / length) * endPad),
  }
}

const edgeGroupOf = (type: string) => EDGE_GROUPS.find((group) => group.types.includes(type))?.key ?? 'imports'

const edgesSvg = slice.edges
  .map((edge, index) => {
    const { x1, y1, x2, y2 } = edgeGeometry(layout[edge.from], layout[edge.to])
    return (
      `<line class="edge ${EDGE_CLASS[edge.type] ?? 'imports'}" data-index="${index}" ` +
      `data-from="${escapeHtml(edge.from)}" data-to="${escapeHtml(edge.to)}" data-type="${escapeHtml(edge.type)}" ` +
      `data-group="${escapeHtml(edgeGroupOf(edge.type))}" ` +
      `x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-end="url(#m-dim)"></line>`
    )
  })
  .join('\n        ')

function subLabel(node: SliceNode): string {
  const parts = [node.kind]
  if (node.members?.length) parts.push(`${node.members.length} symbols`)
  if (node.status === 'added') parts.push('new')
  if (node.status === 'deleted') parts.push('deleted')
  return parts.join(' · ')
}

const nodesSvg = slice.nodes
  .map((node) => {
    const { x, y } = layout[node.id]
    const isOrphan = orphans.includes(node.id) || !!node.members?.some((member) => orphans.includes(member.id))
    const ariaExtra = isOrphan ? ', orphan change' : ''
    return `<g class="node ${escapeHtml(node.status)}${isOrphan ? ' orphan' : ''}" data-id="${escapeHtml(node.id)}" data-status="${escapeHtml(node.status)}" data-kind="${escapeHtml(node.kind)}" data-file="${escapeHtml(node.file)}" data-symbol="${escapeHtml(node.symbol ?? '')}" data-orphan="${isOrphan ? '1' : '0'}" data-x="${x}" data-y="${y}" transform="translate(${x - NODE.width / 2},${y - NODE.height / 2})" tabindex="0" role="button" aria-label="${escapeHtml(`${basename(node.file)}, ${STATUS_LABEL[node.status] ?? node.status}${ariaExtra}`)}">
          <rect class="body" width="${NODE.width}" height="${NODE.height}" rx="9"></rect>
          <rect class="badge" x="10" y="13" width="24" height="22" rx="4"></rect>
          <text class="glyph" x="22" y="28" text-anchor="middle">${escapeHtml(SIGN[node.status] ?? '=')}</text>
          <text class="name" x="44" y="21">${escapeHtml(basename(node.file))}</text>
          <text class="sub" x="44" y="36">${escapeHtml(subLabel(node))}</text>
        </g>`
  })
  .join('\n        ')

/**
 * Canvas labels: judgment that used to hide in the node sublabel. `risk` sits on
 * the first edge touching the node it grades; `orphan?` sits beside its node.
 */
const riskLabelsSvg = Object.entries(risk)
  .filter(([id]) => layout[id])
  .map(([id, level]) => {
    const edge = slice.edges.find((candidate) => candidate.from === id || candidate.to === id)
    if (!edge || !layout[edge.from] || !layout[edge.to]) return ''
    const { x1, y1, x2, y2 } = edgeGeometry(layout[edge.from], layout[edge.to])
    return `<text class="risk-label" data-for="${escapeHtml(id)}" x="${round((x1 + x2) / 2)}" y="${round((y1 + y2) / 2 - 6)}" text-anchor="middle">risk: ${escapeHtml(level)}</text>`
  })
  .filter(Boolean)
  .join('\n        ')

const orphanLabelsSvg = slice.nodes
  .filter((node) => orphans.includes(node.id) || node.members?.some((member) => orphans.includes(member.id)))
  .map(
    (node) =>
      `<text class="orphan-label" data-for="${escapeHtml(node.id)}" x="${layout[node.id].x + NODE.width / 2 + 9}" y="${layout[node.id].y + 4}">orphan?</text>`,
  )
  .join('\n        ')

// ── computed header numbers ────────────────────────────────────────────────
const changedNodes = slice.nodes
  .flatMap((node) => node.members ?? [node])
  .filter((node) => CHANGED_STATUSES.includes(node.status))
const ungraphed = slice.ungraphed ?? []
const changedFiles = new Set([...changedNodes.map((node) => node.file), ...ungraphed.map((file) => file.file)])
const largeSliceReasons = [
  ...(slice.nodes.length > MANUAL_LAYOUT_THRESHOLD ? [`${slice.nodes.length} graph nodes`] : []),
  ...(changedFiles.size > LARGE_FILE_WARNING_THRESHOLD ? [`${changedFiles.size} changed files`] : []),
]
const largeSliceWarningHtml = largeSliceReasons.length
  ? `<div class="large-slice-warning" role="note"><strong>Large review slice · ${escapeHtml(largeSliceReasons.join(' · '))}</strong><span>All nodes and files remain included. Dense graphs can be harder to read; use search, Files, and the detail panel for line-level inspection.</span></div>`
  : ''
const fileStats = new Map<string, { added: number; removed: number }>()
for (const node of changedNodes) fileStats.set(node.file, node.stats)
for (const file of ungraphed) fileStats.set(file.file, file.stats)
const totalAdded = [...fileStats.values()].reduce((sum, stats) => sum + stats.added, 0)
const totalRemoved = [...fileStats.values()].reduce((sum, stats) => sum + stats.removed, 0)
const excludedCount: number = slice.excluded?.count ?? 0
const hiddenByKind = Object.entries(slice.hidden.byKind ?? {})
  .map(([kind, count]) => `${count} ${kind}`)
  .join(' · ')

// ── sidebar ────────────────────────────────────────────────────────────────
const NAV = [
  { view: 'overview', label: 'Overview', ic: 'overview' },
  { view: 'files', label: 'Files', ic: 'files' },
  { view: 'graph', label: 'Graph', ic: 'graph' },
  { view: 'criteria', label: 'Acceptance Criteria', ic: 'criteria' },
  { view: 'flags', label: 'Attention Flags', ic: 'flags' },
]
const navHtml = NAV.map(
  (item) =>
    `<button class="nav-item${item.view === 'graph' ? ' active' : ''}" data-view="${item.view}"${item.view === 'graph' ? ' aria-current="page"' : ''}>${icon(item.ic)}<span>${escapeHtml(item.label)}</span></button>`,
).join('\n      ')

/**
 * A status with no nodes renders disabled, not hidden: an absent row would read
 * as a category that does not apply to this slice rather than one that is empty.
 */
const statusCounts = new Map<string, number>()
for (const node of slice.nodes) statusCounts.set(node.status, (statusCounts.get(node.status) ?? 0) + 1)
const orphanCount = slice.nodes.filter(
  (node) => orphans.includes(node.id) || node.members?.some((member) => orphans.includes(member.id)),
).length

const statusFilters = [
  { key: 'added', label: 'Added', count: statusCounts.get('added') ?? 0 },
  { key: 'modified', label: 'Modified', count: statusCounts.get('modified') ?? 0 },
  { key: 'deleted', label: 'Deleted', count: statusCounts.get('deleted') ?? 0 },
  { key: 'blast', label: 'Consumed (low risk)', count: statusCounts.get('blast') ?? 0 },
  { key: 'orphan', label: 'Orphan / Unused', count: orphanCount },
]
const statusFilterHtml = statusFilters
  .map(
    (filter) =>
      `<label class="check ${filter.key}${filter.count ? '' : ' empty'}"><input type="checkbox" data-status="${filter.key}" checked${filter.count ? '' : ' disabled'}><span class="box" aria-hidden="true"></span><span class="lbl">${escapeHtml(filter.label)}</span></label>`,
  )
  .join('\n        ')

const edgeCounts = new Map<string, number>()
for (const edge of slice.edges) {
  const key = edgeGroupOf(edge.type)
  edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1)
}
const edgeFilterHtml = EDGE_GROUPS.map(
  (group) =>
    `<label class="check${edgeCounts.get(group.key) ? '' : ' empty'}"><input type="checkbox" data-edge="${group.key}" checked${edgeCounts.get(group.key) ? '' : ' disabled'}><span class="box" aria-hidden="true"></span><span class="lseg ${group.sample}" aria-hidden="true"></span><span class="lbl">${escapeHtml(group.label)}</span></label>`,
).join('\n        ')

// ── topbar ─────────────────────────────────────────────────────────────────
const pr = slice.generated.pr
const worktreeSha = String(slice.generated.headSha).endsWith('+worktree')
const shaChip = worktreeSha
  ? `${escapeHtml(String(slice.generated.headSha).replace('+worktree', ''))}<b class="wt" title="${escapeHtml(slice.generated.headSha)}">+</b>`
  : escapeHtml(slice.generated.headSha)

const breadcrumbHtml = pr
  ? `<span class="crumb">${escapeHtml(slice.generated.repo)}</span><span class="sep">/</span><span class="crumb">PR #${escapeHtml(pr.number)}</span><span class="state ${escapeHtml(pr.state)}">${escapeHtml(pr.state[0].toUpperCase() + pr.state.slice(1))}</span>`
  : `<span class="crumb">${escapeHtml(slice.generated.repo)}</span><span class="sep">/</span><span class="crumb">${escapeHtml(slice.generated.range)}</span>`

const metricsHtml = [
  `<div class="metric"><span class="mlabel">Files changed</span><span class="mval" id="m-files">${changedFiles.size}</span></div>`,
  `<div class="metric"><span class="mval add" id="m-added">+${totalAdded}</span><span class="mlabel">Additions</span></div>`,
  `<div class="metric"><span class="mval del" id="m-removed">-${totalRemoved}</span><span class="mlabel">Deletions</span></div>`,
  `<div class="metric" title="nodes drawn on the graph"><span class="mlabel">In graph</span><span class="mval" id="m-nodes">${slice.nodes.length}</span></div>`,
  `<div class="metric" title="${escapeHtml(hiddenByKind || 'no files hidden')}"><span class="mlabel">Not shown</span><span class="mval" id="m-hidden">${slice.hidden.count}</span></div>`,
  excludedCount
    ? `<div class="metric warn"><span class="mval del">${excludedCount}</span><span class="mlabel">outside the TS project</span></div>`
    : '',
]
  .filter(Boolean)
  .join('\n      ')

// ── criteria table ─────────────────────────────────────────────────────────
const passedCount = criteria.filter((criterion) => criterion.status === 'covered').length
const RING_R = 9
const RING_C = round(2 * Math.PI * RING_R)
const progressHtml = hasCriteria
  ? `<span class="progress" role="img" aria-label="${passedCount} of ${criteria.length} criteria passed">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <circle class="track" cx="12" cy="12" r="${RING_R}" fill="none" stroke-width="2.6"></circle>
            <circle class="arc" cx="12" cy="12" r="${RING_R}" fill="none" stroke-width="2.6" stroke-linecap="round"
              stroke-dasharray="${round((passedCount / criteria.length) * RING_C)} ${RING_C}" transform="rotate(-90 12 12)"></circle>
          </svg>
          <b>${passedCount} / ${criteria.length}</b>
        </span>`
  : ''

const criteriaRowsHtml = hasCriteria
  ? criteria
      .map((criterion) => {
        const passed = criterion.status === 'covered'
        return `<tr class="crit-row ${passed ? 'ok' : 'miss'}" data-id="${escapeHtml(criterion.id)}" tabindex="0" role="button" aria-label="${escapeHtml(`criterion ${criterion.id}: ${passed ? 'Passed' : 'Failed'}`)}">
            <td class="c-id">${escapeHtml(criterion.id)}</td>
            <td class="c-desc"><span class="mark" aria-hidden="true">${passed ? '✓' : '✗'}</span>${escapeHtml(criterion.text)}</td>
            <td class="c-status">${passed ? 'Passed' : 'Failed'}</td>
          </tr>`
      })
      .concat(
        orphans.map(
          (id: string) =>
            `<tr class="crit-row orph" data-id="${escapeHtml(`orphan:${id}`)}" tabindex="0" role="button" aria-label="${escapeHtml(`orphan change ${basename(id)}, unmatched`)}">
            <td class="c-id">orphan</td>
            <td class="c-desc"><span class="mark" aria-hidden="true">⚠</span>orphan · ${escapeHtml(basename(id))}</td>
            <td class="c-status">Unmatched</td>
          </tr>`,
        ),
      )
      .join('\n          ')
  : `<tr class="crit-row muted"><td colspan="3">no criteria provided — intent layer inactive</td></tr>`

// ── files view ─────────────────────────────────────────────────────────────
const filesRowsHtml = slice.nodes
  .map((node) => {
    const changed = CHANGED_STATUSES.includes(node.status)
    return `<tr class="file-row" data-id="${escapeHtml(node.id)}" tabindex="0" role="button" aria-label="${escapeHtml(`${node.file}, ${STATUS_LABEL[node.status] ?? node.status}`)}">
            <td class="f-path">${escapeHtml(node.file)}${node.symbol ? `<span class="f-sym">#${escapeHtml(node.symbol)}</span>` : ''}</td>
            <td class="f-kind">${escapeHtml(node.kind)}${node.members?.length ? ` · ${node.members.length} symbols` : ''}</td>
            <td><span class="pill ${escapeHtml(node.status)}">${escapeHtml(STATUS_LABEL[node.status] ?? node.status)}</span></td>
            <td class="f-stat">${changed ? `<span class="add">+${node.stats.added}</span> <span class="del">-${node.stats.removed}</span>` : '<span class="faint">—</span>'}</td>
            <td class="f-spans faint">${escapeHtml(spanText(node) || '—')}</td>
          </tr>`
  })
  .concat(
    ungraphed.map(
      (file) =>
        `<tr class="file-row ungraphed" data-file="${escapeHtml(file.file)}" data-status="${escapeHtml(file.status)}" tabindex="0" role="button" aria-label="${escapeHtml(`${file.file}, ${STATUS_LABEL[file.status] ?? file.status}, not graphed`)}">
            <td class="f-path">${escapeHtml(file.file)}</td>
            <td class="f-kind">not graphed</td>
            <td><span class="pill ${escapeHtml(file.status)}">${escapeHtml(STATUS_LABEL[file.status] ?? file.status)}</span></td>
            <td class="f-stat"><span class="add">+${file.stats.added}</span> <span class="del">-${file.stats.removed}</span></td>
            <td class="f-spans faint">${escapeHtml(
              file.spans.length
                ? file.spans.map((span) => (span.start === span.end ? `L${span.start}` : `L${span.start}–L${span.end}`)).join(', ')
                : '—',
            )}</td>
          </tr>`,
    ),
  )
  .join('\n          ')

// ── overview + flags views ─────────────────────────────────────────────────
const epicenterSentence = slice.epicenters.length
  ? `Blast radius computed from <code>${escapeHtml(slice.epicenters.join(', '))}</code>.`
  : 'No single epicenter: no changed symbol has two or more consumers in this slice.'

const ledeHtml = `<p class="lede">Built from <code>${escapeHtml(slice.generated.range)}</code> at <code>${escapeHtml(slice.generated.headSha)}</code>. ${changedFiles.size} files changed → ${slice.nodes.length} nodes drawn, ${ungraphed.length} changed files listed without graph nodes, ${slice.hidden.count} context nodes hidden. ${epicenterSentence}</p>`

const flagRowHtml = (flag: any, withFacts: boolean) => {
  const target = flag.target.node ? `node:${flag.target.node}` : `chip:${flag.target.criterion}`
  const violet = flag.target.node && orphans.includes(flag.target.node)
  const facts = withFacts && flag.target.node ? `<div class="flag-facts faint">${escapeHtml(flag.target.node)}</div>` : ''
  return `<li><button data-go="${escapeHtml(target)}"><span class="n${violet ? ' v' : ''}">${String(flag.n).padStart(2, '0')}</span><span class="ftext">${escapeHtml(flag.text)}${facts}</span></button></li>`
}
const flagsListHtml = flags.map((flag) => flagRowHtml(flag, false)).join('\n          ')
const flagsFullHtml = flags.map((flag) => flagRowHtml(flag, true)).join('\n          ')
const readingOrderHtml = (annotations.readingOrder ?? [])
  .map((id: string) => `<li><button data-go="node:${escapeHtml(id)}"><span class="ftext">${escapeHtml(id)}</span></button></li>`)
  .join('\n          ')

const noteCount = Object.keys(notes).length

// ── the artifact's behaviour, built only from the embedded blocks ───────────
const artifactScript = String.raw`
const slice = JSON.parse(document.getElementById('gc-slice').textContent);
const ann = JSON.parse(document.getElementById('gc-annotations').textContent);
const nodeById = Object.fromEntries(slice.nodes.map(n => [n.id, n]));
const ungraphed = slice.ungraphed || [];
const ungraphedByFile = Object.fromEntries(ungraphed.map(f => [f.file, f]));
const memberParent = {};
slice.nodes.forEach(n => (n.members || []).forEach(m => { memberParent[m.id] = n.id; }));
const notes = ann.notes || {};
const risk = ann.risk || {};
const orphans = ann.orphans || [];
const criteria = ann.criteria || [];
const shell = document.getElementById('shell');
const right = document.getElementById('right');
const summaryBody = document.getElementById('summary-body');
const diffPreview = document.getElementById('diff-preview');
const diffPreviewHead = document.getElementById('diff-preview-head');
const tabDiff = document.getElementById('tab-diff-body');
const tabNotes = document.getElementById('tab-notes-body');
const svg = document.getElementById('canvas');
const nodeEls = Array.from(document.querySelectorAll('.node'));
const edgeEls = Array.from(document.querySelectorAll('.edge'));
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const base = p => String(p).split('/').pop();
const spanText = n => n.spans.length ? n.spans.map(s => s.start === s.end ? 'L' + s.start : 'L' + s.start + '–L' + s.end).join(', ') : '';
const CHANGED = ['added', 'modified', 'deleted'];
/* The overview lede is computed markup the renderer already emitted; stash it
   rather than rebuilding it here, so there is one source for that sentence. */
const overviewHtml = summaryBody.innerHTML;

/* ── filters, focus, search: fade, never remove ────────────────────────────
   DESIGN_CONTRACT § Signature elements: no control in this artifact removes a
   node from the document. Every hide below is an opacity class, and the node
   count the validator reads is unaffected by any of them. */
const state = {
  view: 'graph',
  tab: 'summary',
  status: { added: true, modified: true, deleted: true, blast: true, orphan: true },
  edges: { flow: true, type: true, token: true, imports: true },
  context: true,
  rings: true,
  search: '',
  collapsed: false,
  selected: null,
  criterion: null,
};
const isOrphanNode = el => el.dataset.orphan === '1';
function nodePassesFilters(el) {
  const s = el.dataset.status;
  if (s === 'context') { if (!state.context) return false; }
  else if (state.status[s] === false) return false;
  if (isOrphanNode(el) && state.status.orphan === false) return false;
  if (state.search) {
    const hay = (el.dataset.file + ' ' + el.dataset.symbol + ' ' + el.dataset.id).toLowerCase();
    if (hay.indexOf(state.search) < 0) return false;
  }
  return true;
}
function applyFilters() {
  const visible = new Set();
  nodeEls.forEach(el => {
    const pass = nodePassesFilters(el);
    el.classList.toggle('filtered', !pass);
    if (pass) visible.add(el.dataset.id);
  });
  edgeEls.forEach(el => {
    const pass = state.edges[el.dataset.group] !== false && visible.has(el.dataset.from) && visible.has(el.dataset.to);
    el.classList.toggle('filtered', !pass);
  });
  document.querySelectorAll('.risk-label, .orphan-label').forEach(el => {
    el.classList.toggle('filtered', !visible.has(el.dataset.for));
  });
  svg.classList.toggle('no-rings', !state.rings);
  document.querySelectorAll('.file-row[data-id]').forEach(el => {
    el.classList.toggle('filtered', !visible.has(el.dataset.id));
  });
}

/* ── zoom / pan: viewBox only, placed coordinates untouched ────────────────*/
const BASE_VIEW = { x: 0, y: 0, w: ${CANVAS.width}, h: ${CANVAS.height} };
const view = Object.assign({}, BASE_VIEW);
const zoomOut = document.getElementById('zoom-out');
const zoomIn = document.getElementById('zoom-in');
const zoomSel = document.getElementById('zoom-level');
function applyView() {
  svg.setAttribute('viewBox', [view.x, view.y, view.w, view.h].map(v => Math.round(v * 100) / 100).join(' '));
  const pct = Math.round((BASE_VIEW.w / view.w) * 100);
  /* Wheel and button zoom land on scales the preset list does not carry, so the
     readout keeps one scratch <option> for whatever the current scale is. */
  if (![...zoomSel.options].some(o => !o.dataset.custom && o.value === String(pct))) {
    let custom = zoomSel.querySelector('option[data-custom]');
    if (!custom) {
      custom = document.createElement('option');
      custom.dataset.custom = '1';
      zoomSel.appendChild(custom);
    }
    custom.value = String(pct);
    custom.textContent = pct + '%';
  }
  zoomSel.value = String(pct);
}
function setScale(scale, cx, cy) {
  const clamped = Math.min(16, Math.max(0.125, scale));
  const w = BASE_VIEW.w / clamped, h = BASE_VIEW.h / clamped;
  const ax = cx === undefined ? view.x + view.w / 2 : cx;
  const ay = cy === undefined ? view.y + view.h / 2 : cy;
  view.x = ax - (ax - view.x) * (w / view.w);
  view.y = ay - (ay - view.y) * (h / view.h);
  view.w = w; view.h = h;
  applyView();
}
const currentScale = () => BASE_VIEW.w / view.w;
zoomIn.addEventListener('click', () => setScale(currentScale() * 1.25));
zoomOut.addEventListener('click', () => setScale(currentScale() / 1.25));
zoomSel.addEventListener('change', () => setScale(Number(zoomSel.value) / 100));
document.getElementById('fit-view').addEventListener('click', () => {
  Object.assign(view, BASE_VIEW);
  applyView();
});
svg.addEventListener('wheel', e => {
  e.preventDefault();
  const pt = svgPoint(e);
  setScale(currentScale() * (e.deltaY < 0 ? 1.12 : 1 / 1.12), pt.x, pt.y);
}, { passive: false });
function svgPoint(e) {
  const r = svg.getBoundingClientRect();
  return {
    x: view.x + ((e.clientX - r.left) / r.width) * view.w,
    y: view.y + ((e.clientY - r.top) / r.height) * view.h,
  };
}
let panning = null;
svg.addEventListener('pointerdown', e => {
  if (e.target.closest('.node')) return;
  panning = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  svg.classList.add('panning');
});
window.addEventListener('pointermove', e => {
  if (!panning) return;
  const r = svg.getBoundingClientRect();
  view.x = panning.vx - ((e.clientX - panning.x) / r.width) * view.w;
  view.y = panning.vy - ((e.clientY - panning.y) / r.height) * view.h;
  applyView();
});
window.addEventListener('pointerup', () => { panning = null; svg.classList.remove('panning'); });

/* ── selection ─────────────────────────────────────────────────────────────*/
function clearSelection() {
  nodeEls.forEach(el => el.classList.remove('selected', 'faded'));
  document.querySelectorAll('.crit-row, .file-row').forEach(el => el.classList.remove('active'));
  edgeEls.forEach(el => { el.classList.remove('hot', 'mute'); el.setAttribute('marker-end', 'url(#m-dim)'); });
}
function heatEdges(id, on) {
  edgeEls.forEach(el => {
    if (el.dataset.from === id || el.dataset.to === id) {
      el.classList.toggle('hot', on);
      el.setAttribute('marker-end', on ? 'url(#m-hot)' : 'url(#m-dim)');
    }
  });
}
/* Diff excerpt: computed facts (git's bytes) in the default register. The gutter
   numbers excerpt lines, not file lines — the slice carries no file line numbers
   and inventing them would be a fabricated fact. That caveat is stated once per
   container (below), not under every block: a caption that repeats stops being
   read. */
const GUTTER_CAPTION = '<p class="caption">diff gutters number excerpt lines, not file lines</p>';
function diffBlock(n) {
  if (!n.excerpt || !n.excerpt.length) return '';
  const cls = { add: 'a', del: 'd', ctx: 'c', gap: 'g' };
  const sign = { add: '+', del: '-', ctx: ' ', gap: '' };
  let i = 0;
  const rows = n.excerpt.map(l => {
    const gap = l.op === 'gap';
    const num = gap ? '' : String(++i);
    const text = gap ? '/* ' + l.text + ' */' : sign[l.op] + l.text;
    return '<span class="dl ' + (cls[l.op] || 'c') + '"><i aria-hidden="true">' + num + '</i>' + esc(text) + '</span>';
  });
  return '<pre class="diff">' + rows.join('\n') + '</pre>';
}
function reviewerNote(id) {
  if (!notes[id]) return '';
  return '<div class="reviewer-note"><span class="register-caption">reviewer note</span><p class="why">' + esc(notes[id]) + '</p></div>';
}
function whyFlagged(id) {
  const out = slice.edges.filter(e => e.from === id).map(e =>
    '<li><code>' + esc(e.type) + '</code> → <b>' + esc(e.to) + '</b> <span class="faint">' + esc(e.evidence.file) + ':' + e.evidence.line + '</span></li>');
  if (!out.length) return '';
  return '<h3>why flagged</h3><ul class="facts">' + out.join('') + '</ul>';
}
function changedLines(n) {
  const rows = [];
  if (n.exportedSymbolsChanged.length) rows.push('<li>exported symbols changed: <b>' + esc(n.exportedSymbolsChanged.join(', ')) + '</b></li>');
  if (n.spans.length) rows.push('<li>changed lines: <b>' + esc(spanText(n)) + '</b></li>');
  const consumers = slice.edges.filter(e => e.to === n.id);
  if (consumers.length) rows.push('<li>referenced by <b>' + consumers.length + '</b> slice node(s)</li>');
  return rows.length ? '<h3>computed facts</h3><ul class="facts">' + rows.join('') + '</ul>' : '';
}
/* Collapsed (--collapse dir) nodes keep their members: symbol-level facts and
   any note the reviewer attached to a member id. */
function memberFacts(n) {
  if (!n.members || !n.members.length) return '';
  const rows = n.members.map(m => {
    const changed = CHANGED.indexOf(m.status) >= 0;
    const stats = changed ? ' +' + m.stats.added + ' -' + m.stats.removed : '';
    const lines = spanText(m) ? ' · ' + spanText(m) : '';
    const symbols = m.exportedSymbolsChanged.length ? '<br><span class="faint">exports: ' + esc(m.exportedSymbolsChanged.join(', ')) + '</span>' : '';
    const orph = orphans.indexOf(m.id) >= 0 ? ' <span class="pill orphan">orphan</span>' : '';
    const rk = risk[m.id] ? ' <span class="pill risk-' + esc(risk[m.id]) + '">risk ' + esc(risk[m.id]) + '</span>' : '';
    return '<li><b>' + esc(m.id) + '</b> <span class="pill ' + esc(m.status) + '">' + esc(m.status) + '</span>' + rk + orph +
      '<span class="faint">' + esc(stats) + esc(lines) + '</span>' + symbols + reviewerNote(m.id) + diffBlock(m) + '</li>';
  });
  const anyDiff = n.members.some(m => m.excerpt && m.excerpt.length);
  return '<h3>grouped symbols · ' + n.members.length + '</h3><ul class="facts members">' + rows.join('') + '</ul>' +
    (anyDiff ? GUTTER_CAPTION : '');
}
function nodeStat(n) {
  return CHANGED.indexOf(n.status) >= 0
    ? '<span class="add">+' + n.stats.added + '</span> <span class="del">-' + n.stats.removed + '</span>'
    : '<span class="faint">untouched in this range</span>';
}
function selectNode(id) {
  clearSelection();
  /* A member id (from readingOrder on a collapsed slice) resolves to the node
     that stands for it; anything unknown is ignored rather than throwing. */
  if (!nodeById[id] && memberParent[id]) id = memberParent[id];
  const n = nodeById[id];
  if (!n) return;
  state.selected = id;
  state.criterion = null;
  const el = nodeEls.find(e => e.dataset.id === id);
  if (el) el.classList.add('selected');
  document.querySelectorAll('.file-row[data-id="' + cssEsc(id) + '"]').forEach(r => r.classList.add('active'));
  edgeEls.forEach(e => {
    const hit = e.dataset.from === id || e.dataset.to === id;
    e.classList.toggle('hot', hit);
    e.classList.toggle('mute', !hit);
    e.setAttribute('marker-end', hit ? 'url(#m-hot)' : 'url(#m-dim)');
  });
  const changed = CHANGED.indexOf(n.status) >= 0;
  const judgment = [];
  if (risk[id]) judgment.push('<span class="pill risk-' + esc(risk[id]) + '">risk ' + esc(risk[id]) + '</span>');
  if (orphans.indexOf(id) >= 0) judgment.push('<span class="pill orphan">orphan</span>');
  summaryBody.innerHTML =
    '<button class="back" id="back">← back to slice overview</button>' +
    '<div class="file-head"><span class="path">' + esc(base(n.file)) + '</span>' +
      '<span class="pill ' + esc(n.status) + '">' + esc(statusLabel(n.status)) + '</span>' +
      (n.symbol ? '<span class="tag">' + esc(n.symbol) + '</span>' : '') + '</div>' +
    (judgment.length ? '<div class="judgment-pills"><span class="register-caption">model judgment</span>' + judgment.join('') + '</div>' : '') +
    '<div class="loc">' + esc(n.file) + ' · ' + nodeStat(n) + (spanText(n) ? ' · ' + esc(spanText(n)) : '') + '</div>' +
    reviewerNote(id) +
    (changed ? changedLines(n) : whyFlagged(id)) +
    memberFacts(n);
  document.getElementById('back').addEventListener('click', overview);
  renderDiffPreview(n);
  renderDiffTab(n);
}
function selectUngraphed(file) {
  clearSelection();
  const n = ungraphedByFile[file];
  if (!n) return;
  state.selected = 'file:' + file;
  state.criterion = null;
  document.querySelectorAll('.file-row.ungraphed[data-file="' + cssEsc(file) + '"]').forEach(r => r.classList.add('active'));
  summaryBody.innerHTML =
    '<button class="back" id="back">← back to slice overview</button>' +
    '<div class="file-head"><span class="path">' + esc(base(n.file)) + '</span>' +
      '<span class="pill ' + esc(n.status) + '">' + esc(statusLabel(n.status)) + '</span>' +
      '<span class="tag">not graphed</span></div>' +
    '<div class="loc">' + esc(n.file) + ' · ' + nodeStat(n) + (spanText(n) ? ' · ' + esc(spanText(n)) : '') + '</div>' +
    '<h3>computed facts</h3><ul class="facts"><li>This changed file is listed for review but has no dependency-graph node.</li></ul>';
  document.getElementById('back').addEventListener('click', overview);
  renderDiffPreview(n);
  renderDiffTab(n);
}
const STATUS_LABELS = ${JSON.stringify(STATUS_LABEL)};
const statusLabel = s => STATUS_LABELS[s] || s;
const cssEsc = s => String(s).replace(/["\\]/g, '\\$&');
function renderDiffPreview(n) {
  if (!n) {
    diffPreviewHead.innerHTML = '';
    diffPreview.innerHTML = '<p class="empty">select a file or node to read its diff</p>';
    return;
  }
  diffPreviewHead.innerHTML =
    '<span class="dp-path">' + esc(n.file) + '</span>' +
    '<span class="dp-stat">' + nodeStat(n) + '</span>' +
    '<span class="pill ' + esc(n.status) + '">' + esc(statusLabel(n.status)) + '</span>';
  const block = diffBlock(n);
  diffPreview.innerHTML = block
    ? block + GUTTER_CAPTION
    : '<p class="empty">' + (n.status === 'blast' || n.status === 'context'
      ? 'untouched in this range — see why flagged above'
      : 'no textual excerpt available for this change') + '</p>';
}
function renderDiffTab(n) {
  const list = n ? [n] : [...slice.nodes, ...ungraphed].filter(x => x.excerpt && x.excerpt.length);
  if (!list.length) { tabDiff.innerHTML = '<p class="empty">no diff excerpts in this slice</p>'; return; }
  /* One caption for the whole tab, however many blocks it holds. */
  tabDiff.innerHTML = GUTTER_CAPTION + list.map(x =>
    '<div class="card"><div class="card-head"><span class="dp-path">' + esc(x.file) + '</span>' +
    '<span class="dp-stat">' + nodeStat(x) + '</span></div>' +
    (diffBlock(x) || '<p class="empty">no excerpt for this node</p>') +
    (x.members || []).map(m => diffBlock(m)).join('') + '</div>').join('');
}
function renderNotesTab() {
  const ids = Object.keys(notes);
  if (!ids.length) { tabNotes.innerHTML = '<p class="empty">no reviewer notes in this slice</p>'; return; }
  tabNotes.innerHTML = '<div class="card"><span class="register-caption">model judgment</span>' + ids.map(id =>
    '<div class="note-entry"><button class="note-target" data-go="node:' + esc(id) + '">' + esc(id) + '</button>' +
    reviewerNote(id) + '</div>').join('') + '</div>';
  wireGo(tabNotes);
}
function activateCriterion(cid) {
  clearSelection();
  state.selected = null;
  state.criterion = cid;
  const row = document.querySelector('.crit-row[data-id="' + cssEsc(cid) + '"]');
  if (row) row.classList.add('active');
  const isOrphan = cid.indexOf('orphan:') === 0;
  const c = isOrphan ? null : criteria.find(x => x.id === cid);
  if (!isOrphan && !c) return;
  const ids = isOrphan ? [cid.slice(7)] : (c.nodes || []);
  nodeEls.forEach(el => { if (ids.indexOf(el.dataset.id) < 0) el.classList.add('faded'); });
  edgeEls.forEach(el => { if (!(ids.indexOf(el.dataset.from) >= 0 && ids.indexOf(el.dataset.to) >= 0)) el.classList.add('mute'); });
  const label = isOrphan ? 'orphan · ' + base(ids[0]) : (c.status === 'covered' ? 'Passed' : 'Failed') + ' · ' + c.text;
  const note = isOrphan
    ? 'Changed in this range but matched to no criterion. Approve or revert — explicitly.'
    : (c.note || '');
  summaryBody.innerHTML =
    '<button class="back" id="back">← back to slice overview</button>' +
    '<div class="file-head"><span class="path">' + (isOrphan ? 'orphan change' : 'criterion ' + esc(cid)) + '</span></div>' +
    '<div class="loc">' + esc(label) + '</div>' +
    '<div class="reviewer-note"><span class="register-caption">model-matched</span><p class="why">' + esc(note) + '</p>' +
      '<ul class="facts">' + ids.map(i => '<li><b>' + esc(i) + '</b></li>').join('') + '</ul></div>';
  document.getElementById('back').addEventListener('click', overview);
  renderDiffPreview(nodeById[ids[0]] || null);
}
function overview() {
  clearSelection();
  state.selected = null;
  state.criterion = null;
  summaryBody.innerHTML = overviewHtml;
  renderDiffPreview(null);
  renderDiffTab(null);
}
function wireGo(root) {
  root.querySelectorAll('[data-go]').forEach(b => {
    if (b.dataset.wired) return;
    b.dataset.wired = '1';
    b.addEventListener('click', () => {
      const parts = b.dataset.go.split(':');
      const kind = parts.shift();
      const id = parts.join(':');
      if (kind === 'node') selectNode(id); else activateCriterion(id);
    });
  });
}

/* ── views and tabs ────────────────────────────────────────────────────────*/
function setView(v) {
  state.view = v;
  shell.dataset.view = v;
  document.querySelectorAll('.nav-item').forEach(el => {
    const on = el.dataset.view === v;
    el.classList.toggle('active', on);
    if (on) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
  });
}
function setTab(t) {
  state.tab = t;
  right.dataset.tab = t;
  document.querySelectorAll('.tab').forEach(el => {
    const on = el.dataset.tab === t;
    el.classList.toggle('active', on);
    el.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  if (t === 'notes') renderNotesTab();
}
document.querySelectorAll('.nav-item').forEach(el => el.addEventListener('click', () => { setView(el.dataset.view); save(); }));
document.querySelectorAll('.tab').forEach(el => el.addEventListener('click', () => setTab(el.dataset.tab)));
document.getElementById('view-all-flags').addEventListener('click', () => { setView('flags'); save(); });
document.getElementById('open-diff-tab').addEventListener('click', () => setTab('diff'));

/* ── controls ──────────────────────────────────────────────────────────────*/
document.querySelectorAll('input[data-status]').forEach(el =>
  el.addEventListener('change', () => { state.status[el.dataset.status] = el.checked; applyFilters(); save(); }));
document.querySelectorAll('input[data-edge]').forEach(el =>
  el.addEventListener('change', () => { state.edges[el.dataset.edge] = el.checked; applyFilters(); save(); }));
const ctxToggle = document.getElementById('focus-context');
const ringToggle = document.getElementById('focus-rings');
ctxToggle.addEventListener('change', () => { state.context = ctxToggle.checked; applyFilters(); save(); });
ringToggle.addEventListener('change', () => { state.rings = ringToggle.checked; applyFilters(); save(); });
document.getElementById('clear-filters').addEventListener('click', () => {
  document.querySelectorAll('input[data-status], input[data-edge]').forEach(el => { if (!el.disabled) el.checked = true; });
  Object.keys(state.status).forEach(k => state.status[k] = true);
  Object.keys(state.edges).forEach(k => state.edges[k] = true);
  searchInput.value = '';
  state.search = '';
  applyFilters();
  save();
});
const searchInput = document.getElementById('search');
searchInput.addEventListener('input', () => { state.search = searchInput.value.trim().toLowerCase(); applyFilters(); });
const critCard = document.getElementById('card-criteria');
document.getElementById('crit-collapse').addEventListener('click', () => {
  state.collapsed = !state.collapsed;
  critCard.classList.toggle('collapsed', state.collapsed);
  save();
});

/* ── save view: per-slice, so one slice never inherits another's view ──────*/
const KEY = 'groundcheck:view:' + slice.generated.headSha;
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify({
      view: state.view, status: state.status, edges: state.edges,
      context: state.context, rings: state.rings, collapsed: state.collapsed,
    }));
    saveBtn.classList.add('saved');
    setTimeout(() => saveBtn.classList.remove('saved'), 900);
  } catch (e) { /* private mode: the artifact still works, it just does not persist */ }
}
const saveBtn = document.getElementById('save-view');
saveBtn.addEventListener('click', save);
(function restore() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { saved = null; }
  if (!saved) return;
  Object.assign(state.status, saved.status || {});
  Object.assign(state.edges, saved.edges || {});
  state.context = saved.context !== false;
  state.rings = saved.rings !== false;
  state.collapsed = !!saved.collapsed;
  document.querySelectorAll('input[data-status]').forEach(el => { if (!el.disabled) el.checked = state.status[el.dataset.status] !== false; });
  document.querySelectorAll('input[data-edge]').forEach(el => { if (!el.disabled) el.checked = state.edges[el.dataset.edge] !== false; });
  ctxToggle.checked = state.context;
  ringToggle.checked = state.rings;
  critCard.classList.toggle('collapsed', state.collapsed);
  if (saved.view) setView(saved.view);
})();

/* ── row and node wiring ───────────────────────────────────────────────────*/
const activate = (el, fn) => {
  el.addEventListener('click', fn);
  el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } });
};
nodeEls.forEach(el => {
  activate(el, () => selectNode(el.dataset.id));
  el.addEventListener('mouseenter', () => heatEdges(el.dataset.id, true));
  el.addEventListener('mouseleave', () => heatEdges(el.dataset.id, false));
});
document.querySelectorAll('.crit-row[data-id]').forEach(el => activate(el, () => activateCriterion(el.dataset.id)));
document.querySelectorAll('.file-row[data-id]').forEach(el => activate(el, () => selectNode(el.dataset.id)));
document.querySelectorAll('.file-row.ungraphed[data-file]').forEach(el => activate(el, () => selectUngraphed(el.dataset.file)));
wireGo(document);
svg.addEventListener('click', e => {
  if (e.target.tagName === 'rect' && e.target.getAttribute('fill') === 'url(#dots)') overview();
});

applyView();
applyFilters();
renderDiffPreview(null);
renderDiffTab(null);
`

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>groundcheck · ${escapeHtml(slice.generated.range)} — review slice</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Spline+Sans+Mono:wght@400;500;600&family=Instrument+Sans:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root{
    --ink:#0D1321;
    --panel:#121A2B;
    --panel2:#172137;
    --grid:#1D2A46;
    --line:#2A3856;
    --paper:#E9E6DC;
    --dim:#8A94AC;
    --faint:#5B678A;
    --added:#63C68F;
    --modified:#E5B04B;
    --deleted:#E06552;
    --consumed:#5B8DEF;
    --ring:#E06552;
    --context:#4E5F82;
    --violet:#A78BDA;
    --mono:'Spline Sans Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
    --sans:'Instrument Sans',system-ui,sans-serif;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%}
  body{background:var(--ink);color:var(--paper);font-family:var(--mono);font-size:13px;overflow:hidden}

  /* ── shell ─────────────────────────────────────────────────────────────*/
  .shell{
    display:grid;height:100vh;
    grid-template-columns:230px minmax(0,1fr) 400px;
    grid-template-rows:56px minmax(0,1fr);
  }
  .sidebar{grid-row:1/3;grid-column:1;border-right:1px solid var(--grid);display:flex;flex-direction:column;overflow-y:auto}
  .topbar{grid-row:1;grid-column:2/4;border-bottom:1px solid var(--grid);display:flex;align-items:center;gap:9px;padding:0 14px;overflow-x:auto}
  .center{grid-row:2;grid-column:2;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:14px;min-width:0}
  .rightpanel{grid-row:2;grid-column:3;border-left:1px solid var(--grid);background:var(--panel);overflow-y:auto;display:flex;flex-direction:column}

  /* ── sidebar ───────────────────────────────────────────────────────────*/
  .brand{
    height:56px;display:flex;align-items:center;gap:9px;padding:0 16px;
    border-bottom:1px solid var(--grid);font-weight:600;letter-spacing:.03em;font-size:15px;flex:none;
  }
  .brand .mark{
    width:20px;height:20px;border-radius:50%;border:2px solid var(--modified);flex:none;
    display:grid;place-items:center;
  }
  .brand .mark::after{content:"";width:6px;height:6px;border-radius:50%;background:var(--modified)}
  .side-sec{padding:14px 12px 4px}
  .side-sec.tight{padding-top:8px}
  .side-head{
    display:flex;align-items:center;justify-content:space-between;
    font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);
    padding:0 4px 8px;
  }
  .side-head .link{all:unset;cursor:pointer;font-size:10px;letter-spacing:.04em;text-transform:none;color:var(--faint)}
  .side-head .link:hover,.side-head .link:focus-visible{color:var(--paper);text-decoration:underline}
  .group-label{font-size:11px;color:var(--dim);padding:8px 4px 6px}
  nav{display:flex;flex-direction:column;gap:2px;padding:8px}
  .nav-item{
    all:unset;cursor:pointer;display:flex;align-items:center;gap:10px;
    padding:9px 10px;border-radius:8px;font-family:var(--mono);font-size:12.5px;color:var(--dim);
  }
  .nav-item .ic{flex:none;opacity:.8}
  .nav-item:hover{background:var(--panel);color:var(--paper)}
  .nav-item.active{background:var(--panel2);color:var(--paper)}
  .nav-item:focus-visible{outline:1px solid var(--paper);outline-offset:-1px}
  .check{
    display:flex;align-items:center;gap:9px;padding:5px 4px;cursor:pointer;
    font-size:12px;color:#C9CDD9;
  }
  .check input{position:absolute;opacity:0;width:0;height:0}
  .check .box{
    width:14px;height:14px;border-radius:3px;border:1.4px solid var(--faint);flex:none;
    display:grid;place-items:center;
  }
  .check .box::after{content:"";width:7px;height:4px;border-left:1.6px solid var(--ink);border-bottom:1.6px solid var(--ink);transform:rotate(-45deg) translateY(-1px);opacity:0}
  .check input:checked+.box{background:var(--dim);border-color:var(--dim)}
  .check input:checked+.box::after{opacity:1}
  .check.added input:checked+.box{background:var(--added);border-color:var(--added)}
  .check.modified input:checked+.box{background:var(--modified);border-color:var(--modified)}
  .check.deleted input:checked+.box{background:var(--deleted);border-color:var(--deleted)}
  .check.blast input:checked+.box{background:var(--consumed);border-color:var(--consumed)}
  .check.orphan input:checked+.box{background:var(--violet);border-color:var(--violet)}
  .check input:focus-visible+.box{outline:1px solid var(--paper);outline-offset:2px}
  .check.empty{color:var(--faint);cursor:default}
  .check.empty .box{opacity:.4}
  .switch{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 4px;cursor:pointer;font-size:12px;color:#C9CDD9}
  .switch input{position:absolute;opacity:0;width:0;height:0}
  .switch .track{width:32px;height:17px;border-radius:9px;background:var(--grid);flex:none;position:relative;transition:background .15s}
  .switch .track::after{content:"";position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:var(--faint);transition:transform .15s,background .15s}
  .switch input:checked+.track{background:rgba(99,198,143,.3)}
  .switch input:checked+.track::after{transform:translateX(15px);background:var(--added)}
  .switch input:focus-visible+.track{outline:1px solid var(--paper);outline-offset:2px}
  .side-foot{margin-top:auto;padding:12px}
  .save-view{
    all:unset;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;
    width:100%;padding:10px;border:1px solid var(--grid);border-radius:8px;
    font-family:var(--mono);font-size:12px;color:var(--dim);
  }
  .save-view:hover,.save-view:focus-visible{border-color:var(--faint);color:var(--paper)}
  .save-view.saved{border-color:var(--added);color:var(--added)}

  /* ── topbar ────────────────────────────────────────────────────────────*/
  .crumbs{
    display:flex;align-items:center;gap:8px;flex:none;
    border:1px solid var(--grid);border-radius:8px;padding:7px 12px;
  }
  .crumbs .crumb{font-size:12px;color:#C9CDD9;white-space:nowrap}
  .crumbs .sep{color:var(--faint)}
  .state{font-size:9.5px;font-weight:600;letter-spacing:.05em;border-radius:4px;padding:2px 7px}
  .state.open{background:rgba(99,198,143,.16);color:var(--added)}
  .state.merged{background:rgba(167,139,218,.16);color:var(--violet)}
  .state.closed{background:rgba(138,148,172,.18);color:var(--dim)}
  .chip-t{
    font-size:11px;color:var(--dim);border:1px solid var(--grid);border-radius:8px;
    padding:7px 11px;white-space:nowrap;flex:none;
  }
  .chip-t .wt{color:var(--modified);font-weight:600}
  .metric{
    border:1px solid var(--grid);border-radius:8px;padding:5px 12px;flex:none;
    display:flex;flex-direction:column;line-height:1.25;
  }
  .metric.warn{border-color:var(--deleted)}
  .mlabel{font-size:9.5px;color:var(--faint);white-space:nowrap}
  .mval{font-size:13px;color:var(--paper);font-weight:500}
  .mval.add{color:var(--added)} .mval.del{color:var(--deleted)}
  .topbar .spacer{flex:1;min-width:8px}
  .search-wrap{display:flex;align-items:center;gap:7px;border:1px solid transparent;border-radius:8px;padding:6px 9px;flex:none}
  .search-wrap:focus-within{border-color:var(--grid);background:var(--panel)}
  .search-wrap .ic{color:var(--dim);flex:none}
  #search{
    all:unset;width:0;font-family:var(--mono);font-size:12px;color:var(--paper);
    transition:width .18s;
  }
  .search-wrap:focus-within #search,#search:not(:placeholder-shown){width:150px}
  #search::placeholder{color:var(--faint)}

  /* ── cards and views ───────────────────────────────────────────────────*/
  .card{background:var(--panel);border:1px solid var(--grid);border-radius:10px}
  /* flex:none on the cards: min-height:0 let the graph card shrink below its own
     canvas at narrow widths and the nodes drew over the criteria table. */
  .center>.card{display:none;flex-direction:column;flex:none}
  .shell[data-view="graph"] #card-graph{display:flex;flex:1 1 auto;min-height:490px}
  .shell[data-view="graph"] #card-criteria{display:flex}
  .shell[data-view="criteria"] #card-criteria{display:flex}
  .shell[data-view="overview"] #card-overview{display:flex}
  .shell[data-view="files"] #card-files{display:flex}
  .shell[data-view="flags"] #card-flags{display:flex}
  .card-head{display:flex;align-items:flex-start;gap:12px;padding:14px 16px}
  .card-head h1{font-size:16px;font-weight:600;letter-spacing:.01em}
  .card-head h2{font-size:13.5px;font-weight:600}
  .card-head .sub{font-size:11px;color:var(--faint);margin-top:3px;font-family:var(--sans)}
  .card-head .grow{flex:1;min-width:0}
  .large-slice-warning{
    display:flex;align-items:center;gap:14px;padding:10px 16px;
    border-top:1px solid rgba(229,176,75,.34);background:rgba(229,176,75,.08);
    color:var(--dim);font-family:var(--sans);font-size:11.5px;line-height:1.4;
  }
  .large-slice-warning strong{color:var(--modified);font-family:var(--mono);font-size:10.5px;white-space:nowrap}
  .toolbar{display:flex;align-items:center;gap:7px;flex:none}
  .tbtn{
    all:unset;cursor:pointer;border:1px solid var(--grid);border-radius:7px;
    padding:7px 12px;font-family:var(--mono);font-size:11.5px;color:#C9CDD9;
    display:flex;align-items:center;gap:6px;
  }
  .tbtn:hover,.tbtn:focus-visible{border-color:var(--faint);background:var(--panel2)}
  .tbtn.ico{padding:7px 9px;color:var(--dim)}
  #zoom-level{
    background:var(--panel);color:#C9CDD9;border:1px solid var(--grid);border-radius:7px;
    padding:7px 8px;font-family:var(--mono);font-size:11.5px;
  }
  #zoom-level:focus-visible{outline:1px solid var(--paper)}

  /* ── canvas ────────────────────────────────────────────────────────────*/
  /* overflow:hidden clips the canvas to its card — without it a pan pushes nodes
     out over the criteria table, and at narrow widths the auto-height row lets
     the whole graph spill. */
  .canvas-wrap{position:relative;flex:1;min-height:430px;overflow:hidden;border-radius:0 0 10px 10px;border-top:1px solid var(--grid)}
  svg#canvas{display:block;width:100%;height:100%;cursor:grab;touch-action:none}
  svg#canvas.panning{cursor:grabbing}
  svg#canvas.no-rings #rings{display:none}
  .edge{stroke:var(--line);fill:none;transition:stroke .15s,opacity .15s}
  .edge.type{stroke-dasharray:6 5;stroke-width:1.5}
  .edge.renders{stroke-width:2.2}
  .edge.calls{stroke-width:1.5}
  .edge.token{stroke-dasharray:2 4;stroke-width:1.5}
  .edge.imports{stroke-width:1;opacity:.55}
  .edge.hot{stroke:var(--paper);opacity:1}
  .edge.hot.type{stroke:var(--consumed)}
  .edge.mute{opacity:.14}
  .edge.filtered{opacity:.08}

  .node{cursor:pointer;outline:none}
  .node rect.body{fill:var(--panel2);stroke-width:1.4;transition:filter .15s,opacity .15s}
  .node text{font-family:var(--mono);pointer-events:none}
  .node .name{fill:var(--paper);font-size:11.5px;font-weight:500}
  .node .sub{fill:var(--dim);font-size:9.5px}
  .node .glyph{font-size:11px;font-weight:600}
  .node.added rect.body{stroke:var(--added)}
  .node.added rect.badge{fill:rgba(99,198,143,.16)} .node.added .glyph{fill:var(--added)}
  .node.modified rect.body{stroke:var(--modified)}
  .node.modified rect.badge{fill:rgba(229,176,75,.16)} .node.modified .glyph{fill:var(--modified)}
  .node.deleted rect.body{stroke:var(--deleted);stroke-dasharray:2 3}
  .node.deleted rect.badge{fill:rgba(224,101,82,.16)} .node.deleted .glyph{fill:var(--deleted)}
  .node.blast rect.body{stroke:var(--consumed)}
  .node.blast rect.badge{fill:rgba(91,141,239,.16)} .node.blast .glyph{fill:var(--consumed)}
  .node.context rect.body{stroke:var(--context)}
  .node.context rect.badge{fill:rgba(78,95,130,.2)} .node.context .glyph{fill:var(--context)}
  .node.orphan rect.body{stroke:var(--violet)}
  .node.faded{opacity:.22}
  .node.filtered{opacity:.22}
  .node.selected rect.body{filter:drop-shadow(0 0 7px rgba(233,230,220,.35));stroke-width:2}
  .node:focus-visible rect.body{stroke:var(--paper);stroke-width:2}
  .risk-label{fill:var(--faint);font-size:9.5px;font-family:var(--mono)}
  .orphan-label{fill:var(--violet);font-size:10px;font-family:var(--mono)}
  .risk-label.filtered,.orphan-label.filtered{opacity:.18}

  .ring{fill:none;stroke:var(--ring);opacity:.16;stroke-dasharray:3 6}
  @keyframes ringpulse{0%,100%{opacity:.10}50%{opacity:.26}}
  .ring.r1{animation:ringpulse 4s ease-in-out infinite}
  .ring.r2{animation:ringpulse 4s ease-in-out 1.3s infinite}
  .ring.r3{animation:ringpulse 4s ease-in-out 2.6s infinite}
  @media (prefers-reduced-motion:reduce){.ring{animation:none !important}}

  .legend{
    position:absolute;left:14px;bottom:12px;
    background:rgba(13,19,33,.88);border:1px solid var(--grid);border-radius:8px;
    padding:10px 12px;font-size:10.5px;color:var(--dim);
    display:grid;grid-template-columns:auto auto;gap:5px 22px;backdrop-filter:blur(3px);
    /* the layout is model-placed, so a node can land under the legend; never let
       the overlay swallow that node's click */
    pointer-events:none;
  }
  .legend .k{display:flex;align-items:center;gap:7px;white-space:nowrap}
  .legend .cap{grid-column:1/3;color:var(--faint);font-size:9.5px;padding-top:2px}
  .dot{width:9px;height:9px;border-radius:3px;flex:none}
  .lseg{width:22px;height:0;border-top:2px solid var(--faint);flex:none}
  .lseg.dash{border-top-style:dashed}
  .lseg.dots{border-top-style:dotted}
  .lseg.thin{border-top-width:1px;opacity:.6}

  /* ── tables ────────────────────────────────────────────────────────────*/
  table{width:100%;border-collapse:collapse;font-size:11.5px}
  thead th{
    text-align:left;font-size:10px;letter-spacing:.1em;text-transform:uppercase;
    color:var(--faint);font-weight:500;padding:8px 10px;border-top:1px solid var(--grid);
  }
  tbody td{padding:8px 10px;border-top:1px solid var(--grid);color:#C9CDD9;vertical-align:top}
  tbody tr{cursor:pointer}
  tbody tr:hover{background:var(--panel2)}
  tbody tr.active{background:var(--panel2)}
  tbody tr:focus-visible{outline:1px solid var(--paper);outline-offset:-1px}
  tbody tr.filtered{opacity:.3}
  tbody tr.muted{cursor:default;color:var(--faint)}
  .c-id{color:var(--dim);white-space:nowrap;width:64px}
  .c-status{white-space:nowrap;width:90px}
  .crit-row.ok .c-status{color:var(--added)}
  .crit-row.miss .c-status{color:var(--deleted)}
  .crit-row.orph .c-status{color:var(--violet)}
  .c-desc .mark{margin-right:8px;font-weight:600}
  .crit-row.ok .mark{color:var(--added)}
  .crit-row.miss .mark{color:var(--deleted)}
  .crit-row.orph .mark{color:var(--violet)}
  .f-path{color:var(--paper)}
  .f-sym{color:var(--dim)}
  .f-kind,.f-spans{white-space:nowrap;color:var(--dim)}
  .f-stat{white-space:nowrap}
  .f-stat .add{color:var(--added)} .f-stat .del{color:var(--deleted)}
  .table-wrap{overflow-x:auto}
  #card-criteria.collapsed .table-wrap{display:none}
  .shell[data-view="criteria"] #card-criteria .table-wrap{display:block}
  .progress{display:flex;align-items:center;gap:7px;font-size:11.5px;color:var(--dim);flex:none}
  .progress .track{stroke:var(--grid)}
  .progress .arc{stroke:var(--added)}
  .progress b{color:var(--paper);font-weight:500}

  /* ── right panel ───────────────────────────────────────────────────────*/
  .tabs{display:flex;gap:2px;padding:0 8px;border-bottom:1px solid var(--grid);flex:none}
  .tab{
    all:unset;cursor:pointer;padding:16px 14px 13px;font-family:var(--mono);font-size:12.5px;
    color:var(--dim);border-bottom:2px solid transparent;display:flex;align-items:center;gap:7px;
  }
  .tab:hover{color:var(--paper)}
  .tab.active{color:var(--paper);border-bottom-color:var(--added)}
  .tab:focus-visible{outline:1px solid var(--paper);outline-offset:-3px}
  .tab .count{font-size:10px;background:var(--panel2);border-radius:4px;padding:1px 6px;color:var(--dim)}
  .tab-body{display:none;padding:14px;flex-direction:column;gap:14px;overflow-y:auto}
  .rightpanel[data-tab="summary"] #tab-summary{display:flex}
  .rightpanel[data-tab="diff"] #tab-diff-body{display:flex}
  .rightpanel[data-tab="notes"] #tab-notes-body{display:flex}
  .rightpanel .card{padding:14px 15px}
  .rightpanel .card>h2{font-size:12.5px;font-weight:600;margin-bottom:10px;display:flex;align-items:center;gap:8px}
  .rightpanel .card>h2 .count{font-size:10px;background:var(--panel2);border-radius:4px;padding:1px 6px;color:var(--dim);font-weight:400}
  .rightpanel .card-head{padding:0 0 10px;flex-wrap:wrap;gap:8px;align-items:center}
  h3{font-size:10.5px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);margin:14px 0 8px}
  .lede,.why{font-family:var(--sans);font-size:13px;line-height:1.55;color:#C9CDD9}
  .lede code,.why code,.loc code{font-family:var(--mono);font-size:.92em;background:var(--panel2);border-radius:4px;padding:1px 5px;color:var(--paper);word-break:break-all}
  .file-head{display:flex;align-items:center;gap:9px;margin-bottom:5px;flex-wrap:wrap}
  .file-head .path{font-size:13.5px;font-weight:600}
  .file-head .tag{font-size:10.5px;color:var(--dim);border:1px solid var(--grid);border-radius:4px;padding:2px 7px}
  .loc{font-size:10.5px;color:var(--faint);margin-bottom:12px;word-break:break-all}
  .loc .add{color:var(--added)} .loc .del{color:var(--deleted)}
  .pill{font-size:9.5px;border-radius:4px;padding:2px 7px;letter-spacing:.04em;font-weight:600;white-space:nowrap}
  .pill.added{background:rgba(99,198,143,.15);color:var(--added)}
  .pill.modified{background:rgba(229,176,75,.15);color:var(--modified)}
  .pill.deleted{background:rgba(224,101,82,.15);color:var(--deleted)}
  .pill.blast{background:rgba(91,141,239,.15);color:var(--consumed)}
  .pill.context{background:rgba(78,95,130,.25);color:var(--dim)}
  .pill.orphan{background:rgba(167,139,218,.15);color:var(--violet)}
  .pill.risk-high{background:rgba(224,101,82,.22);color:#F1937F}
  .pill.risk-med{background:rgba(229,176,75,.14);color:var(--modified)}
  .pill.risk-low{background:rgba(78,95,130,.25);color:var(--dim)}
  .facts{list-style:none;font-size:11.5px;color:#C9CDD9;line-height:1.7}
  .facts b{color:var(--paper);font-weight:500}
  .facts .faint{color:var(--faint)}
  .facts code{color:var(--dim)}
  .facts.members>li{border-top:1px solid var(--grid);padding:8px 0;line-height:1.5}
  .facts.members .reviewer-note{margin:8px 0 2px}
  .facts.members pre.diff{margin:8px 0 4px;font-size:10.5px}
  pre.diff{
    background:#0A0F1B;border:1px solid var(--grid);border-radius:8px;
    padding:10px 0;font-size:11px;line-height:1.7;overflow-x:auto;white-space:pre;
  }
  pre.diff .dl{display:block;padding-right:12px}
  pre.diff .dl i{
    display:inline-block;width:34px;padding-right:12px;text-align:right;
    color:var(--faint);font-style:normal;user-select:none;
  }
  pre.diff .a{color:var(--added)}
  pre.diff .d{color:var(--deleted)}
  pre.diff .c{color:var(--dim)}
  pre.diff .g{color:var(--faint);font-style:italic}
  .caption{font-size:9.5px;color:var(--faint);margin-top:6px;line-height:1.5}
  .empty{font-size:11px;color:var(--faint);font-family:var(--sans)}
  .dp-path{font-size:10.5px;color:var(--dim);word-break:break-all;flex:1;min-width:0}
  .dp-stat{font-size:10.5px;white-space:nowrap}
  .dp-stat .add{color:var(--added)} .dp-stat .del{color:var(--deleted)}

  /* judgment register — model voice, never mixed into computed metadata */
  .reviewer-note{border-left:2px solid var(--violet);padding-left:12px;margin:0 0 14px}
  .register-caption{
    display:block;font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;
    color:var(--violet);margin-bottom:5px;
  }
  .judgment-pills{
    display:flex;align-items:center;gap:8px;flex-wrap:wrap;
    border-left:2px solid var(--violet);padding-left:12px;margin:0 0 12px;
  }
  .judgment-pills .register-caption{margin-bottom:0}
  .note-entry{border-top:1px solid var(--grid);padding-top:10px;margin-top:10px}
  .note-entry:first-of-type{border-top:none;padding-top:0;margin-top:0}
  .note-target{
    all:unset;cursor:pointer;font-family:var(--mono);font-size:10.5px;color:var(--dim);
    display:block;margin-bottom:6px;
  }
  .note-target:hover,.note-target:focus-visible{color:var(--paper);text-decoration:underline}

  .flags{list-style:none;display:flex;flex-direction:column;gap:8px}
  .flags button{
    all:unset;display:flex;gap:10px;align-items:baseline;cursor:pointer;
    border:1px solid var(--grid);border-radius:8px;padding:9px 12px;width:100%;
    font-family:var(--mono);font-size:11.5px;color:#C9CDD9;line-height:1.45;
    transition:border-color .15s,background .15s;
  }
  .flags button:hover,.flags button:focus-visible{border-color:var(--faint);background:var(--panel2)}
  .flags .n{color:var(--modified);font-weight:600;flex:none}
  .flags .n.v{color:var(--violet)}
  .flags .ftext{min-width:0}
  .flag-facts{font-size:10px;margin-top:5px;word-break:break-all}
  .reading-order button{font-size:11px;color:var(--dim)}
  .back{all:unset;cursor:pointer;font-size:10.5px;color:var(--faint);margin-bottom:12px;display:inline-block;letter-spacing:.04em}
  .back:hover,.back:focus-visible{color:var(--paper)}
  .linkbtn{
    all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:6px;margin-top:12px;
    border:1px solid var(--grid);border-radius:7px;padding:7px 11px;
    font-family:var(--mono);font-size:11px;color:var(--dim);
  }
  .linkbtn:hover,.linkbtn:focus-visible{border-color:var(--faint);color:var(--paper)}
  .card-body{padding:0 16px 16px}
  .card-body>.lede{margin-bottom:14px}

  /* ── responsive: reflow, never a content cut ───────────────────────────*/
  @media (max-width:1100px){
    .shell{grid-template-columns:56px minmax(0,1fr) 400px}
    .brand{padding:0 18px;font-size:0;gap:0}
    .nav-item span:not(.ic){display:none}
    .nav-item{justify-content:center;padding:10px 0}
    .side-sec,.side-foot{display:none}
    .sidebar.open .side-sec,.sidebar.open .side-foot{display:block}
  }
  @media (max-width:900px){
    body{overflow:auto}
    .shell{grid-template-columns:56px minmax(0,1fr);grid-template-rows:56px auto auto}
    .topbar{grid-column:2/3}
    /* the page scrolls here, not the column — an inner scroller would hide the
       criteria table below the graph card instead of stacking it */
    .center{grid-row:2;grid-column:2;overflow:visible}
    .rightpanel{grid-row:3;grid-column:1/3;border-left:none;border-top:1px solid var(--grid)}
    svg#canvas{min-height:380px}
    .large-slice-warning{align-items:flex-start;flex-direction:column;gap:4px}
  }
</style>
</head>
<body>

<div class="shell" id="shell" data-view="graph">

  <aside class="sidebar">
    <div class="brand"><span class="mark" aria-hidden="true"></span>groundcheck</div>
    <div class="side-head" style="padding:14px 16px 4px">Review</div>
    <nav aria-label="Review views">
      ${navHtml}
    </nav>

    <div class="side-sec">
      <div class="side-head">Filters<button class="link" id="clear-filters">Clear all</button></div>
      <div class="group-label">Status</div>
      <div role="group" aria-label="Filter by status">
        ${statusFilterHtml}
      </div>
      <div class="group-label">Change type</div>
      <div role="group" aria-label="Filter by change type">
        ${edgeFilterHtml}
      </div>
    </div>

    <div class="side-sec tight">
      <div class="side-head">Focus</div>
      <label class="switch"><span>Show context nodes</span><input type="checkbox" id="focus-context" checked><span class="track" aria-hidden="true"></span></label>
      <label class="switch"><span>Show epicenter rings</span><input type="checkbox" id="focus-rings" checked><span class="track" aria-hidden="true"></span></label>
    </div>

    <div class="side-foot">
      <button class="save-view" id="save-view">${icon('save')}Save view</button>
    </div>
  </aside>

  <header class="topbar">
    <div class="crumbs">${breadcrumbHtml}</div>
    <span class="chip-t">${shaChip}</span>
    ${metricsHtml}
    <span class="spacer"></span>
    <label class="search-wrap">${icon('search')}<input id="search" type="search" placeholder="filter nodes" aria-label="Filter nodes by file or symbol"></label>
  </header>

  <main class="center">

    <section class="card" id="card-graph">
      <div class="card-head">
        <div class="grow">
          <h1>Dependency Graph</h1>
          <div class="sub">Visualize how changes in this PR impact your codebase</div>
        </div>
        <div class="toolbar">
          <button class="tbtn" id="fit-view">Fit view</button>
          <select id="zoom-level" aria-label="Zoom level">
            <option value="50">50%</option><option value="75">75%</option>
            <option value="100" selected>100%</option><option value="150">150%</option>
            <option value="200">200%</option><option value="400">400%</option><option value="800">800%</option>
          </select>
          <button class="tbtn ico" id="zoom-out" aria-label="Zoom out">${icon('zoomout')}</button>
          <button class="tbtn ico" id="zoom-in" aria-label="Zoom in">${icon('zoomin')}</button>
        </div>
      </div>
${largeSliceWarningHtml ? `      ${largeSliceWarningHtml}\n` : ''}      <div class="canvas-wrap">
        <svg id="canvas" viewBox="0 0 ${CANVAS.width} ${CANVAS.height}" data-layout-mode="${graphLayout.mode}" data-canvas-width="${CANVAS.width}" data-canvas-height="${CANVAS.height}" role="img" aria-label="Dependency slice of ${escapeHtml(slice.generated.range)}">
          <defs>
            <pattern id="dots" width="26" height="26" patternUnits="userSpaceOnUse">
              <circle cx="1.2" cy="1.2" r="1.2" fill="#1A2440"/>
            </pattern>
            <marker id="m-dim" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill="#2A3856"/>
            </marker>
            <marker id="m-hot" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill="#E9E6DC"/>
            </marker>
          </defs>
          <rect x="${-CANVAS.width}" y="${-CANVAS.height}" width="${CANVAS.width * 3}" height="${CANVAS.height * 3}" fill="url(#dots)"/>
          <g id="rings">
        ${ringsSvg}
          </g>
          <g id="edges">
        ${edgesSvg}
          </g>
          <g id="labels">
        ${riskLabelsSvg}
        ${orphanLabelsSvg}
          </g>
          <g id="nodes">
        ${nodesSvg}
          </g>
        </svg>
        <div class="legend" aria-hidden="true">
          <span class="k"><span class="dot" style="background:var(--added)"></span>Added</span>
          <span class="k"><span class="lseg"></span>Renders / Calls</span>
          <span class="k"><span class="dot" style="background:var(--modified)"></span>Modified</span>
          <span class="k"><span class="lseg dots"></span>Uses token</span>
          <span class="k"><span class="dot" style="background:var(--consumed)"></span>Consumed (low risk)</span>
          <span class="k"><span class="lseg thin"></span>Imports</span>
          <span class="k"><span class="dot" style="background:var(--violet)"></span>Orphan / Unused</span>
          <span class="k"><span class="lseg dash" style="border-color:var(--consumed)"></span>Consumes type</span>
          <span class="cap">risk and orphan labels are model judgment</span>
        </div>
      </div>
    </section>

    <section class="card" id="card-criteria">
      <div class="card-head">
        <div class="grow">
          <h2>Intent &amp; Acceptance Criteria</h2>
          <span class="register-caption" style="margin-top:5px">model-matched</span>
        </div>
        ${progressHtml}
        <button class="tbtn" id="crit-collapse">${icon('chevron')}Collapse</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>ID</th><th>Description</th><th>Status</th></tr></thead>
          <tbody>
          ${criteriaRowsHtml}
          </tbody>
        </table>
      </div>
    </section>

    <section class="card" id="card-overview">
      <div class="card-head"><div class="grow"><h2>Slice overview</h2></div></div>
      <div class="card-body">
        ${ledeHtml}
        ${flags.length ? `<h3>attention flags · ${flags.length}</h3><span class="register-caption">model judgment</span><ul class="flags">\n          ${flagsListHtml}\n          </ul>` : ''}
        ${readingOrderHtml ? `<h3>suggested reading order</h3><ul class="flags reading-order">\n          ${readingOrderHtml}\n          </ul>` : ''}
        <p class="caption">Facts (nodes, edges, statuses, spans, ungraphed changed files) come from <code>slice.json</code>; flags, notes, risk and ordering are model judgment from <code>annotations.json</code>. tsconfig: <code>${escapeHtml(slice.generated.tsconfig)}</code> · slice format <code>${escapeHtml(slice.groundcheck)}</code>.</p>
      </div>
    </section>

    <section class="card" id="card-files">
      <div class="card-head"><div class="grow"><h2>Files in this slice</h2><div class="sub">${slice.nodes.length} nodes drawn · ${ungraphed.length} changed files not graphed · ${slice.hidden.count} context nodes hidden${excludedCount ? ` · ${excludedCount} changed files outside the TS project` : ''}</div></div></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Path</th><th>Kind</th><th>Status</th><th>Diff</th><th>Changed lines</th></tr></thead>
          <tbody>
          ${filesRowsHtml}
          </tbody>
        </table>
      </div>
    </section>

    <section class="card" id="card-flags">
      <div class="card-head"><div class="grow"><h2>Attention flags${flags.length ? ` · ${flags.length}` : ''}</h2><span class="register-caption" style="margin-top:5px">model judgment</span></div></div>
      <div class="card-body">
        ${flags.length ? `<ul class="flags">\n          ${flagsFullHtml}\n          </ul>` : '<p class="empty">no attention flags in this slice</p>'}
      </div>
    </section>

  </main>

  <aside class="rightpanel" id="right" data-tab="summary">
    <div class="tabs" role="tablist" aria-label="Detail panel">
      <button class="tab active" data-tab="summary" role="tab" aria-selected="true">Summary</button>
      <button class="tab" data-tab="diff" role="tab" aria-selected="false">Diff</button>
      <button class="tab" data-tab="notes" role="tab" aria-selected="false">Notes${noteCount ? `<span class="count">${noteCount}</span>` : ''}</button>
    </div>

    <div class="tab-body" id="tab-summary" role="tabpanel" aria-live="polite">
      <div class="card">
        <h2>PR Summary</h2>
        <div id="summary-body">
          ${ledeHtml}
        </div>
      </div>
      <div class="card">
        <h2>Attention Flags${flags.length ? `<span class="count">${flags.length}</span>` : ''}</h2>
        <span class="register-caption">model judgment</span>
        ${flags.length ? `<ul class="flags">\n          ${flagsListHtml}\n        </ul>` : '<p class="empty">no attention flags in this slice</p>'}
        <button class="linkbtn" id="view-all-flags">View all flags →</button>
      </div>
      <div class="card">
        <h2>Diff Preview</h2>
        <div class="card-head" id="diff-preview-head"></div>
        <div id="diff-preview"></div>
        <button class="linkbtn" id="open-diff-tab">Open file in diff view →</button>
      </div>
    </div>

    <div class="tab-body" id="tab-diff-body" role="tabpanel"></div>
    <div class="tab-body" id="tab-notes-body" role="tabpanel"></div>
  </aside>

</div>

<script type="application/json" id="gc-slice">${sliceText}</script>
<script type="application/json" id="gc-annotations">${annotationsText}</script>
<script>
${artifactScript}
</script>
</body>
</html>
`

writeFileSync(values.out, html)
console.error(
  `render-slice: ${slice.nodes.length} nodes, ${slice.edges.length} edges, ${criteria.length} criteria, ${flags.length} flags, ${graphLayout.mode} layout ${CANVAS.width}x${CANVAS.height} → ${values.out}` +
    (largeSliceReasons.length ? `\nrender-slice: warning — large review slice (${largeSliceReasons.join(', ')}); dense graphs may be harder to read` : ''),
)
