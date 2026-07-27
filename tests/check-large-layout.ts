// End-to-end regression for large slices: 200 nodes must render, validate, and
// remain deterministic without a complete usable annotations.layout.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'groundcheck-large-'))
const slicePath = join(work, 'slice.json')
const annotationsPath = join(work, 'annotations.json')
const firstArtifact = join(work, 'first.html')
const secondArtifact = join(work, 'second.html')
const keepFixture = process.env.GROUNDCHECK_KEEP_LARGE_FIXTURE === '1'
const largeNodeCount = Number(process.env.GROUNDCHECK_LARGE_NODE_COUNT ?? 200)

try {
  const changedCutoff = Math.ceil(largeNodeCount * 0.4)
  const blastCutoff = Math.ceil(largeNodeCount * 0.8)
  const nodes = Array.from({ length: largeNodeCount }, (_, index) => {
    const n = String(index + 1).padStart(3, '0')
    return {
      id: `pkg-${String(index % 25).padStart(2, '0')}/module-${n}.ts#symbol${n}`,
      file: `src/pkg-${String(index % 25).padStart(2, '0')}/module-${n}.ts`,
      symbol: `symbol${n}`,
      kind: index % 7 === 0 ? 'component' : 'module',
      status: index < changedCutoff ? 'modified' : index < blastCutoff ? 'blast' : 'context',
      spans: index < changedCutoff ? [{ start: 1, end: 3 }] : [],
      stats: index < changedCutoff ? { added: 3, removed: 1 } : { added: 0, removed: 0 },
      exportedSymbolsChanged: index < changedCutoff ? [`symbol${n}`] : [],
    }
  })
  const edges = nodes.slice(1).map((node, index) => ({
    from: node.id,
    to: nodes[index % 12].id,
    type: index % 3 === 0 ? 'calls' : index % 3 === 1 ? 'imports' : 'consumes-type',
    evidence: { file: node.file, line: index + 1 },
  }))
  const slice = {
    groundcheck: '0.6.0',
    generated: {
      at: '2026-07-27T00:00:00Z',
      repo: 'large-fixture',
      range: 'main..large',
      headSha: `large${largeNodeCount}`,
      baseSha: 'base-large',
      tsconfig: 'tsconfig.json',
      toolVersions: { node: process.versions.node, 'ts-morph': 'test' },
    },
    epicenters: [nodes[0].id],
    nodes,
    ungraphed: [],
    edges,
    hidden: { count: 0, byKind: {} },
    excluded: { count: 0, files: [] },
  }
  const annotations = {
    annotations: '0.1.0',
    for: { range: 'main..large', headSha: `large${largeNodeCount}` },
    criteria: [],
    orphans: [],
    flags: [],
    notes: {},
    risk: {},
    readingOrder: [],
    // Deliberately incomplete and out of bounds: large slices must ignore
    // model-authored coordinates and use the shared deterministic placement.
    layout: { [nodes[0].id]: { x: -999, y: -999 } },
  }
  writeFileSync(slicePath, `${JSON.stringify(slice, null, 2)}\n`)
  writeFileSync(annotationsPath, `${JSON.stringify(annotations, null, 2)}\n`)

  for (const artifact of [firstArtifact, secondArtifact]) {
    execFileSync(
      process.execPath,
      [join(root, 'scripts/render-slice.ts'), '--slice', slicePath, '--annotations', annotationsPath, '--out', artifact],
      { stdio: 'pipe' },
    )
    execFileSync(
      process.execPath,
      [join(root, 'scripts/validate-slice.ts'), '--artifact', artifact, '--slice', slicePath, '--annotations', annotationsPath],
      { stdio: 'pipe' },
    )
  }

  const first = readFileSync(firstArtifact, 'utf8')
  const second = readFileSync(secondArtifact, 'utf8')
  const nodeCount = (first.match(/class="node /g) ?? []).length
  if (nodeCount !== largeNodeCount) throw new Error(`rendered ${nodeCount} nodes, expected ${largeNodeCount}`)
  if (!/data-layout-mode="automatic"/.test(first)) throw new Error('large slice did not use automatic layout')
  if (!/class="large-slice-warning"/.test(first)) throw new Error('large slice warning is missing')
  const canvas = /data-canvas-width="(\d+)" data-canvas-height="(\d+)"/.exec(first)
  if (!canvas || Number(canvas[1]) <= 1180 || Number(canvas[2]) <= 620)
    throw new Error(`large canvas did not expand: ${canvas?.[1]}x${canvas?.[2]}`)
  if (first !== second) throw new Error('two large-slice renders were not byte-identical')
  const tamperedArtifact = join(work, 'tampered.html')
  writeFileSync(tamperedArtifact, first.replace(/data-x="[^"]+"/, 'data-x="99999"'))
  let rejectedTamper = false
  try {
    execFileSync(
      process.execPath,
      [join(root, 'scripts/validate-slice.ts'), '--artifact', tamperedArtifact, '--slice', slicePath, '--annotations', annotationsPath],
      { stdio: 'pipe' },
    )
  } catch (error: any) {
    rejectedTamper = String(error?.stdout).includes('"check":"layout-drift"')
  }
  if (!rejectedTamper) throw new Error('validator accepted a drifted automatic position')

  const manyFilesSlicePath = join(work, 'many-files.json')
  const manyFilesAnnotationsPath = join(work, 'many-files-annotations.json')
  const manyFilesArtifact = join(work, 'many-files.html')
  const manyFilesSlice = {
    ...slice,
    generated: { ...slice.generated, range: 'main..many-files', headSha: 'files101' },
    epicenters: [],
    nodes: [],
    edges: [],
    ungraphed: Array.from({ length: 101 }, (_, index) => ({
      file: `docs/change-${String(index + 1).padStart(3, '0')}.md`,
      status: 'modified',
      spans: [{ start: 1, end: 1 }],
      stats: { added: 1, removed: 0 },
      excerpt: [{ op: 'add', text: `change ${index + 1}` }],
    })),
  }
  const manyFilesAnnotations = {
    ...annotations,
    for: { range: 'main..many-files', headSha: 'files101' },
    layout: {},
  }
  writeFileSync(manyFilesSlicePath, `${JSON.stringify(manyFilesSlice, null, 2)}\n`)
  writeFileSync(manyFilesAnnotationsPath, `${JSON.stringify(manyFilesAnnotations, null, 2)}\n`)
  execFileSync(
    process.execPath,
    [join(root, 'scripts/render-slice.ts'), '--slice', manyFilesSlicePath, '--annotations', manyFilesAnnotationsPath, '--out', manyFilesArtifact],
    { stdio: 'pipe' },
  )
  execFileSync(
    process.execPath,
    [join(root, 'scripts/validate-slice.ts'), '--artifact', manyFilesArtifact, '--slice', manyFilesSlicePath, '--annotations', manyFilesAnnotationsPath],
    { stdio: 'pipe' },
  )
  const manyFiles = readFileSync(manyFilesArtifact, 'utf8')
  if (!/Large review slice · 101 changed files/.test(manyFiles)) throw new Error('101-file warning is missing')

  console.log(`ok — ${largeNodeCount} nodes rendered on an automatic ${canvas[1]}x${canvas[2]} canvas; 101-file slices warn without rejection`)
} finally {
  if (keepFixture) console.error(`large fixture retained at ${work}`)
  else rmSync(work, { recursive: true, force: true })
}
