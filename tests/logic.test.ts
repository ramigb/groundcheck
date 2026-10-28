import test from 'node:test'
import assert from 'node:assert/strict'
import { extractLogic, compareLogic } from '../scripts/logic.ts'

const translate = (code: string, file = 'sample.ts') => [...extractLogic(file, code).values()]
const text = (code: string) => JSON.stringify(translate(code))

test('falsy and nullish defaults remain distinct for all boundary values', () => {
  const old = text('const timeout = input || 5000;')
  const next = text('const timeout = input ?? 5000;')
  assert.match(old, /only if the left value is falsy/)
  assert.match(next, /only if the left value is null or undefined/)
  for (const input of [0, false, '', NaN]) { assert.equal(input || 5000, 5000); assert.ok(Object.is(input ?? 5000, input)) }
  for (const input of [null, undefined]) { assert.equal(input || 5000, 5000); assert.equal(input ?? 5000, 5000) }
})
test('short-circuit rules preserve the operand value and conditional evaluation', () => {
  assert.match(text('const x = a && sideEffect();'), /evaluate and use CALL sideEffect WITH \(\) only if the left value is truthy/)
  assert.match(text('const x = a || sideEffect();'), /use CALL sideEffect WITH \(\) only if the left value is falsy/)
  assert.doesNotMatch(text('const x = a && b;'), /equals true/)
})
test('condition negation preserves truthiness, early exits and exception control flow', () => {
  const output = text('function check(user: User) { if (!user.active) return; throw error; }')
  assert.match(output, /NOT truthy\(user.active\)/)
  assert.match(output, /RETURN undefined; stop this function body/)
  assert.match(output, /THROW error; transfer control/)
})
test('await and finally do not disappear during translation', () => {
  const output = text('async function save() { try { return await persist(); } finally { cleanup(); } }')
  assert.match(output, /WAIT FOR \(CALL persist WITH \(\)\)/)
  assert.match(output, /rejection unless handled/)
  assert.match(output, /override the pending completion/)
})
test('call names do not become invented business behavior', () => {
  const output = text('async function run() { await processPayment(order); }')
  assert.match(output, /CALL processPayment WITH \(order\)/)
  assert.doesNotMatch(output, /charge|customer|successful/i)
})
test('type annotations and assertions do not imply runtime validation', () => {
  assert.match(text('type Product = { id: string }; const value = input as Product;'), /no runtime validation/)
  assert.match(text('const value: Product = input;'), /type annotation/)
})
test('unsupported syntax and invalid code remain visible with source evidence', () => {
  for (const code of ['class A { get value() { return 1 } }', 'function* values(){ yield 1 }', 'for (const x of xs) log(x);']) {
    const unit = translate(code)[0]
    assert.equal(unit.coverage, 'source-only')
    assert.ok(unit.gaps.length)
    assert.equal(unit.code, code)
  }
  const invalid = translate('function broken( {')[0]
  assert.equal(invalid.coverage, 'source-only')
  assert.ok(invalid.gaps.length)
})
test('JSX and nested callback gaps are explicit; function definitions do not run their body', () => {
  const jsx = translate('export const View = () => <Button onClick={() => send()} />;', 'view.tsx')[0]
  assert.equal(jsx.coverage, 'partial')
  assert.ok(jsx.gaps.some(g => /Jsx/.test(g.reason)))
  assert.match(JSON.stringify(jsx), /run this body only when called/)
  const callback = translate('const xs = items.map(x => x.id);')[0]
  assert.ok(callback.gaps.some(g => /Nested function expression/.test(g.reason)))
})
test('equality coercion, selected branches and matching loop continues stay explicit', () => {
  assert.match(text('if (a == b) return a === b ? one() : two();'), /with JavaScript coercion/)
  assert.match(text('const x = condition ? one() : two();'), /evaluate only the selected branch/)
  assert.match(text('for (let i = 0; i < 3; i++) { continue; }'), /after body or matching continue/)
})
test('source spans correspond to complete enclosing logical units, including local code', () => {
  const source = '\nexport function outer() {\n  function local() { return 0; }\n  return local();\n}\n'
  const unit = translate(source)[0]
  assert.deepEqual(unit.source, { file: 'sample.ts', start: 2, end: 5 })
  assert.match(JSON.stringify(unit.steps), /DEFINE FUNCTION local/)
  assert.equal(compareLogic('sample.ts', source, source.replace('return 0', 'return 1')).length, 1)
})

test('complex receivers, optional access and parameter defaults disclose explanation gaps', () => {
  for (const code of ['const x = user?.active;', 'const x = object[key()];', 'const x = getClient().send();', 'const x = (() => 1)();', 'function f(x = sideEffect()) { return x; }', 'const f = ({ x }) => x;']) {
    const unit = translate(code)[0]
    assert.notEqual(unit.coverage, 'translated', code)
    assert.ok(unit.gaps.length, code)
    assert.equal(unit.code, code)
  }
})
test('operator observations come from AST nodes, not comments and strings', () => {
  const changes = compareLogic('a.ts', 'const message = "|| await";', 'const message = "?? &&";')
  assert.deepEqual(changes[0].patterns, [])
  const actual = compareLogic('a.ts', 'const timeout = input || 5000;', 'const timeout = input ?? 5000;')[0]
  assert.match(actual.patterns[0], /right expression is now used only for null or undefined/)
  assert.deepEqual(actual.patterns.slice(1), ['|| occurrences: 1 → 0', '?? occurrences: 0 → 1'])
})
