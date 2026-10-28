import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { renderHtml } from './html.ts'

try {
  const { values } = parseArgs({ options: { artifact: { type: 'string' }, slice: { type: 'string' }, annotations: { type: 'string' }, criteria: { type: 'string' } } })
  if (!values.artifact || !values.slice) throw new Error('usage: validate-slice.ts --artifact review.html --slice slice.json [--criteria criteria.json] [--annotations annotations.json]')
  const artifact = readFileSync(values.artifact, 'utf8')
  const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'))
  const embedded = (id: string) => {
    const match = new RegExp(`<script type="application/json" id="${id}">([\\s\\S]*?)</script>`).exec(artifact)
    if (!match) throw new Error(`Missing embedded ${id}`)
    return JSON.parse(match[1])
  }
  const annotations = values.annotations ? read(values.annotations) : embedded('gc-annotations')
  const criteria = values.criteria ? read(values.criteria) : embedded('gc-criteria')
  const expected = renderHtml(read(values.slice), annotations, criteria)
  if (artifact !== expected) {
    console.log(JSON.stringify({ check: 'render-parity', detail: 'Artifact differs from the deterministic rendering of the supplied facts and interpretation. Content, controls, source evidence, metrics or embedded data were changed.' }))
    process.exitCode = 1
  } else console.error('validate-slice: artifact matches supplied facts and inputs; semantic correctness is not certified')
} catch (error) {
  console.log(JSON.stringify({ check: 'input-integrity', detail: error instanceof Error ? error.message : String(error) }))
  process.exitCode = 2
}
