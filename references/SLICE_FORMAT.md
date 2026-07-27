# SLICE_FORMAT v0.6.0

The interchange contract between fact-producers (`build-slice.ts`), judgment
(`annotations.json`, model-written), and consumers (renderer, validator, and —
later — semantic_skeletonizer, which may emit the skeleton of the same slice as
agent context). Two files, one hard boundary:

- `slice.json` — computed facts. Script-written only. The territory.
- `annotations.json` — judgment. Model-written. References the territory,
  never extends it.

Versioning: semver on this document. Consumers must reject a `slice.json` whose
major version they don't know. Any field addition is a minor bump; any change to
determinism rules or enum semantics is major.

## slice.json

```jsonc
{
  "groundcheck": "0.6.0",
  "generated": {                       // ONLY nondeterministic data lives here
    "at": "2026-07-26T09:14:02Z",
    "repo": "storefront",
    "range": "main..feat/wishlist",
    "headSha": "9f31c02",
    "baseSha": "4be7710",
    "pr": { "number": 531, "state": "open" },  // only when --pr is passed
    "tsconfig": "tsconfig.json",     // which program produced these facts
    "toolVersions": { "node": "22.6.0", "ts-morph": "23.x" }
  },
  "epicenters": ["types/product.ts#Product"],
  "nodes": [
    {
      "id": "types/product.ts#Product",   // stable: repo-relative path [#symbol]
      "file": "src/types/product.ts",
      "symbol": "Product",                // absent for file-level nodes
      "kind": "type",                     // component | hook | type | token | route | module
      "status": "modified",               // added | modified | deleted | blast | context
      "spans": [{ "start": 12, "end": 17 }],  // changed line ranges; [] for blast/context
      "stats": { "added": 1, "removed": 0 },
      "exportedSymbolsChanged": ["Product"],
      "excerpt": [                         // changed nodes only; see § Diff excerpts
        { "op": "ctx", "text": "  price: Money" },
        { "op": "add", "text": "  wishlisted?: boolean" }
      ]
    }
  ],
  "ungraphed": [
    {
      "file": "src/styles/wishlist.css",
      "status": "modified",               // added | modified | deleted
      "spans": [{ "start": 8, "end": 10 }],
      "stats": { "added": 3, "removed": 1 },
      "excerpt": [                         // same computed diff format and cap
        { "op": "del", "text": "  color: gray;" },
        { "op": "add", "text": "  color: hotpink;" }
      ]
    }
  ],
  "edges": [
    {
      "from": "lib/api/products.ts",
      "to": "types/product.ts#Product",
      "type": "consumes-type",            // renders | consumes-type | calls | imports | uses-token
      "evidence": { "file": "src/lib/api/products.ts", "line": 41 }
    }
  ],
  "hidden": { "count": 41, "byKind": { "component": 18, "module": 15, "type": 8 } },
  "excluded": { "count": 0, "files": [] }   // changed TS files the program does not cover
}
```

`generated.headSha` is the short sha of the range head, except under `--worktree`
(analysing uncommitted work), where it is `<sha of HEAD>+worktree` and
`generated.range` reads `<base>..worktree`. The head of such a slice is not a
commit and the format says so rather than implying one.

### Pull request provenance — `generated.pr` (added in 0.5.0)

`--pr <n> [--pr-state open|merged|closed]` records which pull request a slice
describes, so the artifact can say `repo / PR #531` instead of a bare ref range.
It is provenance, not a fact about the code: nothing is derived from it, no
network call fetches it, and it lives in `generated` — the one block excluded
from the determinism comparison — so passing it cannot change any node, edge or
status. `state` defaults to `open`. Absent flag, the key is absent and
consumers fall back to `generated.range`.

### Diff excerpts — `excerpt` (added in 0.3.0)

DESIGN_CONTRACT § Panel structure requires a diff excerpt in the node view, and a
reviewer cannot review a change whose lines they cannot see. The excerpt is
therefore a **computed fact**, script-written, and rendered in the default
register — never in the reviewer-note register, and never authored by the model.

- Present on `added | modified | deleted` nodes only. `blast` and `context` nodes
  show "why flagged" instead, per the contract.
- `op` is `add | del | ctx | gap`; `text` is the diff line verbatim, without git's
  leading `+`/`-`/space.
- Source: `git diff -U2` for the same range, so the lines are git's, not a
  re-render of the file. Symbol nodes take the hunks whose changed lines intersect
  their `spans`; file-level nodes take every hunk in the file.
- Cap: 8 non-`gap` lines (contract). When more exist, one final
  `{"op":"gap"}` entry states how many lines were dropped and how many of those
  were changes — truncation is visible, not silent.
- Collapsed nodes have no excerpt of their own (`spans` is empty); their `members`
  carry theirs, and the renderer shows them inside the collapsed node's panel.
- Entries in `ungraphed[]` use the same excerpt rules. They represent changed
  files that have no dependency-graph node, so their diff remains reviewable
  without fabricating a graph relationship.

### Ungraphed changed files — `ungraphed` (added in 0.6.0)

Every changed file not represented by a graph node appears once in
`ungraphed[]`, sorted by repository-relative `file`. This includes CSS, JSON,
Markdown, configuration, declarations, binary files, and TypeScript files
outside the selected program. Each entry carries Git-derived status, spans,
stats, and—when Git provides textual hunks—an excerpt. Binary changes remain
listed with their stats and an explicit “no textual excerpt” state.

Ungraphed files:

- appear in the Files view and the `Files changed`, additions, and deletions
  metrics;
- can be selected to open their diff preview and Diff tab;
- never become nodes or edges and need no `annotations.layout` entry;
- are not addressable by node-keyed annotations or acceptance-criteria mapping.

An ungraphed TypeScript file outside the chosen program also remains in
`excluded.files`. `ungraphed` makes its change visible; `excluded` separately
discloses that dependency analysis is incomplete.

### Collapsed nodes — `members` (added in 0.2.0)

`--collapse dir` replaces per-symbol nodes with one meta-node per directory so a
large diff fits the 20-node render cap. Collapsing must not destroy the facts it
groups, so a meta-node carries them:

```jsonc
{
  "id": "components",                    // directory path, source-root relative
  "file": "src/components",
  "kind": "component",                   // members' kind if unanimous, else module
  "status": "modified",                  // worst of modified > added > deleted > blast > context
  "spans": [],
  "stats": { "added": 22, "removed": 0 },// sum over members (validator-checked)
  "exportedSymbolsChanged": ["ProductCard", "WishlistButton"],
  "members": [ /* the uncollapsed nodes, same shape, sorted by id, never nested */ ]
}
```

Members are **not drawn**, but they are addressable by judgment: `notes`, `risk`
and `orphans` in `annotations.json` may key on a member id, and the renderer shows
member facts (status, ±stats, changed lines, exported symbols) with any member
note inside the collapsed node's panel. `layout` and `criteria[].nodes` may **not**
name members — one positions a rect, the other drives chip isolation, and neither
can act on something that is not on the canvas.

### Status semantics

- `added | modified | deleted` — file (or symbol) appears in `git diff
  --name-status <range>`. Deleted nodes carry their base-revision metadata.
- `blast` — untouched in the range, but holds ≥ 1 reference to an
  `exportedSymbolsChanged` entry of a changed node. Depth 1 by default
  (`--depth` to extend; transitive nodes get `blastDepth: n`).
- `context` — untouched and unreferenced, included only when needed to connect
  the slice into one component (e.g. a shared parent). Use sparingly; the
  `hidden` counter is the honest home for everything else.

### Edge classification (reference algorithm)

For each reference to a changed exported symbol, classify by use-site:
JSX element position → `renders`; type position (annotations, generics,
`implements`, `satisfies`) → `consumes-type`; call expression of a function/hook
→ `calls`; member access on a token object (paths matched by `--tokens` glob,
default `**/tokens.{ts,js}`) → `uses-token`; bare import with no resolvable
use-site category → `imports`. One edge per (from, to, type); multiplicity goes
in `evidence` (first occurrence wins, count optional as `evidence.n`).

### Kind classification (reference heuristics)

`component`: exported PascalCase function in `.tsx` returning JSX. `hook`:
exported `use[A-Z]` function. `type`: interface / type alias / enum. `token`:
export from a `--tokens`-matched file. `route`: file under a `--routes` glob
(default `**/pages/**`, `**/app/**`). `module`: fallback.

### Determinism rules

Two runs on the same repo state and range must produce byte-identical output
after deleting the `generated` block. Therefore: nodes sorted by `id`,
ungraphed files by `file`, edges by (`from`, `to`, `type`), all object keys
emitted in schema order, arrays never reordered by traversal happenstance,
2-space indent, `\n` line endings, trailing newline, no floats. Timestamps and
tool versions may appear only inside `generated`. This rule is a validator
target and a CI gate, not a style note.

## annotations.json

```jsonc
{
  "annotations": "0.1.0",
  "for": { "range": "main..feat/wishlist", "headSha": "9f31c02" },  // must match slice
  "criteria": [
    {
      "id": "c1",
      "text": "Wishlist state persists across reloads",
      "source": "LOOP.md#acceptance",       // or "user"; never "inferred"
      "status": "covered",                  // covered | uncovered
      "nodes": ["hooks/useWishlist.ts#useWishlist"],
      "note": "localStorage-backed; verify key naming and SSR guard."
    }
  ],
  "orphans": ["lib/format.ts#formatPrice"],
  "flags": [
    {
      "n": 1,
      "target": { "node": "lib/api/products.ts" },   // or { "criterion": "c3" }
      "text": "serializeProduct() never reads wishlisted; state won't survive the API boundary."
    }
  ],
  "notes": { "lib/api/products.ts": "Highest-value place to look first. ..." },
  "risk":  { "lib/api/products.ts": "high" },
  "readingOrder": ["types/product.ts#Product", "lib/api/products.ts", "..."],
  "layout": { "types/product.ts#Product": { "x": 455, "y": 300 } }
}
```

Hard constraints (validator-enforced): every referenced node id exists in
`slice.json`; `for.headSha` matches; `layout` covers every node exactly once and
satisfies the geometry rules in DESIGN_CONTRACT § Layout; `flags` ≤ 5; `criteria`
present only when a criteria source exists; `orphans` ⊆ changed nodes.

An orphan is *defined* as a changed node mapped to no criterion, so the validator
enforces the equality, not just the subset: a changed node that is neither mapped
nor declared an orphan is a violation (`annotation-orphan-missing`), and so is an
orphan that is also mapped. On a collapsed slice, a meta-node is accounted for if
it or any of its members is mapped or declared. This is what stops "present this
change favorably" from silently dropping the ⚠ chip.

Explicitly NOT in slice.json: prose, risk, layout, criteria, ordering hints —
judgment is quarantined in annotations by construction, so the renderer can style
the two registers differently and the validator can tell them apart.

## Changelog

- **0.6.0** — added top-level `ungraphed`: every changed file without a graph
  node is listed with Git-derived status, spans, stats, and a textual diff
  excerpt when available. Non-TypeScript-only ranges in a TypeScript project now
  produce reviewable artifacts with zero graph nodes instead of exiting 2.

- **0.4.0** — added `generated.tsconfig` (the program that produced the facts) and
  top-level `excluded` (changed TypeScript files the program does not cover, with
  their paths). In a monorepo the tsconfig decides the graph's scope, so a slice
  is neither reproducible nor honest without both: `excluded.count > 0` means the
  slice is partial and says so, in the file and in the artifact's badge.

- **0.3.0** — added `nodes[].excerpt`: the diff lines DESIGN_CONTRACT's node view
  asks for, as computed facts (`git diff -U2`, ≤ 8 lines + a gap marker). Closes
  the gap that made the panel unreadable without a terminal.
- **0.2.0** — added `nodes[].members` (facts of the nodes a `--collapse dir`
  meta-node stands for); `generated.headSha` may carry a `+worktree` suffix with
  `generated.range` ending in `..worktree` when the head is uncommitted work.
  Both are field/value additions: no consumer of 0.1.0 breaks, and a 0.1.0
  producer still satisfies 0.2.0 consumers.
- **0.1.0** — initial format.
