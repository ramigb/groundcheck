# groundcheck

An agent-agnostic skill that turns a git range into a single self-contained HTML
review artifact: the diff-scoped dependency graph with computed blast radius, an
acceptance-criteria coverage map, and a short list of attention flags. It works
with any coding agent that can read and write files and run shell commands; the
workflow has no vendor-specific agent or API dependency.

The point is to minimize human attention per verified change — and to make an
artifact that cannot lie. Every node, edge, and status is computed by a script
from git plus the TypeScript type checker. The model's judgment lives in a
separate file, is rendered in a distinct register, and is machine-checked for
dangling references before you ever see it.

## Features

- **Computed blast radius.** Changed symbols are followed through the TypeScript
  type checker's reference search (`--depth`, default 1) to the nodes that
  consume them. Every edge carries `file:line` evidence.
- **Every changed file stays visible.** CSS, JSON, Markdown, configuration,
  declarations, and other files outside the dependency graph appear as
  `not graphed` rows with status, stats, spans, and a selectable textual diff
  excerpt when Git provides one.
- **Typed edges.** `renders`, `consumes-type`, `calls`, `imports`, `uses-token` —
  so "this touches the cart" and "this imports the cart's type" read differently.
- **Epicenter detection.** The changed nodes with the most incoming edges (2+)
  are named as epicenters; with no such node the artifact says so instead of
  picking one.
- **Five views.** Overview, Files, Graph, Acceptance Criteria and Attention Flags
  share one shell; the detail panel (Summary / Diff / Notes) persists across them,
  so a node is always read in the same place.
- **Intent layer.** Acceptance criteria render as a Passed/Failed table with a
  progress ring; clicking a row isolates the nodes it matched. Changed nodes
  matching no criterion render as `Unmatched` rows — "approve or revert,
  explicitly".
- **Filters that cannot hide anything.** Status and change-type filters, search,
  and the focus toggles all *fade*; nothing removes a node from the document, and
  the validator asserts the mechanism, not just the count.
- **Two visual registers.** Computed facts and model judgment are styled
  distinctly (reviewer notes carry a violet rule), and the validator checks the
  distinction survives rendering.
- **Attention flags and reading order.** At most 5 flags, each a jump target;
  plus an epicenter-first reading order.
- **Per-node panel.** Diff excerpt straight from git (max 8 lines + gap marker),
  changed spans, changed exported symbols, consumer count, risk and orphan pills.
- **Honesty metrics.** The `In graph` / `Not shown` topbar cards, the
  changed-files-outside-the-TS-project card, and the tsconfig that produced the
  facts are all on the face of the artifact, and the validator checks each against
  `slice.json`. A narrow slice cannot pass as a full one.
- **Deterministic.** Two builds of the same range are byte-identical apart from
  the `generated` block. Verified by `tests/run.sh determinism`.
- **Fabrication-proof.** `validate-slice.ts` re-parses the rendered HTML and
  diffs it against `slice.json`: any invented or dropped node, edge, or
  ungraphed-file row, drifted status, or dangling annotation id is a violation.
  Mutation tests
  (`tests/mutations/`) prove each check actually catches its corruption.
- **Self-contained output.** One HTML file. Both JSON inputs are embedded in it,
  so the artifact carries its own provenance. No server, no network, no assets.
- **Keyboard and screen-reader accessible** nodes and rows (`tabindex`, `role`,
  `aria-label`, `aria-current`, `aria-selected`), every control focus-ringed and
  driven in a real browser by `tests/run.sh interaction`. Plus collapsed-directory
  mode for large diffs and support for uncommitted work via `--worktree`.
- **Saved view.** Filters, focus toggles and the active view persist to
  `localStorage`, keyed by `generated.headSha` so one slice never inherits
  another's view.

## Requirements

- bash, git, Node >= 22 (used for native TypeScript stripping)
- `jq` (test harness only)
- Target repo must be TypeScript/React with a resolvable tsconfig
- `npm install` (one runtime dep: `ts-morph`)

## Usage

Ask your coding agent, in a session where this skill is available:

- "review the PR on `feat/wishlist`"
- "did the agent do what I asked?"
- "groundcheck `main..feat/wishlist`"

The agent runs the three scripts below, writes `annotations.json`, and presents
`review.html`. Open it in a browser; no server, no assets, no network.

Agent products use different conventions for discovering skills. Point the
agent's skill or instruction mechanism at this directory (especially `SKILL.md`);
if it has no native skill mechanism, provide `SKILL.md` as repository
instructions. The workflow itself remains the same.

To run the pipeline by hand:

```bash
node scripts/build-slice.ts --repo <path> --range main..feat/wishlist --out slice.json
# then write annotations.json (schema: references/SLICE_FORMAT.md § Annotations)
node scripts/render-slice.ts --slice slice.json --annotations annotations.json --out review.html
node scripts/validate-slice.ts --artifact review.html --slice slice.json --annotations annotations.json
```

### Common variations

| Situation | Flag |
|---|---|
| Uncommitted work (0 commits ahead) | `--range <base>.. --worktree` |
| More than 20 nodes (renderer refuses) | `--collapse dir` |
| Monorepo / cross-package diff | `--tsconfig <one synthetic config>` (see SKILL.md § Monorepos) |
| Non-default token or route globs | `--tokens <glob>` `--routes <glob>` (repeatable) |
| Deeper blast radius | `--depth <n>` |
| Label the artifact with its PR | `--pr <n> [--pr-state open\|merged\|closed]` |

Acceptance criteria come from the user, or from a spec file in the repo
(`LOOP.md`, `AGENT_LOOP.md`, `SPEC.md`). With none, the intent layer renders
inactive and orphan detection is off. Criteria are never invented.

## Files

### The skill

| File | Role |
|---|---|
| `SKILL.md` | The portable skill instructions: trigger conditions, provenance rules, workflow, and monorepo handling. What the coding agent loads and follows. |
| `references/SLICE_FORMAT.md` | Schemas for `slice.json` and `annotations.json`, plus determinism rules. The contract between scripts and model. Read before writing annotations. |
| `references/DESIGN_CONTRACT.md` | Frozen visual system: palette, panel structure, layout constraints. Read before writing `layout{}`. Changes need a version bump and human sign-off. |
| `assets/shell-mock.png` | Golden visual-language reference from DESIGN_CONTRACT v0.2.0, retained by v0.3.0. |
| `assets/reference-mock.html` | Superseded v0.1.0 golden. Kept for history; it no longer describes the artifact. |

### The scripts

| File | Role |
|---|---|
| `scripts/build-slice.ts` | Facts. Reads git + the TS type checker via ts-morph, emits `slice.json`: nodes, ungraphed changed files, edges, statuses, blast depth, diff spans and excerpts. No judgment, no prose, no model calls. Deterministic apart from the `generated` block. Exit 2 = empty/invalid range, 3 = project load failure. |
| `scripts/render-slice.ts` | The only writer of HTML. Takes `slice.json` + `annotations.json`, emits one self-contained `review.html` (app shell per DESIGN_CONTRACT v0.3.0) with both JSON files embedded. Refuses over 20 graph nodes. |
| `scripts/validate-slice.ts` | The guard. Diffs the rendered artifact against the slice: fabricated or missing nodes, edges, and ungraphed files; status/kind drift; dangling annotation ids; layout constraints; palette and register checks. Exit 0 clean, 1 violations, 2 usage error. Must exit 0 before anything is presented. |

### The tests

| File | Role |
|---|---|
| `tests/run.sh` | Harness: `bash tests/run.sh [determinism\|fixture\|exitcodes\|render\|mutations\|tsconfig\|worktree\|ungraphed\|collapse\|all]`. |
| `tests/mutations/apply.ts` | Seeds known corruptions into a clean artifact so the validator can be tested for false passes. Each mutant is named for the check that must catch it. |
| `tests/check-slice-shape.ts` | Structural self-check of a `slice.json` against SLICE_FORMAT. |
| `tests/expected-slice.json`, `tests/golden/*.html` | Fixture expectations. |
| `fixtures/storefront/`, `fixtures/storefront.bundle` | Browsable checkout plus a self-contained Git bundle for the small React fixture. The test harness clones the bundle so `main..fixture/wishlist` works without embedding a nested `.git` directory in this repository. |

### Build history

`AGENT_LOOP.md` and `reports/` are the build record, not part of the runtime
skill. `reports/m3/` holds red-team artifacts (stretched criteria matches,
omitted orphans) used to check that the validator and the design catch a model
that shades the truth.

## Known limitations

- **TypeScript/React graph only.** Dependency nodes and blast radius come from
  one TypeScript program; every other changed file is still listed with its
  diff. No tsconfig, or a solution-style root config (`"files": []` +
  `references`) resolving zero files, exits 3.
- **One tsconfig per run, on purpose.** Loading package B's files under package
  A's options resolves B's path aliases wrongly, and an unresolved import raises
  no error — it just yields no edge, understating the blast radius silently.
  Cross-package diffs need a hand-written synthetic config. Scope mistakes are
  visible (`excluded.files` + badge) but you have to act on them.
- **20 drawn nodes maximum.** Past that the renderer refuses; `--collapse dir`
  trades symbol-level nodes for directory meta-nodes (members are still listed in
  the panel, but not drawn or laid out).
- **Static references only.** Dynamic imports, string-keyed lookups, DI
  containers, and runtime wiring produce no edges. The blast radius is a lower
  bound, never an upper one.
- **Layout is model-authored.** `annotations.json` supplies x,y per node; the
  validator only checks constraints. There is no auto-layout, so a bad narrative
  placement is a valid artifact.
- **Criteria matching is unverified judgment.** The UI labels it "model-matched"
  because that is all it is. A covered chip means a model saw a plausible match,
  not that the criterion is satisfied.
- **The worktree must be at the range head.** The type checker reads the working
  tree, not the commit objects, so a stale checkout yields facts about the wrong
  code.
- **Cap of 5 flags and 8 excerpt lines** by design. The artifact is a triage
  surface, not a complete account of the diff.

## Out of scope

- Bug hunting, correctness review, and security review. groundcheck routes
  attention; it does not judge whether the code works. Use `/code-review` or
  `/security-review` for that.
- Running tests, builds, or the app. Nothing here executes the changed code.
- Prose, docs, and design review.
- Dependency graphs for non-TypeScript languages, and monorepo auto-discovery
  of packages. Their changed files are still listed with diff excerpts.
- Any judgment sourced from the implementing agent's transcript or self-report —
  excluded deliberately, not unimplemented (see invariant 5).
- Multi-range or multi-PR comparison, history over time, and CI reporting. One
  range, one artifact, run locally.

## Invariants

1. `slice.json` is the territory. Only `build-slice.ts` writes it. Nodes,
   ungraphed files, edges, and statuses are never added, removed, renamed, or
   reclassified — not to declutter, not because they look wrong. Disagreement
   goes in a reviewer note.
2. Judgment lives only in `annotations.json`. It may reference node ids; it may
   never introduce structure.
3. Only `render-slice.ts` writes HTML. The artifact is never hand-edited.
4. `validate-slice.ts` exits 0 before anything is presented.
5. Fresh context: annotations are derived from the code alone, never from the
   implementing agent's transcript or self-report.
6. If `build-slice.ts` fails, that is the result. There is no fallback graph — a
   remembered one is worse than none.
7. If `excluded.count` is not 0, widen the tsconfig and re-run before
   annotating. Do not annotate around a hole.

## License

[MIT](LICENSE) © 2026 Rami GB.
