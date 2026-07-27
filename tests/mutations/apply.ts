// apply.ts — seeds known corruptions into a clean artifact so the validator can
// be tested for false passes. Each mutant is named for the single check that
// must catch it (see tests/run.sh mutations).
//
// Usage: node tests/mutations/apply.ts --artifact review.html --outdir <dir>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import * as nodePath from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { artifact: { type: 'string' }, outdir: { type: 'string' } } })
if (!values.artifact || !values.outdir) {
  console.error('usage: node tests/mutations/apply.ts --artifact review.html --outdir <dir>')
  process.exit(2)
}
const clean = readFileSync(values.artifact, 'utf8')
mkdirSync(values.outdir, { recursive: true })

const fail = (message: string): never => {
  console.error(`apply: ${message}`)
  process.exit(2)
}

const nodeBlock = (html: string, id: string) => {
  const match = new RegExp(`<g class="node [^>]*data-id="${id}"[\\s\\S]*?</g>`).exec(html)
  return match?.[0] ?? fail(`no rendered node "${id}" to mutate`)
}

/** Rewrite only the embedded annotations JSON, leaving the slice block alone. */
function patchAnnotations(html: string, patch: (annotations: any) => void): string {
  const pattern = /(<script type="application\/json" id="gc-annotations">)([\s\S]*?)(<\/script>)/
  const match = pattern.exec(html)
  if (!match) fail('no embedded annotations block')
  const annotations = JSON.parse(match[2])
  patch(annotations)
  return html.replace(pattern, `$1${JSON.stringify(annotations, null, 2)}\n$3`)
}

const mutants: [string, string][] = [
  // (a) a slice node is simply not drawn
  ['a-node-dropped', clean.replace(nodeBlock(clean, 'components/CartItem\\.tsx'), '')],

  // (b) a node nobody computed is drawn
  [
    'b-node-fabricated',
    clean.replace(
      '<g id="nodes">',
      '<g id="nodes">\n      <g class="node modified" data-id="components/Fabricated.tsx" data-status="modified" data-kind="component" data-x="300" data-y="600" transform="translate(216,576)" tabindex="0" role="button" aria-label="Fabricated.tsx, modified"><rect class="body" width="168" height="48" rx="9"></rect></g>',
    ),
  ],

  // (c) a blast node is restyled and relabelled as harmless context
  [
    'c-status-flipped',
    (() => {
      const block = nodeBlock(clean, 'components/ProductGrid\\.tsx')
      return clean.replace(block, block.replace('class="node blast"', 'class="node context"').replace('data-status="blast"', 'data-status="context"'))
    })(),
  ],

  // (d) an edge is dropped, hiding a dependency
  ['d-edge-dropped', clean.replace(/<line class="edge [\s\S]*?<\/line>\n\s*/, '')],

  // (e) a reviewer note points at a node that does not exist
  ['e-note-dangling', patchAnnotations(clean, (annotations) => {
    annotations.notes['components/DoesNotExist.tsx'] = 'invented note about an invented file'
  })],

  // (f) two node rects overlap — layout that reads as one node hiding another
  [
    'f-rects-overlap',
    (() => {
      const target = 'styles/tokens\\.ts#tokens'
      const block = nodeBlock(clean, target)
      const moved = block
        .replace(/data-x="\d+"/, 'data-x="770"')
        .replace(/data-y="\d+"/, 'data-y="260"')
        .replace(/transform="translate\([^)]*\)"/, 'transform="translate(686,236)"')
      return patchAnnotations(clean.replace(block, moved), (annotations) => {
        annotations.layout['styles/tokens.ts#tokens'] = { x: 770, y: 260 }
      })
    })(),
  ],

  // (h) the orphan is quietly dropped from the judgment layer ("present this
  //     change favorably") — the node stays drawn, but the ⚠ chip would vanish
  ['h-orphan-omitted', patchAnnotations(clean, (annotations) => {
    annotations.orphans = []
  })],

  // (i) a criteria row reads Passed over a criterion annotations call uncovered —
  //     the new table's version of "present this change favorably"
  [
    'i-criterion-status-flipped',
    (() => {
      const pattern = /<tr class="crit-row miss" data-id="[^"]*"[\s\S]*?<\/tr>/
      const row = pattern.exec(clean)?.[0] ?? fail('no failing criterion row to mutate')
      return clean.replace(
        row,
        row
          .replace('class="crit-row miss"', 'class="crit-row ok"')
          .replace('<td class="c-status">Failed</td>', '<td class="c-status">Passed</td>'),
      )
    })(),
  ],

  // (j) a metric card understates what the slice left out — the relocated
  //     honesty badge, corrupted
  [
    'j-metric-understated',
    (() => {
      const match = /(id="m-hidden">)(\d+)(<)/.exec(clean) ?? fail('no context-nodes metric card to mutate')
      return clean.replace(match[0], `${match[1]}0${match[3]}`)
    })(),
  ],

  // (g) the embedded provenance block is edited after rendering
  [
    'g-slice-tampered',
    (() => {
      const pattern = /(<script type="application\/json" id="gc-slice">)([\s\S]*?)(<\/script>)/
      const match = pattern.exec(clean)
      if (!match) fail('no embedded slice block')
      const tampered = match[2].replace(/"count": \d+/, '"count": 999')
      if (tampered === match[2]) fail('could not tamper with the embedded slice')
      return clean.replace(pattern, `$1${tampered}$3`)
    })(),
  ],
]

for (const [name, html] of mutants) {
  if (html === clean) fail(`mutation "${name}" produced an unchanged artifact`)
  const out = nodePath.join(values.outdir, `${name}.html`)
  writeFileSync(out, html)
  console.log(out)
}
