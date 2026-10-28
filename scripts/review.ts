import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { analyze } from './analyze.ts'
import { renderHtml } from './html.ts'

try {
  const { values } = parseArgs({ options: { repo: { type: 'string', default: '.' }, range: { type: 'string' }, patch: { type: 'string' }, out: { type: 'string', default: 'review.html' }, slice: { type: 'string' }, tsconfig: { type: 'string' }, worktree: { type: 'boolean', default: false }, criteria: { type: 'string' }, annotations: { type: 'string' } } })
  if (!values.range) throw new Error('usage: review.ts --repo <path> --range <base>..<head> [--out review.html] [--slice slice.json] [--worktree | --patch changes.diff] [--criteria criteria.json] [--annotations annotations.json]')
  const slice = analyze(values.repo!, values.range, values)
  const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'))
  const html = renderHtml(slice, values.annotations ? read(values.annotations) : null, values.criteria ? read(values.criteria) : { criteria: [] })
  writeFileSync(values.out!, html)
  if (values.slice) writeFileSync(values.slice, JSON.stringify(slice, null, 2) + '\n')
  if (readFileSync(values.out!, 'utf8') !== html) throw new Error('Written artifact failed parity verification')
  console.error(`groundcheck: ${slice.files.length} files, ${slice.changes.length} changed units → ${values.out}; no LLM used by the analysis pipeline`)
} catch (error) {
  console.error(`groundcheck: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  process.exitCode = 2
}
