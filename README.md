# groundcheck

Understand JS/TS changes with deterministic before/after pseudocode, source evidence,
and reference consumers in a standalone HTML review. No model calls or API keys.

Groundcheck helps a reviewer reconstruct control flow and identify what needs a
closer look. Git supplies the revisions and diffs; TypeScript syntax rules supply
the pseudocode; `ts-morph` finds references separately in each revision. Optional
human or model notes appear as unverified interpretation.

## Quick start

Requires Git and Node.js >= 22.18. Run these commands from this package:

```sh
npm ci
npm run review -- --repo /path/to/project --range main..feature --out review.html --slice slice.json
```

Open `review.html` in a browser. It needs no server, network, account, or model.
See a [generated example](docs/sample-review.html).

Uncommitted changes (staged, unstaged, and untracked, excluding ignored files):

```sh
npm run review -- --repo /path/to/project --range HEAD.. --worktree --out review.html
```

Review a patch against a known base revision:

```sh
git -C /path/to/project diff --no-renames main..feature > changes.diff
npm run review -- --repo /path/to/project --range main.. --patch changes.diff --out review.html
```

Patch mode reconstructs complete files in memory from the base. Hunks must match
the stated positions and context exactly. Binary, rename, copy, symlink and
submodule patches are rejected; use a Git range for those changes. A repository
and base revision are required. Isolated diff fragments without a base are not
supported. Git-range mode represents renames as a deletion and addition.

## What the report contains

- An ordered list of changed top-level statements, with nested logic retained in
  its enclosing unit. Expand a row for before/after pseudocode and complete source.
- Explicit explanation gaps for unsupported or invalid syntax. Classes, JSX,
  generators, nested callback expressions and other unsupported constructs retain
  source rather than acquiring an invented explanation.
- Static reference sites from **both** revisions, including references to deleted
  and local declarations. A call, render, import or type use establishes a
  dependency, not proof that the consumer's behavior changed.
- Every changed file, including non-code and binary files, with complete textual
  diffs when available. Metadata and files without logical explanations remain
  visible for direct review.
- Scope for each revision: selected config, included and excluded code files,
  unresolved imports, and limitations. JavaScript without a config receives
  syntax analysis and an explicitly disclosed default reference-analysis scope.
- Supplied criteria and optional evidence mappings, without automated pass/fail
  claims. Criteria without a mapping remain unassessed.

For example, changing `input || 5000` to `input ?? 5000` changes the fallback rule
from **falsy** to **null or undefined**. The report explains that `0`, `false`, an
empty string and `NaN` are kept *if they reach that expression*. It does not claim
that those values actually reach it.

## Separate build, render and validation

```sh
node scripts/build-slice.ts --repo /path/to/project --range main..feature --out slice.json
node scripts/render-slice.ts --slice slice.json --out review.html
node scripts/validate-slice.ts --slice slice.json --artifact review.html
```

`review.ts` combines analysis and rendering. The staged commands let you reuse a
saved snapshot and attach optional notes. `--tsconfig packages/app/tsconfig.json`
selects a repository-relative config independently in each revision.

Validation checks the slice's internal references and fingerprint, then compares
the artifact with a fresh deterministic rendering of the supplied inputs. Exit
codes: `0` matches; `1` artifact differs; `2` invalid input or execution failure.
This detects artifact drift; it does **not** certify semantic correctness, test
success, or authenticity against a maliciously rewritten snapshot and hash.
Generated metadata such as time is outside the deterministic snapshot fingerprint.

## Optional criteria and notes

Criteria must come from an explicit source, such as a user request or issue:

```json
{
  "criteria": [
    { "id": "AC1", "text": "Preserve a zero timeout", "source": "Issue #12" }
  ]
}
```

Notes are optional. Groundcheck never invokes a model. If a person or agent adds
notes, use existing change IDs and the exact `snapshotId` from `slice.json`:

```json
{
  "annotations": "1.0.0",
  "for": { "snapshotId": "COPY_FROM_SLICE" },
  "notes": [
    { "changeId": "COPY_EXISTING_CHANGE_ID", "text": "Check whether callers supply zero." }
  ],
  "criteriaMatches": [
    { "criterionId": "AC1", "changeIds": ["COPY_EXISTING_CHANGE_ID"], "note": "Relevant fallback expression; runtime behavior remains unverified." }
  ]
}
```

```sh
node scripts/render-slice.ts --slice slice.json --criteria criteria.json --annotations annotations.json --out review.html
node scripts/validate-slice.ts --slice slice.json --artifact review.html --criteria criteria.json --annotations annotations.json
```

Notes for another snapshot and unknown IDs or fields are rejected. Notes cannot
change facts, ordering, scope, pseudocode or validation results. The renderer
marks them as unverified interpretation. When validating with only `--slice`, the
validator uses the criteria and notes embedded in the report; supply the external
files as above when you also need to check those against authoritative inputs.

## Boundaries

Groundcheck reads Git data and source. It does not execute the reviewed project's
code, tests, builds, hooks or package installations. Both reference projects use
only files from their own snapshots, not the checkout's installed dependencies.

Translation is bounded syntax analysis, not a proof of equivalence. Function
bodies are described as definitions that run when called. Truthiness, coercion,
short-circuit evaluation and await ordering are explicit where supported.
Simple member access and parameter/type spelling remain visible as source.
Dynamic dispatch, runtime wiring, project-reference traversal and installed
external dependency resolution are not implemented. Changed logical units are
top-level statements; independent nested-function grouping is not implemented.
Worktree capture is a sequential read, so avoid editing files during capture.
Submodule contents require separate review; they are not traversed.

## Development

```sh
npm test
npm run typecheck
```

The portable Node test suite exercises translation edge cases, both revision
snapshots, JS/config scopes, patch input, worktree changes, optional note isolation,
hostile text escaping, command-line paths and artifact tampering.

Version 1 replaces the graph and the 0.x slice/annotation formats. Old layout,
depth and directory-collapse options are removed. Regenerate existing slices and
annotations; there is no automatic schema conversion. The package's [SKILL.md](SKILL.md)
describes the agent workflow; [SLICE_FORMAT.md](references/SLICE_FORMAT.md) and
[DESIGN_CONTRACT.md](references/DESIGN_CONTRACT.md) describe the output contract.
