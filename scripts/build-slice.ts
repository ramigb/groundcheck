import { writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { analyze } from './analyze.ts'

try {
  const { values } = parseArgs({ options: { repo: { type: 'string', default: '.' }, range: { type: 'string' }, patch: { type: 'string' }, out: { type: 'string' }, tsconfig: { type: 'string' }, worktree: { type: 'boolean', default: false } } })
  if (!values.range || !values.out) throw new Error('usage: build-slice.ts --repo <path> --range <base>..<head> --out slice.json [--worktree | --patch changes.diff] [--tsconfig <repo-relative-path>]')
  const slice = analyze(values.repo!, values.range, values)
  writeFileSync(values.out, JSON.stringify(slice, null, 2) + '\n')
  console.error(`build-slice: ${slice.files.length} files, ${slice.changes.length} logical changes, ${slice.references.length} reference sites → ${values.out}`)
} catch (error) {
  console.error(`build-slice: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  process.exitCode = 2
}
