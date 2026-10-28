import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { renderHtml } from './html.ts'

try {
  const { values } = parseArgs({ options: { slice: { type: 'string' }, annotations: { type: 'string' }, criteria: { type: 'string' }, out: { type: 'string' } } })
  if (!values.slice || !values.out) throw new Error('usage: render-slice.ts --slice slice.json --out review.html [--criteria criteria.json] [--annotations annotations.json]')
  const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'))
  const html = renderHtml(read(values.slice), values.annotations ? read(values.annotations) : null, values.criteria ? read(values.criteria) : { criteria: [] })
  writeFileSync(values.out, html)
  console.error(`render-slice: ${values.out}`)
} catch (error) {
  console.error(`render-slice: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 2
}
