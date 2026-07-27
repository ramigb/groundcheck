# DESIGN_CONTRACT v0.4.0

The visual system is frozen from `assets/shell-mock.png`; v0.4.0 extends its
large-slice behavior without changing that visual language. The contract
exists so that after ten runs the reviewer's eyes know where to look before
consciously reading anything. Agents never restyle ad hoc; changes require a
version bump and human sign-off. Renderer implements this; validator spot-checks
it.

`assets/reference-mock.html` is the **superseded** v0.1.0 golden. It stays in the
repo for reference and for the AGENT_LOOP.md M2 gate's history, but it no longer
describes the artifact. Where the two disagree, the PNG wins.

## Delta from v0.3.0

1. The 20-node rejection is removed. Slices above 20 nodes use a deterministic
   automatic layout on an expanded canvas; every graph node and edge remains in
   the artifact.
2. Small slices retain model-authored layout and the original `1180 x 620`
   canvas, preserving the established visual narrative.
3. Large slices, or slices above 100 changed files, render an amber density
   warning. `--collapse dir` remains available as an optional summary rather
   than a prerequisite for rendering.

## Delta from v0.2.0

1. Every `slice.ungraphed[]` entry appears in the Files view with kind
   `not graphed`, status, stats, and spans.
2. Selecting one opens its computed excerpt in Summary and Diff without
   creating a graph node or requiring a layout entry.
3. Files-changed and line metrics include both changed graph files and
   `ungraphed[]`.

## Delta from v0.1.0

Three-region artifact (header / graph + aside / intent strip) becomes a four
region app shell (sidebar / topbar / center / right panel). Consequences that are
not cosmetic and are called out where they land below:

1. **Blast is blue, not red.** `blast` nodes and their edges render in a new
   `consumed` blue and are labelled "Consumed (low risk)". Red is reassigned to
   `deleted`. Epicenter rings keep the alarm red.
2. **The honesty badge moves** from a corner overlay to the `In graph` /
   `Not shown` topbar metric cards.
3. **The intent strip becomes a table**, in the center column under the graph.
4. **The single detail panel becomes three tabs** (Summary / Diff / Notes).
5. **Five views** replace one. The graph is no longer the only thing rendered.

## Palette

| token        | hex       | meaning                                       |
|--------------|-----------|-----------------------------------------------|
| ink          | `#0D1321` | page background, sidebar, topbar, canvas       |
| panel        | `#121A2B` | cards, right panel, center panel surface       |
| panel2       | `#172137` | node fill, active nav item, badges, raised     |
| grid         | `#1D2A46` | hairlines, borders, card borders               |
| line         | `#2A3856` | resting edges                                  |
| paper        | `#E9E6DC` | primary text, hot edges                        |
| dim / faint  | `#8A94AC` / `#5B678A` | secondary / tertiary text          |
| added        | `#63C68F` | added nodes, `+` diff lines, Passed            |
| modified     | `#E5B04B` | modified nodes, flag numbers, Pending-less n/a |
| deleted      | `#E06552` | deleted nodes, `-` diff lines, Failed          |
| consumed     | `#5B8DEF` | blast nodes and their edges (was: deleted red) |
| ring         | `#E06552` | epicenter rings only                           |
| context      | `#4E5F82` | context nodes                                  |
| violet       | `#A78BDA` | judgment register: orphans, reviewer notes     |

`--blast` is gone as a token name. A renderer or validator still referencing it
is a defect, not a fallback.

## Type

Data, labels, code, table cells: `Spline Sans Mono` (fallback ui-monospace).
Reviewer prose and card body copy: `Instrument Sans` (fallback system-ui).
Node label 11.5px/500, sublabel 9.5px, panel prose 13.5px/1.55, section headings
10-11px uppercase tracked `.12em`, nav items 12.5px, table cells 11.5px.

## Shell geometry

Four regions, CSS grid, full viewport height, no page scroll on the body:

```
+--------------+--------------------------------------+----------------+
| brand        | topbar: breadcrumb, chips, metrics    | (topbar cont.) |
+--------------+--------------------------------------+----------------+
| Review nav   | center: panel title + toolbar         | right panel:   |
| Filters      |         graph canvas                  | tabs           |
| Focus        |         criteria section              | cards          |
| Save view    |                                       |                |
+--------------+--------------------------------------+----------------+
```

- **Sidebar** 230px fixed, `ink`, 1px `grid` right border. Brand row is topbar
  height so the two horizontals align.
- **Topbar** 56px, `ink`, 1px `grid` bottom border.
- **Center** flexible, min-width 0, scrolls internally. Graph panel and criteria
  section are two `panel` cards with `grid` borders and 10px radius.
- **Right panel** 400px fixed, `panel` background, 1px `grid` left border,
  scrolls internally.

### Responsive

- Below 1100px: sidebar collapses to a 56px icon rail. Nav items keep their
  icons and their `aria-label`; Filters, Focus and Save view move into a
  disclosure at the rail foot.
- Below 900px: right panel moves below the center column, full width, and the
  sidebar rail stays.

Nothing is removed at any width. Collapsing is a reflow, never a content cut.

## Sidebar

**Review** section label, then five nav items, each an icon plus a label:
Overview, Files, Graph, Acceptance Criteria, Attention Flags. Active item:
`panel2` fill, 8px radius, `paper` label, and `aria-current="page"`. Graph is the
default view.

**Filters** header with a `Clear all` action on the same row.

*Status* group, one checkbox per slice status, in this fixed order and with these
exact labels, each with an accent matching its node color:

| label                | matches `status` | accent   |
|----------------------|------------------|----------|
| Added                | `added`          | added    |
| Modified             | `modified`       | modified |
| Deleted              | `deleted`        | deleted  |
| Consumed (low risk)  | `blast`          | consumed |
| Orphan / Unused      | `annotations.orphans` membership, any status | violet |

A status with no nodes in this slice renders its checkbox **disabled and dimmed**,
not hidden. The reviewer sees that the category exists and is empty; a missing row
would read as a category that does not apply.

*Change type* group, four checkboxes:

| label            | matches edge `type`   |
|------------------|-----------------------|
| Renders / Calls  | `renders`, `calls`    |
| Consumes type    | `consumes-type`       |
| Uses token       | `uses-token`          |
| Imports          | `imports`             |

Each carries the line sample from the edge grammar below, so the checkbox list
and the legend teach the same vocabulary.

**Focus** section, two toggle switches, both on by default: `Show context nodes`,
`Show epicenter rings`. (The mockup's third toggle, "Group by package", is a
non-goal: it is a no-op on a `--collapse dir` slice and a second, competing
collapse mechanism on any other.)

**Save view**, full-width bordered button at the sidebar foot. Persists the
filter set, the focus toggles and the active view to `localStorage`, keyed by
`generated.headSha` so a different slice never inherits another's view.

## Topbar

Left to right:

1. Breadcrumb group in a bordered container: `generated.repo` / `PR #<n>` with a
   state badge (`Open` added-green, `Merged` violet, `Closed` dim). Rendered only
   when `generated.pr` is present; otherwise the group shows
   `generated.repo` / `generated.range`.
2. Chip `<generated.headSha>`. Under `--worktree` the `+worktree` suffix renders
   as a modified-amber `+` glyph with the full string in the `title` attribute.
3. Metric cards, bordered, 8px radius:

| card          | source                                   | layout            |
|---------------|------------------------------------------|-------------------|
| Files changed | distinct changed graph files + `slice.ungraphed[]` | label top, value below |
| Additions     | per-file graph stats + ungraphed stats, added-green, `+`-prefixed | value top, label below |
| Deletions     | per-file graph stats + ungraphed stats, deleted-red, `-`-prefixed | value top, label below |
| In graph      | `slice.nodes.length`                      | label top, value below |
| Not shown     | `slice.hidden.count`                      | label top, value below |

4. Search, right-aligned: a real input that filters and highlights nodes by
   filename or symbol. Collapses to its magnifier icon until focused.

`In graph` and `Not shown` **are** the hidden-nodes honesty badge. They are
mandatory, always adjacent, and mandatory even when `hidden.count` is 0. The
labels are deliberately not "Nodes" / "Context nodes": a reviewer does not think
in nodes, and an honesty counter nobody parses is not honest. When
`slice.excluded.count > 0` a sixth card renders in deleted-red:
`<n> files outside the TS project`. A slice cannot pass as a full one.

`slice.groundcheck` is **not** in the topbar. It is the interchange format's
version: it tells a maintainer whether two artifacts are comparable and means
nothing to a reviewer reading a diff. It renders in the Overview provenance
caption beside the tsconfig, and the embedded `gc-slice` block carries it
verbatim regardless.

The mockup's settings gear and `AK` avatar are non-goals: there is no settings
surface and no user identity in this tool, and dead chrome teaches the eye to
ignore that corner.

## Center: graph panel

Panel head: title `Dependency Graph`, subtitle
`Visualize how changes in this PR impact your codebase`. Toolbar, right-aligned:
`Fit view`, a zoom control, and zoom-out / zoom-in icon buttons. The zoom control
is a native `<select>` over presets (50 / 75 / 100 / 150 / 200 / 400 / 800%) that also reads
back the current scale after a wheel or button zoom; native because a custom
dropdown would be keyboard and screen-reader work for no gain. Zoom and pan are
`viewBox` transforms over the placed coordinates; they never move a node relative
to another.

(The mockup's `Layout` dropdown is a non-goal. Node positions come from
`annotations.layout` and are numerically validated; a client-side relayout would
render positions the validator never saw.)

Small-slice canvas viewBox `1180 x 620`; large slices expand deterministically
to fit their computed grid. Both use the dotted-grid `ink` background. `Fit
view` always returns to the complete world canvas, and zoom supports the added
400% and 800% presets needed to inspect a dense fitted overview.

### Node anatomy

168 x 48, radius 9, fill `panel2`, 1.4px stroke in status color. Sign badge
24 x 22 at (10,13), radius 4, tinted with the status color at ~16%, glyph
centered:

| status   | glyph | stroke                        |
|----------|-------|-------------------------------|
| added    | `+`   | added, solid                  |
| modified | `+`   | modified, solid               |
| deleted  | `-`   | deleted, dashed `2 3`         |
| blast    | `+`   | consumed, solid               |
| context  | `=`   | context, solid                |

Label row 1 = filename (or directory, collapsed). Row 2 = sub:
`<kind> · <n> members` when collapsed, else `<kind>`, then `· new` / `· deleted`
as applicable. Risk and orphan no longer live in the sublabel; they are canvas
labels (below).

Selected: 2px stroke plus paper drop-shadow. Faded (criterion isolation or
filtered out): opacity .22 - **faded, never removed**. A filter must not change
the DOM node set, because the validator counts it and a reviewer must not be able
to make a node disappear from the artifact's own record.
Focus-visible: paper stroke. Keyboard operability is part of the contract.

### Canvas labels

- `risk: <low|med|high>` renders at the midpoint of the edge into the node
  carrying that risk, 9.5px `faint`. Judgment register, so it is captioned in
  the legend as model-supplied.
- `orphan?` renders to the right of any node in `annotations.orphans`, 10px
  violet, with the node's stroke picking up a violet outer ring.

### Edge grammar

| type          | stroke                     | hot state |
|---------------|----------------------------|-----------|
| consumes-type | 1.5px dashed `6 5`         | consumed  |
| renders       | 2.2px solid                | paper     |
| calls         | 1.5px solid                | paper     |
| uses-token    | 1.5px dotted `2 4`         | paper     |
| imports       | 1px solid @ 55% opacity    | paper     |

Resting color `line`; muted opacity .14; arrowhead marker at the depended-upon
end, swapped dim -> paper when hot.

### Epicenter rings

Three dashed circles (`3 6`) at r 78 / 122 / 168 around each epicenter, `ring`
red @ ~.16, staggered 4s opacity pulse; static under `prefers-reduced-motion`.
Hidden by the `Show epicenter rings` toggle, never by a filter.

### Legend

Bottom-left overlay, two columns. Left: `Added`, `Modified`, `Consumed (low
risk)`, `Orphan / Unused` swatches. Right: `Renders / Calls`, `Uses token`,
`Imports` line samples. Labels are byte-identical to the sidebar filter labels.

## Center: criteria section

Header row: `Intent & Acceptance Criteria`, a progress ring showing
`<passed> / <total>` (arc = passed fraction, added-green), and a `Collapse`
toggle on the right. Collapsed state persists with the saved view.

Table, three columns:

| column      | content                                                     |
|-------------|-------------------------------------------------------------|
| ID          | `criteria[].id` verbatim                                     |
| Description | status icon + `criteria[].text`                              |
| Status      | `covered` -> `Passed` (added-green), `uncovered` -> `Failed` (deleted-red) |

Status icons: added-green check for Passed, deleted-red cross for Failed.
Clicking a row isolates that criterion's `nodes` on the canvas and opens its
note in the Summary tab, exactly as the v0.1.0 chips did.

Orphan changes render as rows after the criteria, ID `orphan`, violet warning
icon, description `orphan · <basename>`, status `Unmatched` in violet.

No criteria source: one full-width muted row,
`no criteria provided - intent layer inactive`, and the progress ring is omitted
rather than shown as `0 / 0`.

The section header carries the `model-matched` register caption. Coverage is
judgment, and the table must not read as a computed test result.

(The mockup's `Category` column and its `Pending` status are non-goals:
`annotations.json` has neither field, and inventing one in the renderer would be
the exact fabrication this tool exists to prevent.)

## Right panel

Three tabs. Active tab: `paper` label with a 2px added-green underline, and
`aria-selected`.

- **Summary** - the default. Three cards:
  - `PR Summary`: the computed lede (range, sha, files changed -> nodes drawn,
    context nodes hidden) followed by the epicenter sentence, or the explicit
    "no single epicenter" sentence when there is none. When a node is selected,
    this card becomes the node view: filename + status pill, risk / orphan
    judgment pills, location line (`path · +a -d · Lx-Ly`), reviewer note,
    computed facts, and collapsed-member facts. An ungraphed-file selection
    instead shows its status, stats, spans, `not graphed` tag, and computed
    excerpt. `Back to slice overview` returns.
  - `Attention Flags` with a count badge: up to 5 numbered rows, number in
    modified-amber, violet when the flag targets an orphan. Each row is a jump
    target. `View all flags ->` switches to the Attention Flags view.
    Section carries the `model judgment` register caption.
  - `Diff Preview`: file path, `+a -d`, a status badge, then the selected node's
    excerpt with a line-number gutter, `+`/`-` colouring, and the truncation
    marker rendered as an inline comment. `Open file in diff view ->` switches to
    the Diff tab. Computed register: no violet, ever.

    The gutter numbers **excerpt lines, not file lines** - `slice.json` carries no
    per-line file numbers, and rendering an ordinal as a file line would be a
    fabricated fact. The gutter is `aria-hidden` and the block is captioned
    accordingly; the node's real changed spans are stated in the facts list.
- **Diff** - the full excerpt set for the selected node or ungraphed file, or
  for every changed node and ungraphed file when nothing is selected, same
  gutter and colouring.
- **Notes** - every entry in `annotations.notes`, count in the tab label, each
  with its target node as a jump link. Each note keeps the 2px violet left rule
  and the `reviewer note` caption. This tab is judgment and nothing else.

(The mockup's per-flag `Config` / `Build` / `API` badges are a non-goal:
`annotations.flags[]` has no category field.)

## Views

| nav item            | center region                                              |
|---------------------|-------------------------------------------------------------|
| Overview            | full-width lede, attention flags, suggested reading order    |
| Files               | every drawn node and ungraphed changed file: path, kind, status, `+a -d`, spans |
| Graph               | graph panel + criteria section (default)                     |
| Acceptance Criteria | criteria table, full width, uncollapsed                      |
| Attention Flags     | every flag, full width, with its target's facts inline       |

The right panel persists across views. Selecting a row in Files selects its node
or ungraphed file; selecting an Attention Flag selects its node. The panel stays
the single place a change is read.

## Register separation

Computed facts render in the default register. Model judgment renders in the
judgment register: reviewer notes get a 2px violet left border and the caption
`reviewer note`; the criteria section and the attention-flags section carry
`model-matched` / `model judgment` captions on the section, not per row; risk and
orphan pills sit visually adjacent to, never inside, computed metadata. Metric
cards, the graph's computed geometry, the Files view and every diff block are
default register and carry no violet. A reader must be able to tell at a glance
which voice is speaking.

## Layout (hybrid, validator-enforced)

For slices with 20 or fewer nodes, layout remains model-authored and the canvas
viewBox remains `1180 x 620`. Geometry rules are hard and checked numerically:

- Every node has exactly one layout entry; all rects inside the viewBox with
  >= 14px margin.
- No node-rect overlap; minimum edge-to-edge gap 24px.
- Epicenter center within x in [380, 500], y in [260, 340]. Multiple epicenters:
  place the highest-degree one there, others >= 200px apart.

Narrative rules (soft, model judgment): blast nodes fan on the far side of the
epicenter from the changes, so cause and consequence read as regions; additions
cluster near the component that renders them; orphans sit peripheral, visibly
apart from the feature cluster; edge crossings minimized last, after the regions
read cleanly.

For slices above 20 nodes, `annotations.layout` is ignored and may be omitted.
The renderer and validator independently run the same deterministic placement:

- canvas dimensions expand with node count and have no node-count rejection;
- fixed node geometry and at least 24px edge-to-edge separation are preserved;
- epicenters, their direct neighbors, changed nodes, then remaining nodes are
  ordered toward the center, with degree and stable node id as tie-breakers;
- every rendered position and the expanded canvas dimensions are recomputed by
  the validator, so automatic placement does not weaken artifact integrity;
- an amber warning states that all content is included but density can make the
  graph harder to read, and points reviewers to search, Files, and detail views.

`--collapse dir` is an optional reviewer choice when directory-level topology is
more useful. It is never required merely to make a slice render.

## Signature elements (never cut)

1. **Epicenter rings** - three dashed pulsing circles per epicenter.
2. **Hidden-nodes disclosure** - the `In graph` / `Not shown` metric card pair,
   plus the outside-the-TS-project card when non-zero. The honesty counter.
   Mandatory even at zero.
3. **Attention flags** - at most 5, numbered, each a jump target.
4. **Register separation** - the violet rule and its captions.
5. **Filtered means faded** - no control in this artifact removes a node from
   the document.
