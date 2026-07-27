---
name: groundcheck
description: >
  Generate a visual review slice (interactive HTML) for a git range — typically a PR
  branch or an agent's recent changes — in a TypeScript/React repo. Use this skill
  with any coding agent whenever the user asks to review a PR, review a branch,
  verify what an agent changed, check a diff's blast radius, audit agent work
  against a spec's acceptance criteria, or says "groundcheck", "review slice", or
  "ground this change". Use it even if they only say "did the agent do what I
  asked?" — that is exactly what this skill answers. Do NOT use for non-TypeScript
  repos or for reviewing prose/docs. Requires bash, Node 22 or newer, git, and a
  resolvable tsconfig; it does not depend on vendor-specific agent tools or APIs.
---

# groundcheck — visual review slices for agent-made changes

Run this workflow with any coding agent that can read and write repository files
and execute shell commands. All durable operations are implemented by the bundled
scripts; no step requires a vendor-specific agent tool.

Produces a single self-contained HTML artifact showing: (1) the diff-scoped
dependency graph with computed blast radius, (2) every other changed file with a
reviewable textual diff excerpt when available, (3) the acceptance-criteria
coverage map, and (4) a short list of attention flags. The purpose of the
artifact is to minimize human attention per verified change — every decision
below serves that.

## Provenance rules (non-negotiable)

The value of this artifact is that it cannot lie about facts. These rules are the
entire product. If following them produces a worse-looking artifact, follow them.

1. `slice.json` is the territory. It is produced only by `scripts/build-slice.ts`.
   You never add, remove, rename, or reclassify a node, ungraphed file, edge,
   status, or span — not to simplify, not to declutter, not because you believe
   it is wrong. If you believe the slice is wrong, say so in a reviewer note and
   in your final report.
2. Your judgment lives only in `annotations.json`. It may reference existing node
   ids; it may never introduce structure.
3. Only `scripts/render-slice.ts` writes HTML. You never hand-edit the artifact.
4. `scripts/validate-slice.ts` must exit 0 before you present anything. On failure,
   fix `annotations.json` or re-run the renderer. Three failed attempts → stop and
   report the failure honestly. Never present an unvalidated artifact.
5. Fresh-context rule: run this skill from the repo, the git range, and the
   criteria source only. Do not consume the implementing agent's transcript,
   summaries, or self-reports. If they appear in context, ignore them for
   annotation purposes — your notes must be derivable from the code alone.
6. If `build-slice.ts` fails (broken tsconfig, non-TS repo, empty range), report
   the failure. There is no fallback. A model-remembered graph is worse than no
   graph; do not draw one.

## Inputs

- `repo` — path to a git worktree.
- `range` — e.g. `main..feat/wishlist`. If the user gives a branch, range is
  `<default-branch>..<branch>`. If they say "the agent's last changes", use the
  merge-base of the working branch against the default branch.
- `criteria` — acceptance criteria, in priority order: an explicit list from the
  user; a spec file in the repo (`LOOP.md`, `AGENT_LOOP.md`, `SPEC.md` — look for
  an acceptance-criteria section); otherwise none. **Never invent criteria.** With
  none, the criteria table renders a single muted row: "no criteria provided —
  intent layer inactive", and orphan detection is disabled (everything would be an
  orphan; flagging that is noise, not signal).

  Criteria `id` renders verbatim in the table's ID column, so use ids a reviewer
  can cite — `1.1`, `2.3` — not `c1`. `status` is `covered` or `uncovered`
  only; the table renders them as Passed and Failed. There is no third state and
  no category field: do not invent either.

## Workflow

1. Resolve inputs. Confirm the range resolves to ≥ 1 commit, or use `--worktree`.
2. Build facts:
   `node scripts/build-slice.ts --repo <path> --range <range> --out slice.json`
   - The worktree must be checked out at the range head; the type checker reads
     the working tree. Uncommitted work (0 commits ahead, modified + untracked
     files) is a legitimate range: `--range <base>.. --worktree`.
   - Monorepo: see § Monorepos below. The root `tsconfig.json` is often
     solution-style (`"files": []` plus `references`), which resolves zero files
     and exits 3.
   - More than 20 nodes: the renderer uses a deterministic expanded canvas and
     shows a density warning (DESIGN_CONTRACT § Layout). Do not write
     `annotations.layout` for these slices; computed placement keeps every node
     and is independently checked by the validator. `--collapse dir` remains an
     optional directory-level summary, not a prerequisite for rendering.
   - Read every entry in `ungraphed[]` and its excerpt. These are real changed
     files kept out of the dependency graph, not ignorable exclusions. They need
     no layout entry and cannot be named by node-keyed annotations.
3. Read `slice.json`. Write `annotations.json` (schema in
   `references/SLICE_FORMAT.md`, § Annotations). This is the only creative step:
   - **criteria[]** — map each criterion to node ids with `covered | uncovered`.
     Matching is your judgment; the UI labels it "model-matched". A criterion with
     no plausible matching change is `uncovered` — never stretch a match.
   - **orphans** — changed nodes (`added|modified|deleted`) you could not map to
     any criterion. List them; do not excuse them.
   - **flags[]** — at most 5, ordered by expected review value. A good flag names
     a file, a mechanism, and a consequence ("serializer never reads `wishlisted`;
     state won't survive the API boundary"). Cross-boundary misses (API, storage,
     routing) outrank cosmetic ones.
   - **notes{}** — per-node reviewer notes: one or two sentences, falsifiable,
     attention-routing ("check the storage key and the SSR guard"), never
     summaries of the diff the reader can see. Write notes for every changed and
     blast node; context nodes need none.
   - **risk{}** — `high | med | low` per blast node. High = plausible silent
     data/behavior loss. Med = criterion-relevant but inert. Low = drawn for
     honesty; safe to skim.
   - **readingOrder[]** — epicenter → flags → remainder.
   - **layout{}** — for slices with 20 or fewer nodes, x,y per node under the
     constraints in `references/DESIGN_CONTRACT.md` § Layout. Narrative placement
     is yours and geometry is validated. For larger slices, omit it or use `{}`;
     the deterministic renderer supplies and the validator checks every position.
4. Render:
   `node scripts/render-slice.ts --slice slice.json --annotations annotations.json --out review.html`
   Pass `--pr <n> [--pr-state open|merged|closed]` to `build-slice` when the
   range is a known pull request; the artifact then reads `repo / PR #n` instead
   of the bare range. It is provenance only — never guess a PR number.
5. Validate:
   `node scripts/validate-slice.ts --artifact review.html --slice slice.json`
6. Present `review.html`. Your accompanying text is the flags list and nothing
   else — the artifact is the report; do not re-narrate the graph.

## Monorepos

`--tsconfig` takes **one** path, on purpose. One TypeScript program has one set of
`compilerOptions` and `paths`; loading package B's files under package A's options
resolves B's aliases wrongly or not at all, and an unresolved import does not
error — it just yields no reference. The blast radius would come out understated
with nothing to show it. So: one program covering every changed package, not one
program per package.

A cross-package diff has no owning package. Write a synthetic config for the run:

```jsonc
// /tmp/groundcheck.tsconfig.json — not committed; one program, all changed packages
{
  "extends": "<repo>/tsconfig.base.json",   // the repo's real options and paths
  "compilerOptions": { "noEmit": true, "baseUrl": "<repo>" },
  "include": [
    "<repo>/apps/app/src/**/*",            // one entry per changed package,
    "<repo>/domains/playback/**/src/**/*",  // derived from git diff --name-only
    "<repo>/foundation/types/src/**/*"
  ]
}
```

Absolute paths in `include`/`baseUrl` let the file live outside the repo. Derive
the entries from the diff (`git diff --name-only <range> | cut -d/ -f1-3 | sort -u`),
extend the repo's base config rather than inventing options, and pass it with
`--tsconfig /tmp/groundcheck.tsconfig.json`.

Getting the scope wrong is safe but visible, never silent: changed TypeScript
files the program does not cover appear in `slice.json` as `excluded.files`, the
build prints a warning naming them, and the artifact's honesty badge says
"N changed files outside the TS project". `generated.tsconfig` records which
program produced the facts, so a slice built with a narrow config cannot be
mistaken for a full one. **If `excluded.count` is not 0, widen the config and
re-run before annotating** — do not annotate around a hole.

## Register discipline

The artifact renders two voices and you must keep them separate: computed facts
(from `slice.json`) in the default register; your judgment (notes, risk, criteria
matching) in the reviewer-note register the renderer styles distinctly. Never
phrase a note as a fact ("this breaks the cart") when it is an inference ("nothing
here updates the cart; criterion 3 expects it — verify").

## References

- `references/SLICE_FORMAT.md` — slice + annotations schemas, determinism rules.
  Read before writing `annotations.json` for the first time in a session.
- `references/DESIGN_CONTRACT.md` — frozen visual system and layout constraints.
  Read before writing `layout{}` for a small slice. Never restyle; contract
  changes require a version bump signed off by the human.
- `assets/shell-mock.png` — golden reference rendering for DESIGN_CONTRACT
  v0.2.0. It remains the visual-language reference for v0.4.0.
- `assets/reference-mock.html` — the superseded v0.1.0 golden. Kept for history
  only; it does not describe the current artifact. Where the two disagree, the PNG
  wins.
