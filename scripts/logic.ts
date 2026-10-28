import { ts } from 'ts-morph'
import type { Change, Gap, Location, Logic, Step } from './model.ts'

// These are syntax translations, not assertions of correctness or equivalence.
// Preserve evaluation order and JS truthiness. Unknown syntax stays verbatim.
export function extractLogic(file: string, code: string): Map<string, Logic> {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true)
  const result = new Map<string, Logic>()
  const occurrences = new Map<string, number>()
  const location = (n: ts.Node): Location => ({ file, start: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, end: sf.getLineAndCharacterOfPosition(n.getEnd()).line + 1 })
  const raw = (n: ts.Node) => n.getText(sf)
  let gaps: Gap[] = []
  const gap = (n: ts.Node, reason = `Unsupported ${ts.SyntaxKind[n.kind]}`) => {
    gaps.push({ reason, source: location(n), code: raw(n) })
    return `SOURCE ${JSON.stringify(raw(n))}`
  }
  const step = (n: ts.Node, kind: string, text: string, children?: Step[]): Step => ({ kind, text, source: location(n), ...(children ? { children } : {}) })
  const plainAccess = (n: ts.Expression): boolean => ts.isIdentifier(n) || n.kind === ts.SyntaxKind.ThisKeyword || n.kind === ts.SyntaxKind.SuperKeyword || (ts.isPropertyAccessExpression(n) && !ts.isPropertyAccessChain(n) && plainAccess(n.expression))
  const parameters = (items: ts.NodeArray<ts.ParameterDeclaration>) => items.map(p => {
    if (p.initializer || !ts.isIdentifier(p.name) || p.dotDotDotToken) gap(p, 'Parameter initialization, destructuring or rest semantics retained verbatim')
    return raw(p)
  }).join(', ')
  const ex = (n: ts.Expression): string => {
    if (ts.isIdentifier(n) || n.kind === ts.SyntaxKind.ThisKeyword || n.kind === ts.SyntaxKind.SuperKeyword || ts.isLiteralExpression(n) || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(n.kind)) return raw(n)
    if (ts.isParenthesizedExpression(n)) return `(${ex(n.expression)})`
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
      return plainAccess(n) ? raw(n) : gap(n, 'Computed/optional access or complex receiver retained verbatim')
    }
    if (ts.isBinaryExpression(n)) {
      const left = ex(n.left), right = ex(n.right)
      switch (n.operatorToken.kind) {
        case ts.SyntaxKind.QuestionQuestionToken: return `(${left}; use ${right} only if the left value is null or undefined)`
        case ts.SyntaxKind.BarBarToken: return `(${left}; use ${right} only if the left value is falsy)`
        case ts.SyntaxKind.AmpersandAmpersandToken: return `(${left}; evaluate and use ${right} only if the left value is truthy)`
        case ts.SyntaxKind.EqualsEqualsEqualsToken: return `(${left} strictly equals ${right})`
        case ts.SyntaxKind.ExclamationEqualsEqualsToken: return `(${left} does not strictly equal ${right})`
        case ts.SyntaxKind.EqualsEqualsToken: return `(${left} loosely equals ${right}, with JavaScript coercion)`
        case ts.SyntaxKind.ExclamationEqualsToken: return `(${left} loosely differs from ${right}, with JavaScript coercion)`
        case ts.SyntaxKind.LessThanToken: case ts.SyntaxKind.LessThanEqualsToken: case ts.SyntaxKind.GreaterThanToken: case ts.SyntaxKind.GreaterThanEqualsToken:
          return `(${left} ${raw(n.operatorToken)} ${right}, using JavaScript comparison rules)`
        case ts.SyntaxKind.EqualsToken: return `ASSIGN ${right} TO ${left} and use the assigned value`
        default: return gap(n, 'Operator retained verbatim; coercion, assignment and evaluation semantics are not simplified')
      }
    }
    if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.ExclamationToken) return `NOT truthy(${ex(n.operand)})`
    if (ts.isAwaitExpression(n)) return `WAIT FOR (${ex(n.expression)}); propagate rejection unless handled by surrounding code`
    if (ts.isCallExpression(n) && !n.questionDotToken && plainAccess(n.expression)) return `CALL ${raw(n.expression)} WITH (${n.arguments.map(a => ts.isSpreadElement(a) ? gap(a, 'Spread argument retained verbatim') : ex(a)).join(', ')})`
    if (ts.isConditionalExpression(n)) return `(IF truthy(${ex(n.condition)}) THEN ${ex(n.whenTrue)} ELSE ${ex(n.whenFalse)}; evaluate only the selected branch)`
    if (ts.isAsExpression(n) || ts.isTypeAssertionExpression(n) || ts.isSatisfiesExpression(n) || ts.isNonNullExpression(n)) return `${ex(n.expression)} [type-only assertion; no runtime validation]`
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) return gap(n, 'Nested function expression retained verbatim; its body is not executed at definition')
    return gap(n)
  }
  const body = (n: ts.Statement): Step[] => ts.isBlock(n) ? n.statements.flatMap(st) : st(n)
  const st = (n: ts.Statement): Step[] => {
    if (ts.isBlock(n)) return [step(n, 'block', 'ENTER lexical block', n.statements.flatMap(st))]
    if (ts.isFunctionDeclaration(n) && n.body && !n.asteriskToken) {
      return [step(n, 'function', `DEFINE ${n.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) ? 'async ' : ''}FUNCTION ${n.name?.text ?? 'default'}(${parameters(n.parameters)}); run this body only when called`, n.body.statements.flatMap(st))]
    }
    if (ts.isVariableStatement(n)) return n.declarationList.declarations.map(d => {
      const binding = (n.declarationList.flags & ts.NodeFlags.Const) ? 'const' : (n.declarationList.flags & ts.NodeFlags.Let) ? 'let' : 'var'
      if (!ts.isIdentifier(d.name)) return step(d, 'source', gap(d, 'Destructuring binding retained verbatim'))
      if (d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
        const fn = d.initializer
        if (ts.isFunctionExpression(fn) && fn.asteriskToken) return step(d, 'source', gap(d, 'Generator retained verbatim'))
        return step(d, 'function', `BIND ${binding} ${d.name.text} TO ${fn.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) ? 'async ' : ''}FUNCTION (${parameters(fn.parameters)}); run this body only when called`, ts.isBlock(fn.body) ? fn.body.statements.flatMap(st) : [step(fn.body, 'return', `RETURN ${ex(fn.body)}`)])
      }
      return step(d, 'binding', `DECLARE ${binding} ${d.name.text}${d.type ? `: ${raw(d.type)} [type annotation]` : ''}${d.initializer ? ` WITH ${ex(d.initializer)}` : binding === 'var' ? '; no initializer (a var redeclaration does not reset an existing value)' : ' WITH undefined'}`)
    })
    if (ts.isIfStatement(n)) return [step(n, 'if', `IF truthy(${ex(n.expression)})`, [step(n.thenStatement, 'then', 'THEN', body(n.thenStatement)), ...(n.elseStatement ? [step(n.elseStatement, 'else', 'OTHERWISE', body(n.elseStatement))] : [])])]
    if (ts.isReturnStatement(n)) return [step(n, 'return', `RETURN ${n.expression ? ex(n.expression) : 'undefined'}; stop this function body`)]
    if (ts.isThrowStatement(n)) return [step(n, 'throw', `THROW ${ex(n.expression)}; transfer control to an applicable handler`)]
    if (ts.isExpressionStatement(n)) return [step(n, 'evaluate', `EVALUATE ${ex(n.expression)}`)]
    if (ts.isWhileStatement(n)) return [step(n, 'while', `WHILE truthy(${ex(n.expression)}); check before each iteration`, body(n.statement))]
    if (ts.isDoStatement(n)) return [step(n, 'do', `DO body, THEN repeat WHILE truthy(${ex(n.expression)})`, body(n.statement))]
    if (ts.isForStatement(n)) return [step(n, 'for', `FOR (initialize once: ${n.initializer ? raw(n.initializer) : 'none'}; test before each iteration: ${n.condition ? `truthy(${ex(n.condition)})` : 'true'}; after body or matching continue: ${n.incrementor ? raw(n.incrementor) : 'none'})`, body(n.statement))]
    if (ts.isForOfStatement(n) || ts.isForInStatement(n)) return [step(n, 'source', gap(n, 'Iterator/enumeration semantics retained verbatim'))]
    if (ts.isBreakStatement(n) || ts.isContinueStatement(n)) return [step(n, 'jump', `${ts.isBreakStatement(n) ? 'BREAK' : 'CONTINUE'} ${n.label ? `to label ${n.label.text}` : 'the applicable enclosing construct'}`)]
    if (ts.isTryStatement(n)) return [step(n, 'try', 'TRY', [step(n.tryBlock, 'try-body', 'RUN', n.tryBlock.statements.flatMap(st)), ...(n.catchClause ? [step(n.catchClause, 'catch', `ON thrown exception${n.catchClause.variableDeclaration ? ` bind ${raw(n.catchClause.variableDeclaration)}` : ''}`, n.catchClause.block.statements.flatMap(st))] : []), ...(n.finallyBlock ? [step(n.finallyBlock, 'finally', 'FINALLY run before leaving; a return or throw here can override the pending completion', n.finallyBlock.statements.flatMap(st))] : [])])]
    if (ts.isTypeAliasDeclaration(n) || ts.isInterfaceDeclaration(n)) return [step(n, 'type', `DECLARE compile-time ${ts.isInterfaceDeclaration(n) ? 'INTERFACE' : 'TYPE'} ${n.name.text}: ${raw(n)}; this declaration adds no runtime validation`)]
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return [step(n, 'module', `MODULE declaration: ${raw(n)}; runtime module loading may have side effects unless this is type-only`)]
    if (ts.isEmptyStatement(n)) return [step(n, 'empty', 'EMPTY statement')]
    return [step(n, 'source', gap(n))]
  }
  const parseErrors = (sf as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics
  if (parseErrors.length) {
    const source = { file, start: 1, end: Math.max(1, code.split('\n').length) }
    result.set('file', { name: file, kind: 'unparsed', source, code, steps: [], gaps: parseErrors.map(d => ({ reason: ts.flattenDiagnosticMessageText(d.messageText, '\n'), source, code })), coverage: 'source-only' })
    return result
  }
  for (const n of sf.statements) {
    gaps = []
    const name = ts.isVariableStatement(n) ? n.declarationList.declarations.map(d => raw(d.name)).join(', ') : 'name' in n && n.name ? raw(n.name as ts.Node) : ts.isImportDeclaration(n) ? raw(n.moduleSpecifier) : ts.SyntaxKind[n.kind]
    const kind = ts.isVariableStatement(n) ? 'VariableStatement' : ts.SyntaxKind[n.kind]
    const key = `${kind}:${name}`
    const ordinal = occurrences.get(key) ?? 0
    occurrences.set(key, ordinal + 1)
    const steps = st(n)
    result.set(`${key}:${ordinal}`, { name, kind, source: location(n), code: raw(n), steps, gaps, coverage: gaps.length ? steps.every(s => s.kind === 'source') ? 'source-only' : 'partial' : 'translated' })
  }
  return result
}

export function compareLogic(file: string, beforeCode?: string, afterCode?: string): Change[] {
  const before = beforeCode === undefined ? new Map<string, Logic>() : extractLogic(file, beforeCode)
  const after = afterCode === undefined ? new Map<string, Logic>() : extractLogic(file, afterCode)
  const changes: Change[] = []
  for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const b = before.get(key), a = after.get(key)
    if (b && a && b.code === a.code) continue
    const patterns: string[] = []
    const bText = b?.code ?? '', aText = a?.code ?? ''
    if (b && a) {
      const binarySites = (text: string) => {
        const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
        const sites = new Map<string, { op: ts.SyntaxKind; left: string; right: string; line: number }>()
        const visit = (n: ts.Node, path: string) => {
          if (ts.isBinaryExpression(n)) sites.set(path, { op: n.operatorToken.kind, left: n.left.getText(sf), right: n.right.getText(sf), line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line })
          let i = 0; ts.forEachChild(n, child => { visit(child, `${path}/${i++}`) })
        }
        visit(sf, ''); return sites
      }
      const oldSites = binarySites(bText), newSites = binarySites(aText)
      for (const [path, old] of oldSites) {
        const next = newSites.get(path)
        if (next && old.left === next.left && old.right === next.right && old.op === ts.SyntaxKind.BarBarToken && next.op === ts.SyntaxKind.QuestionQuestionToken) {
          patterns.push(`Fallback at before line ${b.source.start + old.line} → after line ${a.source.start + next.line}: the right expression is now used only for null or undefined. If 0, false, an empty string or NaN reaches this expression, that left value is kept.`)
        }
      }
    }
    // Syntactic observations only: do not infer intent or claim equivalence.
    const operators = (text: string) => {
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
      const found: string[] = []
      const visit = (n: ts.Node) => { if (ts.isBinaryExpression(n) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(n.operatorToken.kind)) found.push(n.operatorToken.getText(sf)); if (ts.isAwaitExpression(n)) found.push('await'); ts.forEachChild(n, visit) }
      visit(sf); return found
    }
    const oldOps = operators(bText), newOps = operators(aText)
    for (const op of ['||', '??', '&&', 'await']) {
      const oldCount = oldOps.filter(x => x === op).length, newCount = newOps.filter(x => x === op).length
      if (oldCount !== newCount) patterns.push(`${op} occurrences: ${oldCount} → ${newCount}`)
    }
    changes.push({ id: `${file}#${key}`, file, name: (a ?? b)!.name, kind: (a ?? b)!.kind, status: !b ? 'added' : !a ? 'deleted' : 'modified', ...(b ? { before: b } : {}), ...(a ? { after: a } : {}), patterns })
  }
  return changes
}
