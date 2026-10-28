# SLICE_FORMAT v1.0.0

`scripts/model.ts` defines the TypeScript types. `scripts/check.ts` validates
internal consistency. Version 1 is incompatible with the old graph schema;
regenerate old artifacts. The renderer accepts exactly `groundcheck: "1.0.0"`.

## Computed slice

| Field | Meaning |
| --- | --- |
| `groundcheck` | Schema version |
| `generated` | Time, repository label, requested range, resolved base/head identities, worktree flag and tool versions |
| `snapshotId` | SHA-256 of JSON-serialized input, trees, files, changes, references and scopes |
| `input` | `{ kind: "git-range" \| "worktree" \| "patch", patch?: string }`; patch input retains the supplied text |
| `trees` | Before/after fingerprints over sorted repository paths, modes and object/content identities |
| `files` | Every changed file, sorted by repository path |
| `changes` | Changed top-level logical units; nested logic remains inside the enclosing unit |
| `references` | Evidence for changed declarations from each independent revision project |
| `scopes` | Before and after reference-analysis scope, in that order |

`generated` is excluded from the snapshot fingerprint. Identical snapshots and
inputs produce identical computed collections with the same toolchain. Git-range
revisions use Git object identities; worktree/patch content uses SHA-256. Therefore
equal bytes in different input modes need not have equal snapshot IDs.

## Files and logical units

A file has `file`, `status` (`added`, `modified`, `deleted`), numeric `added` and
`removed` line counts, `binary`, optional `beforeMode`/`afterMode`, full `diff`,
`analysis` (`syntax`, `source-only`, `binary`) and `changeIds`. Binary line counts
are zero because Git reports no textual statistics. Binary contents are omitted.
Renames in Git-range mode become a deletion and an addition. Mode-only changes
remain visible even when there are no changed logical units.

A change has `id`, `file`, `name`, syntax `kind`, `status`, optional `before` and
`after`, and `patterns` (bounded syntactic observations). IDs combine repository
path, top-level declaration kind/name and an occurrence number. A rename or kind
change can become a deleted/added pair; this is not semantic matching.

Each side contains `name`, `kind`, `source`, complete `code`, `steps`, `gaps` and
`coverage`. Locations are `{ file, start, end }` with inclusive, one-based lines.
Steps contain `kind`, `text`, `source` and optional nested `children`. Gaps contain
`reason`, `source` and verbatim `code`.

Coverage is `translated`, `partial` or `source-only`. `translated` means no explicit
syntax-rule gaps were found, not that behavior was proved. Invalid syntax falls
back to a complete file source unit. Every changed file remains present even if
comments, whitespace or unsupported file types yield no changed logical units.

## Reference evidence and scope

A reference has `changeId`, `revision` (`before` or `after`), `relationship`
(`calls`, `renders`, `uses-type`, `imports`, `references`), a `source` location
and the complete containing source line as `code`. References are sorted by change,
revision, path, line and relationship, and deduplicated. Static references are
potential exposure, not demonstrated runtime impact.

Each scope has `revision`, `mode` (`configured`, `syntax-only`), selected `config`
or null, sorted `includedFiles`/`excludedFiles`, `limitations`, and
`unresolvedImports: [{ file, line, specifier }]`. Configuration is loaded from its
own snapshot. Installed packages and target scripts are not loaded or executed.
Imports unresolved in that snapshot are disclosed. Config-loading failures fall
back to syntax analysis and are disclosed. Project-reference traversal and dynamic
resolution are unsupported.

## Optional inputs

```json
{
  "criteria": [
    { "id": "AC1", "text": "Preserve a zero timeout", "source": "User request" }
  ]
}
```

```json
{
  "annotations": "1.0.0",
  "for": { "snapshotId": "EXACT_SLICE_SNAPSHOT_ID" },
  "notes": [{ "changeId": "EXISTING_CHANGE_ID", "text": "Unverified interpretation" }],
  "criteriaMatches": [
    { "criterionId": "AC1", "changeIds": ["EXISTING_CHANGE_ID"], "note": "Suggested evidence" }
  ]
}
```

Unknown fields, duplicate IDs, empty notes, dangling references and mismatched
snapshot IDs are rejected. Annotations cannot alter facts or reading order. A
criteria mapping is suggested evidence; criteria are never rendered as test passes.

## Artifact integrity

The HTML embeds `gc-slice`, `gc-criteria` and `gc-annotations` JSON blocks.
`validate-slice.ts` validates supplied facts and compares every byte with a fresh
render. It uses embedded optional inputs unless external ones are supplied.
Exit 0 means render parity; exit 1 means artifact drift; exit 2 means invalid
input or execution failure. Hashes and render parity do not establish semantic
truth, protect against a maliciously replaced authoritative input, or replace tests.
