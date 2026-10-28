# DESIGN_CONTRACT v1.0.0

The primary artifact is an ordered review list. `scripts/html.ts` is its renderer;
`docs/sample-review.html` is a generated example. The graph, layout coordinates,
directory collapse, epicenter and risk-score UI from 0.x are removed.

## Information order

1. Repository/range and before/after identities.
2. Counts of changed files and logical units, translated unit revisions,
   explanation gaps and files with reference evidence.
3. Logical changes with native expandable rows. Each row contains before/after
   pseudocode, complete unit source, explicit gaps and reference evidence.
4. All changed files, including unsupported files, binaries and metadata, with
   complete textual diffs when available.
5. Supplied intent and criteria with optional, unverified suggested evidence.
6. Included/excluded source, unresolved imports and scope limitations for each
   revision. Scope remains visible even when explanation coverage is high.

The reading order comes from deterministic path/unit ordering. Optional notes
cannot reorder or hide facts. Search dims nonmatching changes and announces the
match count; it does not remove them. Expand/collapse controls act on change rows.

## Evidence language

Use “reference sites” and “potential exposure,” not demonstrated behavioral impact.
Use “translated,” “partial” and “source-only” only for syntax-rule coverage.
Always disclose that translation does not prove correctness or runtime equivalence.
Criteria remain “Unverified.” Optional mappings are “Suggested evidence.”
No pass/fail criterion labels, safety score, guaranteed impact boundary or claims
of test success may be inferred from syntax or model notes.

Computed material and optional interpretation have separate registers. Notes use a
violet rule and an explicit unverified label. Gaps use amber and retain verbatim
source. Status colors describe added/modified/deleted files, not risk or correctness.

## Interaction and delivery

Use native details/summary, labelled inputs, keyboard-operable buttons, visible
focus indicators, a skip link and live search status. Before/after columns stack
on narrow screens; evidence tables scroll. Opening an evidence link must reveal
the linked change. All source and notes are escaped; embedded JSON cannot close
its script element. A CSP permits only the report's own interaction script.

Deliver one HTML file with embedded JSON/CSS/JS and no network resources. It must
remain readable without JavaScript. Validation compares the complete deterministic
render, including controls and explanatory labels. Browser interaction checks
complement integrity tests; neither certifies source semantics.
