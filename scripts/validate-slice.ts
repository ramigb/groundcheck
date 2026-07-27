// validate-slice.ts — refuses to let an artifact lie about the slice.
// Usage:
//   node scripts/validate-slice.ts --artifact review.html --slice slice.json [--annotations annotations.json]
//
// Prints one JSON object per violation on stdout (machine-readable), a one-line
// summary on stderr. Exit 0 clean · 1 violations found · 2 usage/IO error.
//
// The artifact is our own generated markup, so it is scanned with regexes over
// the raw bytes rather than a DOM: no dependency, and byte-level checks (check 1)
// need the raw text anyway.
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import {
  LARGE_FILE_WARNING_THRESHOLD,
  MANUAL_LAYOUT_THRESHOLD,
  NODE_BOX,
  resolveGraphLayout,
} from './layout-slice.ts'

const NODE = NODE_BOX
const MARGIN = 14
const MIN_GAP = 24
const MAX_FLAGS = 5
const EPICENTER_WINDOW = { x: [380, 500], y: [260, 340] }
const MIN_EPICENTER_SEPARATION = 200

// DESIGN_CONTRACT v0.4.0 § Palette. `blast` was retired in v0.2.0: blast nodes render in
// `consumed` and `deleted` owns the red, so a surviving `--blast` is a defect.
const PALETTE_TOKENS = [
  'ink', 'panel', 'panel2', 'grid', 'line', 'paper', 'dim', 'faint',
  'added', 'modified', 'deleted', 'consumed', 'ring', 'context', 'violet',
]
const RETIRED_PALETTE_TOKENS = ['blast']
const CHANGED_STATUSES = ['added', 'modified', 'deleted']

type Violation = { check: string; where: string; detail: string }
const violations: Violation[] = []
const violation = (check: string, where: string, detail: string) => violations.push({ check, where, detail })

function usage(message: string): never {
  console.error(`validate-slice: ${message}`)
  process.exit(2)
}

const { values } = parseArgs({
  options: { artifact: { type: 'string' }, slice: { type: 'string' }, annotations: { type: 'string' } },
  allowPositionals: false,
})
if (!values.artifact) usage('missing --artifact review.html')
if (!values.slice) usage('missing --slice slice.json')

let artifact: string
let sliceText: string
try {
  artifact = readFileSync(values.artifact, 'utf8')
  sliceText = readFileSync(values.slice, 'utf8')
} catch (error) {
  usage(error instanceof Error ? error.message : String(error))
}

/** Criterion text is HTML-escaped by the renderer; compare like for like. */
const escapeForCompare = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function embeddedBlock(id: string): string | undefined {
  const match = new RegExp(`<script type="application/json" id="${id}">([\\s\\S]*?)</script>`).exec(artifact)
  return match?.[1]
}

// ── 1. embedded slice is byte-equal to the input slice ────────────────────
const embeddedSlice = embeddedBlock('gc-slice')
if (embeddedSlice === undefined) violation('embedded-slice', 'gc-slice', 'no <script type="application/json" id="gc-slice"> block')
else if (embeddedSlice !== sliceText)
  violation('embedded-slice', 'gc-slice', `embedded slice differs from ${values.slice} (${embeddedSlice.length} vs ${sliceText.length} bytes)`)

const embeddedAnnotations = embeddedBlock('gc-annotations')
if (embeddedAnnotations === undefined) violation('embedded-annotations', 'gc-annotations', 'no embedded annotations block')
if (values.annotations && embeddedAnnotations !== undefined) {
  const onDisk = readFileSync(values.annotations, 'utf8')
  if (onDisk !== embeddedAnnotations)
    violation('embedded-annotations', 'gc-annotations', `embedded annotations differ from ${values.annotations}`)
}

let slice: any
try {
  slice = JSON.parse(sliceText)
} catch (error) {
  usage(`--slice is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
}
let annotations: any = {}
if (embeddedAnnotations !== undefined) {
  try {
    annotations = JSON.parse(embeddedAnnotations)
  } catch (error) {
    violation('embedded-annotations', 'gc-annotations', `embedded annotations are not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// ── rendered data ─────────────────────────────────────────────────────────
const attribute = (tag: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1]
const decodeAttribute = (value: string) =>
  value.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')

const renderedNodes = [...artifact.matchAll(/<g class="node ([^"]*)"[^>]*>/g)].map((match) => {
  const tag = match[0]
  return {
    classes: match[1].split(/\s+/).filter(Boolean),
    id: attribute(tag, 'data-id') ?? '',
    status: attribute(tag, 'data-status') ?? '',
    kind: attribute(tag, 'data-kind') ?? '',
    x: Number(attribute(tag, 'data-x')),
    y: Number(attribute(tag, 'data-y')),
    transform: attribute(tag, 'transform') ?? '',
  }
})
const renderedEdges = [...artifact.matchAll(/<line class="edge ([^"]*)"[^>]*>/g)].map((match) => {
  const tag = match[0]
  return {
    from: attribute(tag, 'data-from') ?? '',
    to: attribute(tag, 'data-to') ?? '',
    type: attribute(tag, 'data-type') ?? '',
  }
})
const renderedUngraphed = [...artifact.matchAll(/<tr class="file-row ungraphed"[^>]*>/g)].map((match) => {
  const tag = match[0]
  return {
    file: decodeAttribute(attribute(tag, 'data-file') ?? ''),
    status: attribute(tag, 'data-status') ?? '',
  }
})

// ── 2. node/edge parity with the slice ────────────────────────────────────
const sliceNodes: any[] = slice.nodes ?? []
const sliceNodeById = new Map(sliceNodes.map((node) => [node.id, node]))
const renderedById = new Map(renderedNodes.map((node) => [node.id, node]))

// `--collapse dir` meta-nodes carry their members. Members are not drawn, but
// they are addressable by judgment (notes, risk, orphans) so collapsing a
// monorepo does not erase symbol-level review.
const memberById = new Map<string, any>()
const parentOfMember = new Map<string, string>()
for (const node of sliceNodes) {
  for (const member of node.members ?? []) {
    memberById.set(member.id, member)
    parentOfMember.set(member.id, node.id)
  }
}
const addressable = (id: string) => sliceNodeById.has(id) || memberById.has(id)

for (const node of sliceNodes) {
  const rendered = renderedById.get(node.id)
  if (!rendered) {
    violation('node-missing', node.id, 'slice node is not present in the artifact')
    continue
  }
  if (rendered.status !== node.status)
    violation('node-status', node.id, `rendered status "${rendered.status}" != slice status "${node.status}"`)
  if (!rendered.classes.includes(node.status))
    violation('node-status', node.id, `node styling does not carry the "${node.status}" class (classes: ${rendered.classes.join(' ')})`)
  if (rendered.kind !== node.kind) violation('node-kind', node.id, `rendered kind "${rendered.kind}" != slice kind "${node.kind}"`)
}
for (const rendered of renderedNodes) {
  if (!sliceNodeById.has(rendered.id)) violation('node-fabricated', rendered.id, 'artifact renders a node that is not in the slice')
}
if (renderedNodes.length !== new Set(renderedNodes.map((n) => n.id)).size)
  violation('node-duplicate', 'nodes', 'the same node id is rendered more than once')

const sliceUngraphed: any[] = slice.ungraphed ?? []
const renderedUngraphedByFile = new Map(renderedUngraphed.map((file) => [file.file, file]))
for (const file of sliceUngraphed) {
  const rendered = renderedUngraphedByFile.get(file.file)
  if (!rendered) {
    violation('ungraphed-missing', file.file, 'ungraphed changed file is absent from the Files view')
    continue
  }
  if (rendered.status !== file.status)
    violation('ungraphed-status', file.file, `rendered status "${rendered.status}" != slice status "${file.status}"`)
}
const sliceUngraphedPaths = new Set(sliceUngraphed.map((file) => file.file))
for (const rendered of renderedUngraphed) {
  if (!sliceUngraphedPaths.has(rendered.file))
    violation('ungraphed-fabricated', rendered.file, 'Files view renders an ungraphed file absent from the slice')
}
if (renderedUngraphed.length !== new Set(renderedUngraphed.map((file) => file.file)).size)
  violation('ungraphed-duplicate', 'ungraphed', 'the same ungraphed file is rendered more than once')

const edgeKey = (edge: { from: string; to: string; type: string }) => `${edge.from} -> ${edge.to} (${edge.type})`
const sliceEdgeKeys = new Set((slice.edges ?? []).map(edgeKey))
const renderedEdgeKeys = new Set(renderedEdges.map(edgeKey))
for (const key of sliceEdgeKeys) if (!renderedEdgeKeys.has(key)) violation('edge-missing', key, 'slice edge is not present in the artifact')
for (const key of renderedEdgeKeys) if (!sliceEdgeKeys.has(key)) violation('edge-fabricated', key, 'artifact renders an edge that is not in the slice')

// ── 3. annotation integrity ───────────────────────────────────────────────
const changedIds = new Set(sliceNodes.filter((node) => CHANGED_STATUSES.includes(node.status)).map((node) => node.id))
const criteria: any[] = annotations.criteria ?? []
const criterionIds = new Set(criteria.map((criterion) => criterion.id))

if (annotations.for?.headSha !== slice.generated?.headSha)
  violation('annotations-for', 'for.headSha', `annotations target "${annotations.for?.headSha}" but slice is "${slice.generated?.headSha}"`)
if (annotations.for?.range && annotations.for.range !== slice.generated?.range)
  violation('annotations-for', 'for.range', `annotations target "${annotations.for.range}" but slice is "${slice.generated?.range}"`)

// Judgment may address a drawn node or a collapsed member...
for (const [where, ids] of [
  ['orphans', annotations.orphans ?? []],
  ['readingOrder', annotations.readingOrder ?? []],
  ['notes', Object.keys(annotations.notes ?? {})],
  ['risk', Object.keys(annotations.risk ?? {})],
] as [string, string[]][]) {
  for (const id of ids) if (!addressable(id)) violation('annotation-dangling', where, `references unknown node "${id}"`)
}
// ...but layout and criteria matching must name drawn nodes: one positions a
// rect, the other drives chip isolation, and neither can act on a member.
for (const [where, ids] of [
  ...(sliceNodes.length <= MANUAL_LAYOUT_THRESHOLD ? [['layout', Object.keys(annotations.layout ?? {})] as [string, string[]]] : []),
  ...criteria.map((criterion, index): [string, string[]] => [`criteria[${index}].nodes`, criterion.nodes ?? []]),
] as [string, string[]][]) {
  for (const id of ids) {
    if (sliceNodeById.has(id)) continue
    violation(
      'annotation-dangling',
      where,
      memberById.has(id)
        ? `references collapsed member "${id}"; use its drawn node "${parentOfMember.get(id)}"`
        : `references unknown node "${id}"`,
    )
  }
}
for (const [index, flag] of (annotations.flags ?? []).entries()) {
  if (flag.target?.node && !sliceNodeById.has(flag.target.node))
    violation('annotation-dangling', `flags[${index}]`, `references unknown node "${flag.target.node}"`)
  if (flag.target?.criterion && !criterionIds.has(flag.target.criterion))
    violation('annotation-dangling', `flags[${index}]`, `references unknown criterion "${flag.target.criterion}"`)
  if (!flag.target?.node && !flag.target?.criterion) violation('annotation-flag', `flags[${index}]`, 'flag has no target')
}
if ((annotations.flags ?? []).length > MAX_FLAGS)
  violation('annotation-flags', 'flags', `${annotations.flags.length} flags exceeds the cap of ${MAX_FLAGS}`)
const declaredOrphans: string[] = annotations.orphans ?? []
for (const id of declaredOrphans) {
  const node = sliceNodeById.get(id) ?? memberById.get(id)
  if (node && !CHANGED_STATUSES.includes(node.status))
    violation('annotation-orphan', id, `orphan is not a changed node (status "${node.status}")`)
}
// SKILL.md defines an orphan as a changed node mapped to no criterion, so the
// set is derivable: an omitted orphan is a violation, not a judgment call. This
// is stricter than SLICE_FORMAT's "orphans ⊆ changed nodes" on purpose — it is
// what stops "present this favorably" from quietly dropping the ⚠ chip.
if (criteria.length) {
  const mapped = new Set<string>(criteria.flatMap((criterion) => criterion.nodes ?? []))
  // A collapsed node is accounted for if it, or any member, is mapped or
  // declared an orphan — so a mixed directory can name the one stray symbol.
  const orphanSet = new Set(declaredOrphans)
  const accountsFor = (id: string) => {
    if (mapped.has(id) || orphanSet.has(id)) return true
    const node = sliceNodeById.get(id)
    return (node?.members ?? []).some((member: any) => mapped.has(member.id) || orphanSet.has(member.id))
  }
  for (const id of changedIds) {
    if (!accountsFor(id)) violation('annotation-orphan-missing', id, 'changed node is mapped to no criterion and not declared an orphan')
  }
  for (const id of declaredOrphans) {
    if (mapped.has(id)) violation('annotation-orphan-extra', id, 'declared an orphan while also mapped to a criterion')
  }
} else if (declaredOrphans.length) {
  violation('annotation-orphan', 'orphans', 'orphans declared without a criteria source (orphan detection requires criteria)')
}
for (const criterion of criteria) {
  if (!['covered', 'uncovered'].includes(criterion.status))
    violation('annotation-criterion', criterion.id ?? '?', `status must be covered|uncovered (got "${criterion.status}")`)
  if (criterion.source === 'inferred') violation('annotation-criterion', criterion.id ?? '?', 'criteria may not be "inferred"')
}
for (const [id, level] of Object.entries(annotations.risk ?? {})) {
  if (!['high', 'med', 'low'].includes(level as string)) violation('annotation-risk', id, `risk must be high|med|low (got "${level}")`)
}

// ── 4. layout geometry, on the rendered positions ─────────────────────────
const annotatedLayout: Record<string, { x: number; y: number }> = annotations.layout ?? {}
const graphLayout = resolveGraphLayout(sliceNodes, slice.edges ?? [], slice.epicenters ?? [], annotatedLayout)
const expectedLayout = graphLayout.positions
const CANVAS = graphLayout.canvas
const canvasTag = /<svg id="canvas"[^>]*>/.exec(artifact)?.[0]
if (!canvasTag) {
  violation('layout-canvas', 'canvas', 'graph SVG is missing')
} else {
  const mode = attribute(canvasTag, 'data-layout-mode')
  const width = Number(attribute(canvasTag, 'data-canvas-width'))
  const height = Number(attribute(canvasTag, 'data-canvas-height'))
  const viewBox = attribute(canvasTag, 'viewBox')
  if (mode !== graphLayout.mode) violation('layout-canvas', 'canvas', `layout mode "${mode}" != expected "${graphLayout.mode}"`)
  if (width !== CANVAS.width || height !== CANVAS.height)
    violation('layout-canvas', 'canvas', `canvas ${width}x${height} != expected ${CANVAS.width}x${CANVAS.height}`)
  if (viewBox !== `0 0 ${CANVAS.width} ${CANVAS.height}`)
    violation('layout-canvas', 'canvas', `viewBox "${viewBox}" != expected "0 0 ${CANVAS.width} ${CANVAS.height}"`)
}

if (graphLayout.mode === 'manual') {
  for (const id of Object.keys(annotatedLayout)) {
    if (!renderedById.has(id) && sliceNodeById.has(id)) violation('layout-unused', id, 'layout entry for a node that is not rendered')
  }
}
for (const node of renderedNodes) {
  const expected = expectedLayout[node.id]
  if (!expected) {
    violation(
      'layout-missing',
      node.id,
      graphLayout.mode === 'manual' ? 'rendered node has no annotations.layout entry' : 'automatic layout produced no position',
    )
    continue
  }
  if (expected.x !== node.x || expected.y !== node.y)
    violation(
      'layout-drift',
      node.id,
      `rendered at (${node.x}, ${node.y}) but ${graphLayout.mode} layout expects (${expected.x}, ${expected.y})`,
    )
  const expectedTransform = `translate(${expected.x - NODE.width / 2},${expected.y - NODE.height / 2})`
  if (node.transform !== expectedTransform)
    violation('layout-drift', node.id, `transform "${node.transform}" does not match layout position (expected "${expectedTransform}")`)
}

const rect = (node: { x: number; y: number }) => ({
  left: node.x - NODE.width / 2,
  right: node.x + NODE.width / 2,
  top: node.y - NODE.height / 2,
  bottom: node.y + NODE.height / 2,
})
for (const node of renderedNodes) {
  const box = rect(node)
  if (box.left < MARGIN || box.top < MARGIN || box.right > CANVAS.width - MARGIN || box.bottom > CANVAS.height - MARGIN)
    violation('layout-bounds', node.id, `rect (${box.left},${box.top})-(${box.right},${box.bottom}) breaks the ${MARGIN}px canvas margin`)
}
// Sweep left-to-right. Once the horizontal gap reaches MIN_GAP, every later
// rect is also safe from `a`; this keeps large-slice validation close to O(n)
// for the deterministic grid instead of comparing every possible pair.
const placedRects = renderedNodes
  .map((node) => ({ node, box: rect(node) }))
  .sort((a, b) => a.box.left - b.box.left || a.box.top - b.box.top || (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0))
for (let i = 0; i < placedRects.length; i++) {
  for (let j = i + 1; j < placedRects.length; j++) {
    const a = placedRects[i].box
    const b = placedRects[j].box
    if (b.left - a.right >= MIN_GAP) break
    const gapX = Math.max(a.left - b.right, b.left - a.right)
    const gapY = Math.max(a.top - b.bottom, b.top - a.bottom)
    const gap = Math.max(gapX, gapY)
    const pair = `${placedRects[i].node.id} / ${placedRects[j].node.id}`
    if (gapX < 0 && gapY < 0) violation('layout-overlap', pair, `node rects overlap by ${Math.abs(Math.max(gapX, gapY))}px`)
    else if (gap < MIN_GAP) violation('layout-gap', pair, `edge-to-edge gap ${gap}px is under the ${MIN_GAP}px minimum`)
  }
}

const epicenters: string[] = slice.epicenters ?? []
const placedEpicenters = epicenters.filter((id) => renderedById.has(id))
if (placedEpicenters.length && graphLayout.mode === 'manual') {
  const primary = renderedById.get(placedEpicenters[0])!
  const inWindow =
    primary.x >= EPICENTER_WINDOW.x[0] && primary.x <= EPICENTER_WINDOW.x[1] && primary.y >= EPICENTER_WINDOW.y[0] && primary.y <= EPICENTER_WINDOW.y[1]
  if (!inWindow)
    violation(
      'layout-epicenter',
      primary.id,
      `epicenter at (${primary.x}, ${primary.y}) is outside x[${EPICENTER_WINDOW.x.join('–')}] y[${EPICENTER_WINDOW.y.join('–')}]`,
    )
  for (let i = 1; i < placedEpicenters.length; i++) {
    const other = renderedById.get(placedEpicenters[i])!
    const distance = Math.hypot(other.x - primary.x, other.y - primary.y)
    if (distance < MIN_EPICENTER_SEPARATION)
      violation('layout-epicenter', other.id, `secondary epicenter is ${Math.round(distance)}px from the primary, under ${MIN_EPICENTER_SEPARATION}px`)
  }
}
const ringCount = (artifact.match(/class="ring r\d"/g) ?? []).length
if (placedEpicenters.length && ringCount !== 3 * placedEpicenters.length)
  violation('design-rings', 'rings', `${ringCount} ring circles for ${placedEpicenters.length} epicenter(s); expected ${3 * placedEpicenters.length}`)
const changedFileCount = new Set([
  ...sliceNodes.flatMap((node) => node.members ?? [node]).filter((node) => CHANGED_STATUSES.includes(node.status)).map((node) => node.file),
  ...(slice.ungraphed ?? []).map((file: any) => file.file),
]).size
const needsLargeSliceWarning = sliceNodes.length > MANUAL_LAYOUT_THRESHOLD || changedFileCount > LARGE_FILE_WARNING_THRESHOLD
if (needsLargeSliceWarning && !/class="large-slice-warning"/.test(artifact))
  violation('design-large-slice', 'warning', 'large slice warning is missing')

// ── 5. design spot-checks ─────────────────────────────────────────────────
for (const token of PALETTE_TOKENS) {
  if (!new RegExp(`--${token}\\s*:`).test(artifact)) violation('design-palette', `--${token}`, 'palette token missing from CSS custom properties')
}
for (const token of RETIRED_PALETTE_TOKENS) {
  if (new RegExp(`--${token}\\s*:`).test(artifact))
    violation('design-palette', `--${token}`, `retired palette token still defined; DESIGN_CONTRACT v0.2.0 removed it`)
}
const spotChecks: [string, RegExp, string][] = [
  ['design-reduced-motion', /@media \(prefers-reduced-motion:\s*reduce\)/, 'prefers-reduced-motion rule missing'],
  ['design-ring-style', /\.ring\{[^}]*stroke-dasharray:3 6/, 'epicenter ring style missing'],
  ['design-register', /\.reviewer-note\{[^}]*border-left:2px solid var\(--violet\)/, 'reviewer-note judgment register (violet left border) missing'],
  ['design-register', /class="register-caption"/, 'register caption element missing'],
  ['design-markers', /id="m-hot"/, 'hot arrowhead marker missing'],
  // § Shell geometry: the four regions and the five views must all exist.
  ['design-shell', /class="shell" id="shell"/, 'app shell root missing'],
  ['design-shell', /class="sidebar"/, 'sidebar region missing'],
  ['design-shell', /class="topbar"/, 'topbar region missing'],
  ['design-shell', /class="center"/, 'center region missing'],
  ['design-shell', /class="rightpanel"/, 'right panel region missing'],
  ['design-tabs', /id="tab-summary"/, 'Summary tab missing'],
  ['design-tabs', /id="tab-diff-body"/, 'Diff tab missing'],
  ['design-tabs', /id="tab-notes-body"/, 'Notes tab missing'],
  // § Sidebar / § Center: the controls the contract names.
  ['design-filters', /input[^>]*data-status="blast"/, 'the "Consumed (low risk)" status filter is missing'],
  ['design-filters', /input[^>]*data-status="orphan"/, 'the "Orphan / Unused" status filter is missing'],
  ['design-filters', /id="focus-rings"/, 'the epicenter-rings focus toggle is missing'],
  ['design-filters', /id="focus-context"/, 'the context-nodes focus toggle is missing'],
  ['design-toolbar', /id="fit-view"/, 'Fit view control missing'],
  ['design-toolbar', /id="zoom-level"/, 'zoom readout missing'],
  // § Node anatomy: focus ring, and the fade-not-remove mechanism (below).
  ['design-focus', /\.node:focus-visible rect\.body/, 'keyboard focus-visible style missing'],
]
for (const [check, pattern, detail] of spotChecks) if (!pattern.test(artifact)) violation(check, 'artifact', detail)

// Every nav item the contract lists must exist, and exactly one must be current.
for (const view of ['overview', 'files', 'graph', 'criteria', 'flags']) {
  if (!new RegExp(`class="nav-item[^"]*" data-view="${view}"`).test(artifact))
    violation('design-shell', view, 'nav item missing from the sidebar')
}
const currentNav = (artifact.match(/aria-current="page"/g) ?? []).length
if (currentNav !== 1) violation('design-shell', 'nav', `${currentNav} nav items marked aria-current, expected exactly 1`)

/**
 * DESIGN_CONTRACT § Signature elements, "filtered means faded": no control may
 * remove a node from the document. The count checks above cannot see this — a
 * renderer that hid nodes with `display:none` would still emit all of them — so
 * the mechanism itself is asserted: the class every filter toggles must resolve
 * to opacity and must not carry display or visibility.
 */
const filteredRule = /\.node\.filtered\{([^}]*)\}/.exec(artifact)
if (!filteredRule) violation('design-fade', 'artifact', 'no .node.filtered rule; the fade-not-remove mechanism is missing')
else {
  if (!/opacity:/.test(filteredRule[1]))
    violation('design-fade', '.node.filtered', 'filter class does not set opacity')
  if (/display:|visibility:/.test(filteredRule[1]))
    violation('design-fade', '.node.filtered', 'filter class removes the node from the layout; the contract requires a fade')
}
if (/\.node\[data-status[^{]*\{[^}]*display:\s*none/.test(artifact))
  violation('design-fade', 'artifact', 'a status selector hides nodes with display:none')

// Diff excerpts: the panel block is required when the slice carries excerpts,
// and it must be built from the embedded block — a literal <pre class="diff"> in
// the markup would be diff text the byte-equality check never saw.
const nodesWithExcerpt = [...sliceNodes, ...memberById.values(), ...sliceUngraphed].filter((node) => node.excerpt?.length)
if (nodesWithExcerpt.length) {
  if (!/pre\.diff\{[^}]*background:#0A0F1B/.test(artifact))
    violation('design-diff', 'artifact', 'slice carries diff excerpts but the contract diff block style is missing')
  // Scripts stripped: what is left is markup the browser renders as-is.
  const staticMarkup = artifact.replace(/<script[\s\S]*?<\/script>/g, '')
  if (/<pre class="diff">/.test(staticMarkup))
    violation('design-diff', 'artifact', 'artifact contains static diff markup; excerpts must be built from the embedded slice')
  const excerptLines = nodesWithExcerpt.flatMap((node: any) => node.excerpt.filter((line: any) => line.op !== 'gap'))
  if (excerptLines.length > 8 * nodesWithExcerpt.length)
    violation('design-diff', 'artifact', 'a node exceeds the 8-line excerpt cap in DESIGN_CONTRACT § Panel structure')
}

/**
 * § Center: criteria section. Every criterion gets a table row, and the rendered
 * Status must agree with `annotations.json` — a row that reads Passed over an
 * `uncovered` criterion is the artifact lying about the judgment it carries.
 */
const CRITERION_STATUS_LABEL: Record<string, string> = { covered: 'Passed', uncovered: 'Failed' }
if (criteria.length) {
  if (!/model-matched/.test(artifact)) violation('design-register', 'artifact', 'criteria present but no "model-matched" caption')
  for (const criterion of criteria) {
    const row = new RegExp(`<tr class="crit-row ([^"]*)" data-id="${criterion.id}"[\\s\\S]*?</tr>`).exec(artifact)
    if (!row) {
      violation('design-criteria', criterion.id, 'criterion has no row in the criteria table')
      continue
    }
    const expected = CRITERION_STATUS_LABEL[criterion.status]
    const rendered = /<td class="c-status">([^<]*)<\/td>/.exec(row[0])?.[1]?.trim()
    if (expected && rendered !== expected)
      violation('design-criteria', criterion.id, `row reads "${rendered}" but annotations say "${criterion.status}" (expected "${expected}")`)
    if (!row[0].includes(escapeForCompare(criterion.text)))
      violation('design-criteria', criterion.id, 'row description does not carry the criterion text from annotations')
  }
  const renderedRows = (artifact.match(/<tr class="crit-row (?!muted)/g) ?? []).length
  const expectedRows = criteria.length + (annotations.orphans ?? []).length
  if (renderedRows !== expectedRows)
    violation('design-criteria', 'table', `${renderedRows} criteria rows rendered, annotations imply ${expectedRows}`)
  const ring = /aria-label="(\d+) of (\d+) criteria passed"/.exec(artifact)
  const passed = criteria.filter((criterion: any) => criterion.status === 'covered').length
  if (!ring) violation('design-criteria', 'progress', 'criteria present but the progress ring is missing')
  else if (Number(ring[1]) !== passed || Number(ring[2]) !== criteria.length)
    violation('design-criteria', 'progress', `ring says ${ring[1]}/${ring[2]}, annotations say ${passed}/${criteria.length}`)
} else if (!/no criteria provided — intent layer inactive/.test(artifact)) {
  violation('design-criteria', 'artifact', 'no criteria source, but the muted fallback row is missing')
}

/**
 * § Topbar. The `In graph` / `Not shown` metric cards are the relocated
 * hidden-nodes honesty badge, so they are mandatory even at zero and must agree
 * with the slice. A metric card that disagrees is the artifact understating what
 * it left out.
 */
const metric = (id: string) => new RegExp(`id="${id}">(\\d+)<`).exec(artifact)?.[1]
const graphFacts = sliceNodes.flatMap((node) => node.members ?? [node])
const changedGraphFacts = graphFacts.filter((node) => CHANGED_STATUSES.includes(node.status))
const changedFileStats = new Map<string, { added: number; removed: number }>()
for (const node of changedGraphFacts) changedFileStats.set(node.file, node.stats)
for (const file of sliceUngraphed) changedFileStats.set(file.file, file.stats)
const expectedChangedFiles = changedFileStats.size
const expectedAdded = [...changedFileStats.values()].reduce((sum, stats) => sum + stats.added, 0)
const expectedRemoved = [...changedFileStats.values()].reduce((sum, stats) => sum + stats.removed, 0)
const filesCount = metric('m-files')
if (filesCount === undefined) violation('design-metrics', 'm-files', 'the "Files changed" metric card is missing')
else if (Number(filesCount) !== expectedChangedFiles)
  violation('design-metrics', 'm-files', `card says ${filesCount} files, slice has ${expectedChangedFiles}`)
const addedCount = /id="m-added">\+(\d+)</.exec(artifact)?.[1]
if (addedCount === undefined) violation('design-metrics', 'm-added', 'the "Additions" metric card is missing')
else if (Number(addedCount) !== expectedAdded)
  violation('design-metrics', 'm-added', `card says ${addedCount} additions, slice has ${expectedAdded}`)
const removedCount = /id="m-removed">-(\d+)</.exec(artifact)?.[1]
if (removedCount === undefined) violation('design-metrics', 'm-removed', 'the "Deletions" metric card is missing')
else if (Number(removedCount) !== expectedRemoved)
  violation('design-metrics', 'm-removed', `card says ${removedCount} deletions, slice has ${expectedRemoved}`)
const drawnCount = metric('m-nodes')
if (drawnCount === undefined) violation('design-metrics', 'm-nodes', 'the "In graph" metric card is missing')
else if (Number(drawnCount) !== sliceNodes.length)
  violation('design-metrics', 'm-nodes', `card says ${drawnCount} nodes, slice has ${sliceNodes.length}`)
const hiddenCount = metric('m-hidden')
if (hiddenCount === undefined) violation('design-metrics', 'm-hidden', 'the "Not shown" honesty card is missing')
else if (Number(hiddenCount) !== (slice.hidden?.count ?? 0))
  violation('design-metrics', 'm-hidden', `card says ${hiddenCount} hidden, slice says ${slice.hidden?.count}`)
if (!/>Not shown</.test(artifact)) violation('design-metrics', 'm-hidden', 'the "Not shown" label is missing or reworded')

// Changed TypeScript files the project did not cover are listed as ungraphed,
// but the missing dependency analysis still needs an explicit honesty card.
const excludedCount: number = slice.excluded?.count ?? 0
const cardExcluded = /<span class="mval del">(\d+)<\/span><span class="mlabel">outside the TS project</.exec(artifact)
if (excludedCount > 0 && !cardExcluded)
  violation('design-metrics', 'excluded', `slice excludes ${excludedCount} changed file(s) but no card says so`)
if (cardExcluded && Number(cardExcluded[1]) !== excludedCount)
  violation('design-metrics', 'excluded', `card says ${cardExcluded[1]} excluded, slice says ${excludedCount}`)
if ((slice.excluded?.files ?? []).length !== excludedCount)
  violation('excluded', 'excluded', `${(slice.excluded?.files ?? []).length} files listed, count says ${excludedCount}`)

// ── report ────────────────────────────────────────────────────────────────
for (const item of violations) console.log(JSON.stringify(item))
if (violations.length) {
  console.error(`validate-slice: ${violations.length} violation(s) in ${values.artifact}`)
  process.exit(1)
}
console.error(
  `validate-slice: ok — ${sliceNodes.length} nodes, ${(slice.edges ?? []).length} edges, ${criteria.length} criteria, ${(annotations.flags ?? []).length} flags`,
)
