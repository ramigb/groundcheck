// drive-artifact.js — drives a rendered artifact in headless Chrome and asserts
// the DESIGN_CONTRACT v0.4.0 interaction clauses. Every expectation is derived
// from the artifact's own embedded slice/annotations, so this runs against any
// artifact, not just the storefront fixture.
//
// Usage: node tests/interaction/drive-artifact.js <review.html> <chrome-profile-dir>
// CHROME overrides the browser path; the battery skips (exit 0) when it is absent.
// No dependency: Node 22 ships a global WebSocket, which is all CDP needs.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
if (!existsSync(CHROME)) { console.log('  skip interaction battery: no browser at ' + CHROME); process.exit(0) }
const PORT = Number(process.env.CDP_PORT || 9333)
const url = 'file://' + process.argv[2]

let pass = 0
let fail = 0
let skip = 0
const ok = (m) => { console.log('  ok   ' + m); pass++ }
const bad = (m) => { console.log('  FAIL ' + m); fail++ }
const na = (m) => { console.log('  n/a  ' + m); skip++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const q = (s) => JSON.stringify(String(s))

async function main() {
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--window-size=1680,940',
    `--remote-debugging-port=${PORT}`, '--user-data-dir=' + process.argv[3], url,
  ], { stdio: 'ignore' })

  let target = null
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250)
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    } catch (e) { /* not up yet */ }
  }
  if (!target) { console.error('chrome did not expose a page target'); chrome.kill(); process.exit(1) }

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  let id = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  }
  const send = (method, params) =>
    new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })) })
  const evaluate = async (expr) => {
    const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.text + ' :: ' + expr)
    return res.result?.result?.value
  }

  await send('Page.enable')
  await sleep(1200)

  // Everything below is derived from what the artifact itself carries.
  const facts = await evaluate(`(() => {
    const s = JSON.parse(document.getElementById('gc-slice').textContent);
    const a = JSON.parse(document.getElementById('gc-annotations').textContent);
    const withExcerpt = s.nodes.find(n => n.excerpt && n.excerpt.length);
    const statuses = {};
    s.nodes.forEach(n => { statuses[n.status] = (statuses[n.status] || 0) + 1; });
    const groupOf = t => t === 'renders' || t === 'calls' ? 'flow'
      : t === 'consumes-type' ? 'type' : t === 'uses-token' ? 'token' : 'imports';
    const edgeGroups = {};
    s.edges.forEach(e => { const g = groupOf(e.type); edgeGroups[g] = (edgeGroups[g] || 0) + 1; });
    const crit = (a.criteria || []);
    return {
      nodes: s.nodes.length, edges: s.edges.length, epicenters: s.epicenters.length,
      statuses, edgeGroups, headSha: s.generated.headSha, hidden: s.hidden.count,
      excerptNode: withExcerpt ? withExcerpt.id : null,
      excerptText: withExcerpt ? (withExcerpt.excerpt.find(l => l.op === 'add') || {}).text || null : null,
      firstCriterion: crit.length ? crit[0].id : null,
      firstCriterionNodes: crit.length ? (crit[0].nodes || []).length : 0,
      noteCount: Object.keys(a.notes || {}).length,
      flagNodeTarget: (a.flags || []).map(f => f.target.node).filter(Boolean)[0] || null,
      searchTerm: s.nodes[0].file.split('/').pop().split('.')[0].toLowerCase(),
    };
  })()`)

  const nodeCount = await evaluate("document.querySelectorAll('.node').length")
  if (nodeCount === facts.nodes) ok(`${nodeCount} node elements in the live DOM, matching the slice`)
  else bad(`${nodeCount} node elements, slice has ${facts.nodes}`)

  // --- view switching, aria-current exclusive
  for (const [view, card] of [['overview', 'card-overview'], ['files', 'card-files'], ['criteria', 'card-criteria'], ['flags', 'card-flags'], ['graph', 'card-graph']]) {
    await evaluate(`document.querySelector('.nav-item[data-view="${view}"]').click()`)
    const r = await evaluate(`(() => ({
      shown: getComputedStyle(document.getElementById('${card}')).display !== 'none',
      aria: document.querySelector('.nav-item[data-view="${view}"]').getAttribute('aria-current'),
      count: document.querySelectorAll('.nav-item[aria-current]').length,
    }))()`)
    if (r.shown && r.aria === 'page' && r.count === 1) ok(`view "${view}" switches, aria-current is exclusive`)
    else bad(`view "${view}": ${JSON.stringify(r)}`)
  }
  const both = await evaluate(
    "getComputedStyle(document.getElementById('card-graph')).display !== 'none' && getComputedStyle(document.getElementById('card-criteria')).display !== 'none'")
  if (both) ok('graph view shows graph + criteria'); else bad('graph view is missing one of its two cards')

  // --- filtering fades, never removes (DESIGN_CONTRACT § Signature elements)
  const statusToTest = Object.keys(facts.statuses).find((s) => s !== 'context') ?? 'added'
  await evaluate(`document.querySelector('input[data-status=${q(statusToTest)}]').click()`)
  const filt = await evaluate(`(() => {
    const all = document.querySelectorAll('.node');
    return {
      all: all.length,
      faded: document.querySelectorAll('.node.filtered').length,
      target: document.querySelectorAll('.node[data-status=${q(statusToTest)}]').length,
      inlineHidden: document.querySelectorAll('.node[style*="display: none"]').length,
      cssHidden: [...all].filter(n => getComputedStyle(n).display === 'none').length,
      opacity: (() => { const f = document.querySelector('.node.filtered');
        return f ? Number(getComputedStyle(f).opacity) : null; })(),
    };
  })()`)
  if (filt.all === facts.nodes && filt.faded === filt.target && filt.cssHidden === 0 && filt.inlineHidden === 0 && filt.opacity < 1)
    ok(`filter fades ${filt.faded} "${statusToTest}" node(s) at opacity ${filt.opacity}; all ${filt.all} stay in the document`)
  else bad('filter mechanism: ' + JSON.stringify(filt))

  await evaluate("document.getElementById('clear-filters').click()")
  const cleared = await evaluate("document.querySelectorAll('.node.filtered').length")
  if (cleared === 0) ok('Clear all restores every node'); else bad(`${cleared} nodes still filtered after Clear all`)

  // --- edge-type filter
  const edgeGroup = Object.keys(facts.edgeGroups)[0]
  if (!edgeGroup) na('edge filter: slice has no edges')
  else {
    await evaluate(`document.querySelector('input[data-edge=${q(edgeGroup)}]').click()`)
    const faded = await evaluate("document.querySelectorAll('.edge.filtered').length")
    if (faded === facts.edgeGroups[edgeGroup]) ok(`edge filter fades all ${faded} "${edgeGroup}" edge(s)`)
    else bad(`edge filter: ${faded} faded vs ${facts.edgeGroups[edgeGroup]} in the slice`)
    await evaluate("document.getElementById('clear-filters').click()")
  }

  // --- focus toggles
  if (!facts.epicenters) na('rings toggle: slice names no epicenter')
  else {
    await evaluate("document.getElementById('focus-rings').click()")
    const r = await evaluate(`(() => ({
      hidden: getComputedStyle(document.getElementById('rings')).display === 'none',
      inDoc: document.querySelectorAll('.ring').length,
    }))()`)
    if (r.hidden && r.inDoc === 3 * facts.epicenters) ok(`rings toggle hides the group, ${r.inDoc} ring elements stay in the document`)
    else bad('rings toggle: ' + JSON.stringify(r))
    await evaluate("document.getElementById('focus-rings').click()")
  }
  if (!facts.statuses.context) na('context toggle: slice has no context node')
  else {
    await evaluate("document.getElementById('focus-context').click()")
    const faded = await evaluate("document.querySelectorAll('.node[data-status=\"context\"].filtered').length")
    if (faded === facts.statuses.context) ok(`context toggle fades all ${faded} context node(s)`)
    else bad(`context toggle: ${faded}/${facts.statuses.context}`)
    await evaluate("document.getElementById('focus-context').click()")
  }

  // --- search
  await evaluate(`(() => { const s = document.getElementById('search');
    s.value = ${q(facts.searchTerm)}; s.dispatchEvent(new Event('input')); })()`)
  const search = await evaluate(`(() => {
    const unf = [...document.querySelectorAll('.node')].filter(n => !n.classList.contains('filtered'));
    return { count: unf.length, allMatch: unf.every(n => (n.dataset.file + ' ' + n.dataset.symbol + ' ' + n.dataset.id).toLowerCase().includes(${q(facts.searchTerm)})) };
  })()`)
  if (search.count > 0 && search.allMatch) ok(`search "${facts.searchTerm}" narrows to ${search.count} matching node(s)`)
  else bad('search: ' + JSON.stringify(search))
  await evaluate("document.getElementById('clear-filters').click()")

  // --- node selection drives the panel and the diff
  if (!facts.excerptNode) na('node selection: no node in this slice carries an excerpt')
  else {
    await evaluate(`document.querySelector('.node[data-id=${q(facts.excerptNode)}]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`)
    const sel = await evaluate(`(() => {
      const pre = document.querySelector('#diff-preview pre.diff');
      return {
        selected: document.querySelectorAll('.node.selected').length,
        hasDiff: !!pre,
        text: pre ? pre.textContent : '',
        gutter: pre && pre.querySelector('i') ? pre.querySelector('i').textContent : '',
        hasBack: !!document.getElementById('back'),
        hot: document.querySelectorAll('.edge.hot').length,
      };
    })()`)
    const carriesText = !facts.excerptText || sel.text.includes(facts.excerptText)
    if (sel.selected === 1 && sel.hasDiff && carriesText && sel.hasBack)
      ok('node click selects, renders its diff from the embedded slice, offers back')
    else bad('node selection: ' + JSON.stringify(sel).slice(0, 300))
    if (sel.gutter === '1') ok('diff gutter numbers excerpt lines'); else bad('diff gutter missing: ' + sel.gutter)

    await evaluate("document.getElementById('back').click()")
    const backOk = await evaluate("document.getElementById('summary-body').textContent.includes('nodes drawn')")
    if (backOk) ok('back restores the computed overview lede'); else bad('back did not restore the lede')
  }

  // --- criterion row isolates its nodes and captions the judgment register
  if (!facts.firstCriterion) na('criteria: annotations carry none')
  else {
    await evaluate(`document.querySelector('.crit-row[data-id=${q(facts.firstCriterion)}]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`)
    const crit = await evaluate(`(() => ({
      faded: document.querySelectorAll('.node.faded').length,
      caption: (document.querySelector('#summary-body .register-caption') || {}).textContent || '',
      active: document.querySelectorAll('.crit-row.active').length,
    }))()`)
    const expectFaded = facts.nodes - facts.firstCriterionNodes
    if (crit.faded === expectFaded && crit.caption === 'model-matched' && crit.active === 1)
      ok(`criterion row isolates its ${facts.firstCriterionNodes} node(s) and captions the judgment register`)
    else bad('criterion row: ' + JSON.stringify(crit) + ` expected faded=${expectFaded}`)
  }

  // --- flag jump
  if (!facts.flagNodeTarget) na('flags: none targets a node')
  else {
    await evaluate("document.querySelector('#tab-summary .flags button[data-go^=\"node:\"]').click()")
    const n = await evaluate("document.querySelectorAll('.node.selected').length")
    if (n === 1) ok('flag row jumps to its target node'); else bad('flag jump selected ' + n)
  }

  // --- tabs
  await evaluate("document.querySelector('.tab[data-tab=\"notes\"]').click()")
  const notes = await evaluate(`(() => ({
    shown: getComputedStyle(document.getElementById('tab-notes-body')).display !== 'none',
    entries: document.querySelectorAll('#tab-notes-body .note-entry').length,
    violet: document.querySelectorAll('#tab-notes-body .reviewer-note').length,
    aria: document.querySelector('.tab[data-tab="notes"]').getAttribute('aria-selected'),
  }))()`)
  if (notes.shown && notes.entries === facts.noteCount && notes.violet === facts.noteCount && notes.aria === 'true')
    ok(`Notes tab lists all ${facts.noteCount} note(s), each in the judgment register`)
  else bad('notes tab: ' + JSON.stringify(notes) + ` expected ${facts.noteCount} entries`)

  if (facts.excerptNode) {
    await evaluate(`document.querySelector('.node[data-id=${q(facts.excerptNode)}]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`)
  }
  await evaluate("document.querySelector('.tab[data-tab=\"diff\"]').click()")
  const diffTab = await evaluate(`(() => ({
    shown: getComputedStyle(document.getElementById('tab-diff-body')).display !== 'none',
    blocks: document.querySelectorAll('#tab-diff-body pre.diff').length,
  }))()`)
  if (diffTab.shown && (diffTab.blocks > 0 || !facts.excerptNode)) ok(`Diff tab renders ${diffTab.blocks} diff block(s)`)
  else bad('diff tab: ' + JSON.stringify(diffTab))
  await evaluate("document.querySelector('.tab[data-tab=\"summary\"]').click()")

  // --- zoom / pan / fit
  const z0 = await evaluate("document.getElementById('canvas').getAttribute('viewBox')")
  await evaluate("document.getElementById('zoom-in').click()")
  const z1 = await evaluate("document.getElementById('canvas').getAttribute('viewBox')")
  const readout = await evaluate("document.getElementById('zoom-level').value")
  await evaluate("document.getElementById('fit-view').click()")
  const z2 = await evaluate("document.getElementById('canvas').getAttribute('viewBox')")
  if (z0 !== z1 && z0 === z2 && readout === '125') ok(`zoom in changes the viewBox (readout ${readout}%), Fit view restores it`)
  else bad(`zoom: ${z0} -> ${z1} (${readout}%) -> ${z2}`)

  await evaluate("(() => { const s = document.getElementById('zoom-level'); s.value='200'; s.dispatchEvent(new Event('change')); })()")
  const z200 = await evaluate(`(() => {
    const vb = document.getElementById('canvas').getAttribute('viewBox').split(' ').map(Number);
    return { w: vb[2], h: vb[3], cx: vb[0] + vb[2] / 2, cy: vb[1] + vb[3] / 2 };
  })()`)
  if (z200.w === 590 && z200.h === 310 && z200.cx === 590 && z200.cy === 310)
    ok('zoom preset 200% halves the viewBox about its centre')
  else bad('zoom preset: ' + JSON.stringify(z200))
  await evaluate("document.getElementById('fit-view').click()")

  // --- placed coordinates are never touched by a view control
  const before = await evaluate("[...document.querySelectorAll('.node')].map(n => n.getAttribute('transform')).join('|')")
  await evaluate(`document.getElementById('zoom-in').click();
    document.querySelector('input[data-status=${q(statusToTest)}]').click()`)
  const after = await evaluate("[...document.querySelectorAll('.node')].map(n => n.getAttribute('transform')).join('|')")
  if (before === after) ok('zoom and filtering never move a placed node'); else bad('node transforms changed under a view control')
  await evaluate("document.getElementById('clear-filters').click(); document.getElementById('fit-view').click()")

  // --- keyboard operability
  const kb = await evaluate(`(() => {
    const n = document.querySelector('.node');
    n.focus();
    const focused = document.activeElement === n;
    n.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const selected = document.querySelectorAll('.node.selected').length;
    const row = document.querySelector('.crit-row[data-id]') || document.querySelector('.file-row[data-id]');
    row.focus();
    const rowFocus = document.activeElement === row;
    row.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    return { focused, selected, rowFocus };
  })()`)
  if (kb.focused && kb.selected === 1 && kb.rowFocus) ok('nodes and table rows are focusable and activate on Enter / Space')
  else bad('keyboard: ' + JSON.stringify(kb))

  const focusRings = await evaluate(`(() => {
    const css = [...document.styleSheets].flatMap(s => { try { return [...s.cssRules] } catch (e) { return [] } })
      .map(r => r.cssText || '').join('');
    /* cssText re-serialises selector lists with spaces, so each selector is
       checked on its own rather than as an authored group. */
    return ['.nav-item:focus-visible', '.tab:focus-visible', '.check input:focus-visible',
      '.switch input:focus-visible', '.tbtn:focus-visible', 'tbody tr:focus-visible',
      '.node:focus-visible', '#zoom-level:focus-visible'].filter(sel => !css.includes(sel));
  })()`)
  if (!focusRings.length) ok('every control class carries a :focus-visible rule')
  else bad('no focus ring for: ' + focusRings.join(', '))

  // --- save view round-trips through a reload
  await evaluate(`document.querySelector('input[data-status=${q(statusToTest)}]').click();
    document.getElementById('save-view').click();
    document.querySelector('.nav-item[data-view="files"]').click()`)
  const stored = await evaluate(`localStorage.getItem('groundcheck:view:' + ${q(facts.headSha)})`)
  const parsed = stored ? JSON.parse(stored) : null
  if (parsed && parsed.status[statusToTest] === false && parsed.view === 'files')
    ok('Save view persists filters and the active view, keyed by headSha')
  else bad('save view stored: ' + stored)

  await send('Page.reload', { ignoreCache: true })
  await sleep(1200)
  const restored = await evaluate(`(() => ({
    view: document.getElementById('shell').dataset.view,
    box: document.querySelector('input[data-status=${q(statusToTest)}]').checked,
    faded: document.querySelectorAll('.node[data-status=${q(statusToTest)}].filtered').length,
    total: document.querySelectorAll('.node[data-status=${q(statusToTest)}]').length,
  }))()`)
  if (restored.view === 'files' && restored.box === false && restored.faded === restored.total)
    ok('reload restores the saved view and re-applies its filters')
  else bad('restore: ' + JSON.stringify(restored))
  await evaluate("localStorage.clear()")

  // --- reduced motion, asserted against the live stylesheet
  const rm = await evaluate(`[...document.styleSheets].flatMap(s => { try { return [...s.cssRules] } catch (e) { return [] } })
    .some(r => r.conditionText && r.conditionText.includes('prefers-reduced-motion'))`)
  if (rm) ok('prefers-reduced-motion rule is live in the stylesheet'); else bad('reduced-motion rule missing')

  console.log(`  --- ${pass} ok, ${fail} fail, ${skip} n/a`)
  ws.close()
  chrome.kill()
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
