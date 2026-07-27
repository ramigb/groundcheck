#!/usr/bin/env bash
# groundcheck test harness. Usage: bash tests/run.sh [determinism|fixture|exitcodes|all]
# Run from the package root. Requires bash, git, jq, node >= 22.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RANGE="main..fixture/wishlist"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FIXTURE="$WORK/storefront"
git clone -q "$ROOT/fixtures/storefront.bundle" "$FIXTURE" || {
  echo "could not materialize fixtures/storefront.bundle" >&2
  exit 2
}
git -C "$FIXTURE" branch main origin/main > /dev/null || {
  echo "could not restore the fixture's main branch" >&2
  exit 2
}

pass=0
fail=0
ok()   { echo "  ok   $1"; pass=$((pass + 1)); }
bad()  { echo "  FAIL $1"; fail=$((fail + 1)); }
check_exit() { # check_exit <expected> <actual> <label>
  if [ "$2" = "$1" ]; then ok "$3 (exit $2)"; else bad "$3 (expected exit $1, got $2)"; fi
}

build() { node "$ROOT/scripts/build-slice.ts" --repo "$FIXTURE" --range "$RANGE" --out "$1"; }

t_determinism() {
  echo "determinism:"
  build "$WORK/a.json" 2>/dev/null
  build "$WORK/b.json" 2>/dev/null
  jq 'del(.generated)' "$WORK/a.json" > "$WORK/a.stripped.json"
  jq 'del(.generated)' "$WORK/b.json" > "$WORK/b.stripped.json"
  if diff -q "$WORK/a.stripped.json" "$WORK/b.stripped.json" > /dev/null; then
    ok "two runs byte-identical after del(.generated)"
  else
    bad "two runs differ"; diff "$WORK/a.stripped.json" "$WORK/b.stripped.json" | head -20
  fi
  # generated must be the only place nondeterminism lives
  if jq -e '.generated.at and .generated.headSha and .generated.toolVersions.node' "$WORK/a.json" > /dev/null; then
    ok "generated block carries at/headSha/toolVersions"
  else
    bad "generated block incomplete"
  fi
}

t_fixture() {
  echo "fixture equality + shape:"
  build "$WORK/slice.json" 2>/dev/null
  node "$ROOT/tests/check-slice-shape.ts" "$WORK/slice.json" 2>/dev/null && ok "structural self-check" || bad "structural self-check"
  jq 'del(.generated)' "$WORK/slice.json" > "$WORK/got.json"
  jq 'del(.generated)' "$ROOT/tests/expected-slice.json" > "$WORK/want.json"
  if diff -q "$WORK/want.json" "$WORK/got.json" > /dev/null; then
    ok "matches tests/expected-slice.json"
  else
    bad "differs from tests/expected-slice.json"; diff "$WORK/want.json" "$WORK/got.json" | head -40
  fi
}

t_exitcodes() {
  echo "exit codes:"
  node "$ROOT/scripts/build-slice.ts" --repo "$FIXTURE" --range "$RANGE" --out "$WORK/ok.json" > /dev/null 2>&1
  check_exit 0 $? "valid range"

  node "$ROOT/scripts/build-slice.ts" --repo "$FIXTURE" --range "main" --out "$WORK/x.json" > /dev/null 2>&1
  check_exit 2 $? "range without .."

  node "$ROOT/scripts/build-slice.ts" --repo "$FIXTURE" --range "main..main" --out "$WORK/x.json" > /dev/null 2>&1
  check_exit 2 $? "empty range"

  node "$ROOT/scripts/build-slice.ts" --repo "$FIXTURE" --range "main..no-such-ref" --out "$WORK/x.json" > /dev/null 2>&1
  check_exit 2 $? "unresolvable ref"

  node "$ROOT/scripts/build-slice.ts" --repo "$FIXTURE" --range "fixture/wishlist..main" --out "$WORK/x.json" > /dev/null 2>&1
  check_exit 2 $? "worktree not at range head"

  node "$ROOT/scripts/build-slice.ts" --repo "$FIXTURE" --range "$RANGE" > /dev/null 2>&1
  check_exit 2 $? "missing --out"

  # project load failure: a git repo with commits but no tsconfig.json
  local notproj="$WORK/notproj"
  mkdir -p "$notproj"
  ( cd "$notproj" && git init -q -b main \
    && echo one > a.txt && git add -A && git -c user.email=t@t -c user.name=t commit -qm one \
    && echo two > a.txt && git add -A && git -c user.email=t@t -c user.name=t commit -qm two ) > /dev/null 2>&1
  node "$ROOT/scripts/build-slice.ts" --repo "$notproj" --range "HEAD~1..HEAD" --out "$WORK/x.json" > /dev/null 2>&1
  check_exit 3 $? "no tsconfig.json"

  # every failure must print exactly one actionable stderr line
  local lines
  lines=$(node "$ROOT/scripts/build-slice.ts" --repo "$FIXTURE" --range "main" --out "$WORK/x.json" 2>&1 >/dev/null | grep -c .)
  if [ "$lines" -eq 1 ]; then ok "one-line stderr on failure"; else bad "stderr was $lines lines, want 1"; fi
}

render() { # render <slice> <annotations> <out>
  node "$ROOT/scripts/render-slice.ts" --slice "$1" --annotations "$2" --out "$3"
}
validate() { # validate <artifact> <slice> [annotations]
  if [ $# -ge 3 ]; then
    node "$ROOT/scripts/validate-slice.ts" --artifact "$1" --slice "$2" --annotations "$3"
  else
    node "$ROOT/scripts/validate-slice.ts" --artifact "$1" --slice "$2"
  fi
}

t_render() {
  echo "golden render:"
  build "$WORK/slice.json" 2>/dev/null
  render "$WORK/slice.json" "$ROOT/tests/annotations.json" "$WORK/review.html" 2>/dev/null \
    && ok "renders the fixture slice" || bad "render failed"
  validate "$WORK/review.html" "$WORK/slice.json" "$ROOT/tests/annotations.json" > "$WORK/v.jsonl" 2>/dev/null \
    && ok "validator passes the clean artifact" || { bad "validator rejected the clean artifact"; cat "$WORK/v.jsonl"; }

  # structural equivalence with the v0.2.0 golden (assets/shell-mock.png):
  # node count, edge count, flag count, ring count
  local nodes edges flags rings
  nodes=$(grep -c 'class="node ' "$WORK/review.html")
  edges=$(grep -c 'class="edge ' "$WORK/review.html")
  flags=$(jq '.flags|length' "$ROOT/tests/annotations.json")
  rings=$(grep -c 'class="ring r' "$WORK/review.html")
  [ "$nodes" = "10" ] && ok "10 nodes drawn" || bad "$nodes nodes drawn, expected 10"
  [ "$edges" = "11" ] && ok "11 edges drawn" || bad "$edges edges drawn, expected 11"
  [ "$flags" = "3" ]  && ok "3 attention flags" || bad "$flags flags, expected 3"
  [ "$rings" = "3" ]  && ok "3 epicenter rings" || bad "$rings ring circles, expected 3"

  # self-contained: no external scripts, no remote images
  if grep -Eq '<script[^>]+src=|<img[^>]+src=' "$WORK/review.html"; then
    bad "artifact loads an external resource"
  else
    ok "no external scripts or images"
  fi
  # the embedded slice must be byte-identical to the input
  if node -e '
      const fs = require("fs");
      const html = fs.readFileSync(process.argv[1], "utf8");
      const block = /<script type="application\/json" id="gc-slice">([\s\S]*?)<\/script>/.exec(html)[1];
      process.exit(block === fs.readFileSync(process.argv[2], "utf8") ? 0 : 1);
    ' "$WORK/review.html" "$WORK/slice.json"; then
    ok "embedded gc-slice is byte-equal to slice.json"
  else
    bad "embedded gc-slice differs from slice.json"
  fi
  # diff excerpts: present in the slice, rendered from it, capped at 8 lines
  jq -e '[.nodes[]|select(.status=="added" or .status=="modified" or .status=="deleted")|select((.excerpt|length) == 0)]|length == 0' "$WORK/slice.json" > /dev/null \
    && ok "every changed node carries a diff excerpt" || bad "a changed node has no excerpt"
  jq -e '[.nodes[]|select(.excerpt)|select(([.excerpt[]|select(.op != "gap")]|length) > 8)]|length == 0' "$WORK/slice.json" > /dev/null \
    && ok "excerpts respect the 8-line cap" || bad "an excerpt exceeds 8 lines"
  jq -e '[.nodes[]|select(.status=="blast")|select(has("excerpt"))]|length == 0' "$WORK/slice.json" > /dev/null \
    && ok "blast nodes carry no excerpt (why-flagged instead)" || bad "a blast node carries an excerpt"
  grep -q 'pre.diff{' "$WORK/review.html" && ok "artifact styles the contract diff block" || bad "diff block style missing"
  if node -e '
      const html = require("fs").readFileSync(process.argv[1], "utf8");
      process.exit(/<pre class="diff">/.test(html.replace(/<script[\s\S]*?<\/script>/g, "")) ? 1 : 0);
    ' "$WORK/review.html"; then
    ok "diff markup is built from the embedded slice, not baked in"
  else
    bad "artifact ships static diff markup"
  fi
  grep -q 'wishlisted?: boolean' "$WORK/review.html" \
    && ok "the added Product line is readable in the artifact" || bad "excerpt text missing from the artifact"

  # the artifact's own script must at least parse (no browser in CI)
  node -e '
      const fs = require("fs");
      const html = fs.readFileSync(process.argv[1], "utf8");
      const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
      if (blocks.length !== 1) { console.error("expected exactly one behaviour script, got " + blocks.length); process.exit(1); }
      new Function(blocks[0]);
    ' "$WORK/review.html" && ok "artifact script parses" || bad "artifact script does not parse"
  # renderer refuses a slice with no layout for a node
  jq '.layout |= with_entries(select(.key != "styles/tokens.ts#tokens"))' "$ROOT/tests/annotations.json" > "$WORK/no-layout.json"
  render "$WORK/slice.json" "$WORK/no-layout.json" "$WORK/x.html" > /dev/null 2>&1
  check_exit 2 $? "renderer refuses a missing layout entry"
}

t_mutations() {
  echo "mutation battery:"
  build "$WORK/slice.json" 2>/dev/null
  render "$WORK/slice.json" "$ROOT/tests/annotations.json" "$WORK/review.html" 2>/dev/null
  node "$ROOT/tests/mutations/apply.ts" --artifact "$WORK/review.html" --outdir "$WORK/mutants" > /dev/null || { bad "could not seed mutants"; return; }

  # each mutant must be rejected, and rejected by the check it was built to trip
  local -a expected=(
    "a-node-dropped:node-missing"
    "b-node-fabricated:node-fabricated"
    "c-status-flipped:node-status"
    "d-edge-dropped:edge-missing"
    "e-note-dangling:annotation-dangling"
    "f-rects-overlap:layout-overlap"
    "g-slice-tampered:embedded-slice"
    "h-orphan-omitted:annotation-orphan-missing"
    "i-criterion-status-flipped:design-criteria"
    "j-metric-understated:design-metrics"
  )
  local entry name check out code
  for entry in "${expected[@]}"; do
    name="${entry%%:*}"; check="${entry##*:}"
    out=$(validate "$WORK/mutants/$name.html" "$WORK/slice.json" 2>/dev/null)
    code=$?
    if [ "$code" = "0" ]; then
      bad "$name PASSED validation (false pass — P0)"
    elif echo "$out" | grep -q "\"check\":\"$check\""; then
      ok "$name rejected by $check"
    else
      bad "$name rejected, but not by $check: $(echo "$out" | head -1)"
    fi
  done

  validate "$WORK/review.html" "$WORK/slice.json" > /dev/null 2>&1
  check_exit 0 $? "clean artifact still passes"
}

t_tsconfig() {
  echo "--tsconfig (monorepo / solution-style root):"
  node "$ROOT/scripts/build-slice.ts" --repo "$FIXTURE" --range "$RANGE" --tsconfig "$FIXTURE/tsconfig.json" --out "$WORK/ts-explicit.json" 2>/dev/null
  check_exit 0 $? "explicit --tsconfig"
  build "$WORK/ts-default.json" 2>/dev/null
  if diff -q <(jq 'del(.generated)' "$WORK/ts-default.json") <(jq 'del(.generated)' "$WORK/ts-explicit.json") > /dev/null; then
    ok "explicit --tsconfig matches the default lookup"
  else
    bad "explicit --tsconfig changed the output"
  fi

  # a solution-style root config (files: [] + references) resolves zero files
  local mono="$WORK/mono"
  mkdir -p "$mono/pkg/src"
  printf '{\n  "files": [],\n  "references": [{ "path": "./pkg" }]\n}\n' > "$mono/tsconfig.json"
  printf '{\n  "compilerOptions": { "target": "ES2022", "strict": true, "noEmit": true },\n  "include": ["src"]\n}\n' > "$mono/pkg/tsconfig.json"
  printf 'export const seed = 1\n' > "$mono/pkg/src/seed.ts"
  ( cd "$mono" && git init -q -b main && git add -A \
    && git -c user.email=t@t -c user.name=t commit -qm one \
    && printf 'export const seed = 2\nexport const extra = 3\n' > pkg/src/seed.ts && git add -A \
    && git -c user.email=t@t -c user.name=t commit -qm two ) > /dev/null 2>&1

  local out
  out=$(node "$ROOT/scripts/build-slice.ts" --repo "$mono" --range "HEAD~1..HEAD" --out "$WORK/x.json" 2>&1 >/dev/null)
  check_exit 3 $? "solution-style root config"
  if echo "$out" | grep -q -- "--tsconfig"; then ok "error names --tsconfig as the fix"; else bad "error does not mention --tsconfig: $out"; fi

  node "$ROOT/scripts/build-slice.ts" --repo "$mono" --range "HEAD~1..HEAD" --tsconfig "$mono/pkg/tsconfig.json" --out "$WORK/mono.json" > /dev/null 2>&1
  check_exit 0 $? "--tsconfig points at the package project"
  node "$ROOT/tests/check-slice-shape.ts" "$WORK/mono.json" > /dev/null 2>&1 && ok "monorepo slice is well-formed" || bad "monorepo slice failed the shape check"
  jq -e '.generated.tsconfig|endswith("pkg/tsconfig.json")' "$WORK/mono.json" > /dev/null \
    && ok "slice records which tsconfig produced it" || bad "generated.tsconfig not recorded"

  # a second changed package that the chosen config does not cover: the changed
  # file cannot be analysed, and that must be loud, not a quietly smaller slice
  mkdir -p "$mono/other/src"
  printf '{\n  "compilerOptions": { "target": "ES2022", "strict": true, "noEmit": true },\n  "include": ["src"]\n}\n' > "$mono/other/tsconfig.json"
  printf 'export const other = 1\n' > "$mono/other/src/other.ts"
  ( cd "$mono" && git add -A && git -c user.email=t@t -c user.name=t commit -qm three \
    && printf 'export const other = 2\nexport const extra = 3\n' > other/src/other.ts \
    && printf 'export const seed = 4\n' > pkg/src/seed.ts && git add -A \
    && git -c user.email=t@t -c user.name=t commit -qm four ) > /dev/null 2>&1

  local warn
  warn=$(node "$ROOT/scripts/build-slice.ts" --repo "$mono" --range "HEAD~1..HEAD" --tsconfig "$mono/pkg/tsconfig.json" --out "$WORK/partial.json" 2>&1 >/dev/null)
  check_exit 0 $? "under-scoped --tsconfig still produces a slice"
  if echo "$warn" | grep -q "outside"; then ok "warns that a changed file is outside the project"; else bad "no warning: $warn"; fi
  jq -e '.excluded.count == 1 and (.excluded.files[0] == "other/src/other.ts")' "$WORK/partial.json" > /dev/null \
    && ok "the uncovered file is recorded in excluded[]" || bad "excluded[] does not name the uncovered file"

  # and the artifact has to admit it
  printf '{\n  "annotations": "0.1.0",\n  "for": { "range": "HEAD~1..HEAD", "headSha": %s },\n  "orphans": [],\n  "flags": [],\n  "notes": {},\n  "risk": {},\n  "readingOrder": [],\n  "layout": { %s: { "x": 440, "y": 300 } }\n}\n' \
    "$(jq '.generated.headSha' "$WORK/partial.json")" "$(jq '.nodes[0].id' "$WORK/partial.json")" > "$WORK/partial-ann.json"
  render "$WORK/partial.json" "$WORK/partial-ann.json" "$WORK/partial.html" > /dev/null 2>&1
  grep -q '1 changed files outside the TS project' "$WORK/partial.html" \
    && ok "badge reports the excluded file" || bad "badge hides the excluded file"
  local pv
  pv=$(jq '.excluded.count = 0 | .excluded.files = []' "$WORK/partial.json" > "$WORK/partial-lying.json"; validate "$WORK/partial.html" "$WORK/partial-lying.json" 2>/dev/null)
  if echo "$pv" | grep -q '"check":"embedded-slice"'; then
    ok "a slice that under-reports exclusions fails byte-equality"
  else
    bad "under-reported exclusions were accepted"
  fi
}

t_worktree() {
  echo "--worktree (uncommitted PR):"
  local wt="$WORK/wt"
  git clone -q "$FIXTURE" "$wt" 2>/dev/null
  ( cd "$wt" && git checkout -q main ) 2>/dev/null
  # modify a tracked file and add an untracked one, commit nothing
  cp "$FIXTURE/src/hooks/useWishlist.ts" "$wt/src/hooks/useWishlist.ts"
  printf "import type { Money } from '../types/product'\n\nconst locale = 'en-US'\n\nexport function formatPrice(m: Money) {\n  return new Intl.NumberFormat(locale, { currency: m.cur }).format(m.amount)\n}\n" > "$wt/src/lib/format.ts"

  node "$ROOT/scripts/build-slice.ts" --repo "$wt" --range "main.." --out "$WORK/x.json" > /dev/null 2>&1
  check_exit 2 $? "range with an empty head needs --worktree"

  node "$ROOT/scripts/build-slice.ts" --repo "$wt" --range "main.." --worktree --out "$WORK/wt.json" > /dev/null 2>&1
  check_exit 0 $? "--worktree with 0 commits ahead"
  node "$ROOT/tests/check-slice-shape.ts" "$WORK/wt.json" > /dev/null 2>&1 && ok "worktree slice is well-formed" || bad "worktree slice failed the shape check"

  local ids
  ids=$(jq -r '[.nodes[].id]|join(",")' "$WORK/wt.json")
  case "$ids" in
    *"lib/format.ts#formatPrice"*) ok "modified tracked file is a node" ;;
    *) bad "modified tracked file missing from $ids" ;;
  esac
  case "$ids" in
    *"hooks/useWishlist.ts#useWishlist"*) ok "untracked file is a node" ;;
    *) bad "untracked file missing from $ids" ;;
  esac
  jq -e '.generated.headSha|endswith("+worktree")' "$WORK/wt.json" > /dev/null \
    && ok "headSha marked +worktree (head is not a commit)" || bad "headSha does not record the worktree state"
  jq -e '.generated.range == "main..worktree"' "$WORK/wt.json" > /dev/null \
    && ok "range recorded as main..worktree" || bad "range not recorded as main..worktree"

  # determinism holds for an uncommitted tree too
  node "$ROOT/scripts/build-slice.ts" --repo "$wt" --range "main.." --worktree --out "$WORK/wt2.json" > /dev/null 2>&1
  diff -q <(jq 'del(.generated)' "$WORK/wt.json") <(jq 'del(.generated)' "$WORK/wt2.json") > /dev/null \
    && ok "two worktree runs byte-identical" || bad "worktree runs differ"
}

t_ungraphed() {
  echo "ungraphed changed files:"
  local repo="$WORK/ungraphed-repo"
  mkdir -p "$repo/src"
  printf '{\n  "compilerOptions": { "target": "ES2022", "strict": true, "noEmit": true },\n  "include": ["src"]\n}\n' > "$repo/tsconfig.json"
  printf 'export const ready = true\n' > "$repo/src/main.ts"
  printf '.button { color: gray; }\n' > "$repo/src/app.css"
  printf '{ "theme": "gray" }\n' > "$repo/settings.json"
  printf '# Legacy settings\n\nRemove me.\n' > "$repo/legacy.md"
  ( cd "$repo" && git init -q && git add -A \
    && git -c user.email=t@t -c user.name=t commit -qm baseline \
    && printf '.button { color: hotpink; }\n' > src/app.css \
    && printf '{ "theme": "hotpink", "enabled": true }\n' > settings.json \
    && rm legacy.md \
    && git add -A && git -c user.email=t@t -c user.name=t commit -qm styling ) > /dev/null 2>&1

  node "$ROOT/scripts/build-slice.ts" --repo "$repo" --range "HEAD~1..HEAD" --out "$WORK/ungraphed.json" > /dev/null 2>&1
  check_exit 0 $? "non-TypeScript-only range builds"
  node "$ROOT/tests/check-slice-shape.ts" "$WORK/ungraphed.json" > /dev/null 2>&1 \
    && ok "ungraphed slice is well-formed" || bad "ungraphed slice failed the shape check"
  node -e 'const s=require(process.argv[1]); process.exit(s.nodes.length === 0 ? 0 : 1)' "$WORK/ungraphed.json" \
    && ok "non-TypeScript files create no graph nodes" || bad "non-TypeScript files leaked into the graph"
  node -e 'const s=require(process.argv[1]); process.exit(JSON.stringify(s.ungraphed.map(f=>f.file)) === JSON.stringify(["legacy.md","settings.json","src/app.css"]) ? 0 : 1)' "$WORK/ungraphed.json" \
    && ok "CSS, JSON, and Markdown changes are listed deterministically" || bad "ungraphed files missing or unsorted"
  node -e 'const s=require(process.argv[1]); process.exit(s.ungraphed.every(f=>f.excerpt?.length) ? 0 : 1)' "$WORK/ungraphed.json" \
    && ok "ungraphed text files carry diff excerpts" || bad "an ungraphed text diff is missing"
  node -e 'const s=require(process.argv[1]); const f=s.ungraphed.find(f=>f.file==="legacy.md"); process.exit(f?.status==="deleted" && f.excerpt.some(l=>l.op==="del") ? 0 : 1)' "$WORK/ungraphed.json" \
    && ok "deleted ungraphed files retain their diff" || bad "deleted ungraphed diff is missing"

  local head
  head=$(node -e 'process.stdout.write(require(process.argv[1]).generated.headSha)' "$WORK/ungraphed.json")
  printf '{\n  "annotations": "0.1.0",\n  "for": { "range": "HEAD~1..HEAD", "headSha": "%s" },\n  "orphans": [],\n  "flags": [],\n  "notes": {},\n  "risk": {},\n  "readingOrder": [],\n  "layout": {}\n}\n' "$head" > "$WORK/ungraphed-ann.json"
  render "$WORK/ungraphed.json" "$WORK/ungraphed-ann.json" "$WORK/ungraphed.html" > /dev/null 2>&1
  check_exit 0 $? "zero-node slice renders"
  validate "$WORK/ungraphed.html" "$WORK/ungraphed.json" "$WORK/ungraphed-ann.json" > /dev/null 2>&1
  check_exit 0 $? "ungraphed artifact validates"
  [ "$(grep -c 'class=\"file-row ungraphed\"' "$WORK/ungraphed.html")" = "3" ] \
    && ok "Files view renders every ungraphed row" || bad "Files view lost an ungraphed row"
  grep -q 'color: hotpink' "$WORK/ungraphed.html" \
    && ok "CSS diff is carried into the artifact" || bad "CSS diff is not inspectable"
  grep -q 'id="m-files">3<' "$WORK/ungraphed.html" \
    && ok "Files changed metric includes ungraphed files" || bad "Files changed metric omits ungraphed files"
  node -e '
    const fs = require("fs");
    const html = fs.readFileSync(process.argv[1], "utf8");
    const dropped = html.replace(/<tr class="file-row ungraphed"[^>]*data-file="settings\.json"[\s\S]*?<\/tr>/, "");
    fs.writeFileSync(process.argv[2], dropped);
  ' "$WORK/ungraphed.html" "$WORK/ungraphed-dropped.html"
  local dropped_out
  dropped_out=$(validate "$WORK/ungraphed-dropped.html" "$WORK/ungraphed.json" 2>/dev/null)
  if echo "$dropped_out" | grep -q '"check":"ungraphed-missing"'; then
    ok "validator rejects a dropped ungraphed row"
  else
    bad "validator accepted a dropped ungraphed row"
  fi
}

t_collapse() {
  echo "--collapse dir keeps symbol-level facts:"
  node "$ROOT/scripts/build-slice.ts" --repo "$FIXTURE" --range "$RANGE" --collapse dir --out "$WORK/dc.json" 2>/dev/null
  node "$ROOT/tests/check-slice-shape.ts" "$WORK/dc.json" > /dev/null 2>&1 && ok "collapsed slice is well-formed" || bad "collapsed slice failed the shape check"
  jq -e '[.nodes[]|select((.members|length) == 0)]|length == 0' "$WORK/dc.json" > /dev/null \
    && ok "every collapsed node carries its members" || bad "a collapsed node has no members"
  jq -e '[.nodes[]|select(.stats.added != ([.members[].stats.added]|add))]|length == 0' "$WORK/dc.json" > /dev/null \
    && ok "member stats sum to the collapsed node" || bad "member stats do not sum"

  render "$WORK/dc.json" "$ROOT/tests/annotations-collapsed.json" "$WORK/collapsed.html" 2>/dev/null \
    && ok "renders a collapsed slice" || bad "collapsed render failed"
  validate "$WORK/collapsed.html" "$WORK/dc.json" "$ROOT/tests/annotations-collapsed.json" > "$WORK/cv.jsonl" 2>/dev/null \
    && ok "validator accepts member-keyed notes and a member orphan" || { bad "collapsed artifact rejected"; cat "$WORK/cv.jsonl"; }
  grep -q 'lib/format.ts#formatPrice' "$WORK/collapsed.html" \
    && ok "member symbol appears in the artifact" || bad "collapsed artifact lost the member symbol"

  # criteria and layout must name drawn nodes, not members
  jq '(.criteria[0].nodes) = ["lib/format.ts#formatPrice"]' "$ROOT/tests/annotations-collapsed.json" > "$WORK/member-criterion.json"
  render "$WORK/dc.json" "$WORK/member-criterion.json" "$WORK/mc.html" 2>/dev/null
  local mc_out
  mc_out=$(validate "$WORK/mc.html" "$WORK/dc.json" 2>/dev/null)
  if echo "$mc_out" | grep -q '"check":"annotation-dangling"'; then
    ok "criterion naming a member is rejected"
  else
    bad "criterion naming a member was accepted"
  fi
}

t_large() {
  echo "large-slice automatic layout:"
  local out
  if out=$(node "$ROOT/tests/check-large-layout.ts" 2>&1); then
    ok "$out"
  else
    bad "$out"
  fi
}

# The contract's interaction clauses (view switching, fade-not-remove, keyboard,
# saved view) cannot be checked by reading markup, so they are driven in a real
# browser. Skips cleanly when no browser is installed; never silently.
t_interaction() {
  echo "interaction battery (headless browser):"
  build "$WORK/slice.json" 2>/dev/null
  render "$WORK/slice.json" "$ROOT/tests/annotations.json" "$WORK/review.html" 2>/dev/null
  local out
  out=$(node "$ROOT/tests/interaction/drive-artifact.js" "$WORK/review.html" "$WORK/chrome-profile" 2>&1)
  echo "$out" | sed 's/^/  /' | grep -v '^  *--- ' || true
  if echo "$out" | grep -q 'skip interaction battery'; then
    ok "interaction battery skipped (no browser); contract clauses unverified here"
  elif echo "$out" | grep -q ' FAIL '; then
    bad "interaction battery reported failures"
  elif echo "$out" | grep -q ' ok   '; then
    ok "interaction battery clean"
  else
    bad "interaction battery produced no result"
  fi
}

main() {
  case "${1:-all}" in
    determinism) t_determinism ;;
    fixture)     t_fixture ;;
    exitcodes)   t_exitcodes ;;
    render)      t_render ;;
    mutations)   t_mutations ;;
    tsconfig)    t_tsconfig ;;
    worktree)    t_worktree ;;
    ungraphed)   t_ungraphed ;;
    collapse)    t_collapse ;;
    large)       t_large ;;
    interaction) t_interaction ;;
    all)         t_determinism; t_fixture; t_exitcodes; t_render; t_mutations; t_tsconfig; t_worktree; t_ungraphed; t_collapse; t_large; t_interaction ;;
    *) echo "usage: run.sh [determinism|fixture|exitcodes|render|mutations|tsconfig|worktree|ungraphed|collapse|large|interaction|all]"; exit 2 ;;
  esac
  echo "$pass passed, $fail failed"
  [ "$fail" -eq 0 ]
}
main "$@"
