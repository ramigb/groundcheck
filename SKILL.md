---
name: groundcheck
description: >
  Generate deterministic JavaScript/TypeScript reviews from Git revisions,
  uncommitted changes or a patch plus repository/base. Produces standalone HTML
  with before/after pseudocode, source evidence, reference consumers and explicit
  explanation gaps. Model notes are optional. Requires Git and Node >=22.18.
---

# groundcheck

Produce a review that helps a human understand changes without requiring a model
call. Use the bundled scripts from the package root. Do not execute target code
or install target-project dependencies to generate the report.

## Inputs

- Repository root and `base..head`, or `base..` plus exactly one of `--worktree`
  and `--patch changes.diff`.
- Optional repository-relative `--tsconfig` selection.
- Optional acceptance criteria with an explicit user, issue or document source.
  Do not invent criteria or derive them from an implementing agent's self-report.

If a branch is supplied, establish its intended base using repository evidence.
If that base cannot be determined, ask the user. Do not silently change the scope.

## Workflow

1. Run `node scripts/build-slice.ts --repo <root> --range <base>..<head> --out slice.json`.
   For local work use `--range <base>.. --worktree`; for patches use
   `--range <base>.. --patch changes.diff`. Patch hunks must apply exactly to the
   base. Binary, rename/copy, symlink and submodule patches require Git-range mode.
2. Inspect the generated scope and explanation gaps. Keep every changed file,
   including files outside the reference project and unsupported source.
3. Render without annotations by default:
   `node scripts/render-slice.ts --slice slice.json --out review.html`.
   The single-command alternative is
   `node scripts/review.ts --repo <root> --range <base>..<head> --out review.html --slice slice.json`.
4. Validate before presenting:
   `node scripts/validate-slice.ts --slice slice.json --artifact review.html`.
   Exit 0 confirms parity with the supplied facts; it does not certify correctness.
5. Present the HTML with its analyzed range and material gaps. State which target
   tests, if any, were separately run. Do not call criteria mappings test passes.

## Optional interpretation

Only create notes if requested or if they add a specific, code-supported question
that the deterministic output cannot express. Never call an external model as a
prerequisite. A human reviewer can supply the same notes.

Use `annotations: "1.0.0"`, `for: { snapshotId }`, optional
`notes: [{ changeId, text }]` and optional
`criteriaMatches: [{ criterionId, changeIds, note }]`. All IDs must already exist.
Criteria use `{ criteria: [{ id, text, source }] }`.

Render and validate with `--criteria criteria.json --annotations annotations.json`.
Annotate only the exact saved snapshot. Reanalyze and recreate annotations when
source changes. The validator rejects stale IDs, fingerprints and extra fields.

Keep interpretation separate from computed facts. Do not alter `slice.json`,
hand-edit HTML, add inferred consumers or change ordering through notes. Derive
notes from source, not the implementing agent's transcript or claims.

## Evidence rules

- References establish dependency, not behavioral impact or a safety boundary.
- Translated syntax is not a correctness score. Unsupported constructs retain
  source with explanation gaps. Do not fill those gaps with unlabelled prose.
- Criteria remain unverified. An optional suggested evidence mapping is not proof
  that a requirement was met or that a test passed.
- Snapshot fingerprints detect drift; they are not a cryptographic signature or
  proof of semantic accuracy. Supply authoritative criteria/notes to validation
  when embedded copies alone are insufficient.
- If analysis or validation fails, fix the input or implementation and rerun it.
  Report unresolved failures; do not present a fabricated or unvalidated report.

See [README.md](README.md) for examples and
[references/SLICE_FORMAT.md](references/SLICE_FORMAT.md) for the schema.
