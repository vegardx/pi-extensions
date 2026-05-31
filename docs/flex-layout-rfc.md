# RFC: Responsive flex layout for pi-tui

Status: draft · Target: `earendil-works/pi` (`@earendil-works/pi-tui`, `@earendil-works/pi-coding-agent`) · Tracking slug: `pi-extensions-20260531-10`

## 1. Problem

pi-tui can only stack components vertically. The exported layout primitive is
`Container` (a vertical stack); the only horizontal compositing is the overlay
path (`compositeLineAt`), which paints one component *on top of* another and
therefore **occludes** rather than reflows. There is no `Flex`/`Row`/`Column`/
`Grid` component, and no extension API for horizontal placement (`setWidget`
only offers `aboveEditor` / `belowEditor`).

Consequence: the interactive-mode root renders header / chat / editor / footer
as full-width siblings, and an extension cannot place a sidebar *beside* the
conversation without covering it. The desired UX — a `[conversation | sidebar]`
split at wide terminals that collapses to conversation-only when narrow — is not
expressible today.

This RFC specifies three additions, designed as clean public API so they can be
upstreamed:

1. A **flex layout component** (CSS-flexbox-like, single axis) — §2.
2. A **responsive breakpoint** mechanism (CSS media-query analogue) — §3.
3. A **region / extension API** so the host root and extensions can fill named
   slots — §4.

The work is prototyped on a fork, proven with a minimal consumer, then proposed
upstream. See the plan phases for the fork lifecycle.

## 1.1 The existing contract (what we build on)

Every pi-tui component implements:

```ts
interface Component {
  render(width: number): string[]; // returns visible lines, each ≤ width cols
}
```

Width is authoritative and pushed down from the root (`terminal.columns`).
Components already wrap/clip to whatever width they are handed — so **handing a
component a smaller width is all that is required to make it reflow into a
column.** No occlusion, no special-casing.

Horizontal composition is already done in userland today: `packages/questions/
dialog.ts` `renderSplitLayout` renders a left pane and a right pane to fixed
widths and **zips them line-by-line** with a separator, padding each left line to
`leftWidth` via `visibleWidth` and clipping the joined line with
`truncateToWidth`. The flex component generalises exactly this technique.

Helpers that already exist and the engine reuses: `visibleWidth(str)`,
`truncateToWidth(str, w)`, `wrapTextWithAnsi(str, w)`, and the slice helpers used
by the overlay compositor.

## 2. Flex component + sizing model

### 2.1 Shape

A single component, single-axis, nestable (a flex item may itself be a flex):

```ts
type FlexDirection = "row" | "column";

interface FlexItemOptions {
  /** Fixed track size in cols (row) / lines (column). Wins over basis/grow. */
  size?: number;
  /** Percentage of the container's content extent (after gaps). 0..100. */
  basisPct?: number;
  /** Share of leftover free space. Default 0 (do not grow). */
  grow?: number;
  /** Share of overflow to absorb when content exceeds the container. Default 1. */
  shrink?: number;
  /** Clamp the resolved main-axis size. */
  min?: number;
  max?: number;
  /** Cross-axis behaviour when this item is shorter/narrower than the track. */
  align?: "start" | "stretch"; // default "stretch"
  /** Overflow on the main axis when content exceeds the resolved track. */
  overflow?: "clip" | "wrap"; // default delegates to the child's own render
}

interface FlexChild {
  component: Component;
  options?: FlexItemOptions;
}

interface FlexOptions {
  direction: FlexDirection;
  /** Cols (row) / blank lines (column) inserted between children. Default 0. */
  gap?: number;
  /** Optional visible separator drawn in the gap (e.g. " │ "). Row only. */
  separator?: string;
  /** Cross-axis sizing of children shorter than the tallest. Default "start". */
  align?: "start" | "stretch" | "end";
}

class Flex implements Component {
  constructor(options: FlexOptions);
  add(component: Component, options?: FlexItemOptions): this;
  setChildren(children: FlexChild[]): void;
  render(width: number): string[];
}
```

`Container` (the existing vertical stack) is the degenerate `column` flex with
`grow: 0` everywhere; we keep `Container` as-is for back-compat and implement
`Flex` alongside it.

### 2.2 Main-axis sizing algorithm (row)

Given container content width `W` and `n` children with `gap` and an optional
`separator` of width `sepW = max(gap, visibleWidth(separator))`:

1. `avail = W - (n - 1) * sepW`.
2. **Fixed/basis pass:** for each child, `base = size ?? round(basisPct/100 *
   avail) ?? 0`. Clamp to `[min, max]`. Sum into `used`.
3. **Grow pass:** `free = avail - used`. If `free > 0` and `Σgrow > 0`,
   distribute `free` across children by `grow / Σgrow`, re-clamping to `max`;
   redistribute any clamp remainder among still-growable children.
4. **Shrink pass:** if `free < 0`, remove `-free` weighted by `shrink * base`,
   re-clamping to `min`.
5. **Rounding:** widths are integers; the largest fractional remainder gets the
   leftover col so tracks sum exactly to `avail` (no off-by-one gaps).
6. Render each child at its resolved width → `string[]`. Pad each line to the
   track width with spaces (`align: stretch`) or leave ragged + pad to track for
   zipping. Clip over-wide lines with `truncateToWidth` (defensive; children
   should already obey width).
7. **Zip:** for `i in 0..maxLines`, join the i-th line of each track with the
   separator (or `gap` spaces), then `truncateToWidth(joined, W)`. Missing lines
   become a full-width-padded blank for that track.

Column direction reuses the existing vertical-stack behaviour for line
distribution; `size`/`min`/`max`/`grow`/`shrink` then operate on **line counts**
(height) instead of columns, enabling height-aware stacking (used by the sidebar
to give the plan box `grow` and notes a `min`).

### 2.3 Properties / invariants (test targets)

- Tracks + gaps sum exactly to `W` (row) regardless of rounding.
- Every emitted line has `visibleWidth(line) ≤ W`.
- `min`/`max` are never violated after grow/shrink.
- A `grow:1` child next to a fixed `size` child absorbs all free space.
- Nesting: a `Flex(column)` inside a row track receives that track's width and
  reflows internally (recursive `render`).
- ANSI styling is preserved across pad/clip (use the ANSI-aware width helpers).

Unit tests live beside the component and exercise the pure sizing function
(extract `resolveTracks(avail, children, sepW)` like `panel.ts` isolates
`windowLines`).

## 3. Responsive breakpoints

CSS media-query analogue, keyed on terminal dimensions. Breakpoints are
declarative and resolved **on every render** (a width change already triggers a
full re-render in the host, so there is no extra invalidation to wire).

```ts
interface Breakpoint<L> {
  /** Inclusive lower bounds; the largest matching wins. */
  minCols?: number;
  minRows?: number;
  layout: L; // an opaque token the consumer maps to a concrete layout/visibility
}

class Responsive<L> {
  constructor(breakpoints: Breakpoint<L>[], fallback: L);
  /** Pure: pick the active token for a terminal size. */
  resolve(cols: number, rows: number): L;
}
```

The consumer (host root or an extension) maps the resolved token to a concrete
`Flex` tree / child-visibility set. Tokens, not components, are the unit so the
mapping stays pure and testable.

Default mapping for pi's root layout (the headline use case):

| Terminal width | Layout token | Result |
| --- | --- | --- |
| `< 200 cols` | `compact` | conversation + editor only (today's behaviour) |
| `>= 200 cols` | `split` | `[conversation grow | sidebar basisPct 30 min 32]` |

Sidebar height bands (within the sidebar's own column flex) can drop boxes when
rows are scarce, e.g. hide Notes below `minRows: 30`. The exact numbers are
config-overridable (see §4.3); 200 is chosen because the existing plan panel
already engages near 100 and a split needs roughly double that to keep the
conversation readable.

Invariants to test: monotonic resolution (no flapping at the same size), the
largest matching bound wins, fallback applies below all bounds.

## 4. Region / extension API

### 4.1 Concept

The host owns a small set of **named regions** in its root layout. Extensions
fill a region with a component factory; the host decides *where* (via its flex
tree + breakpoints) and *how wide* the region is, then calls the factory with the
resolved width. This keeps layout authority in the host (so multiple extensions
can't fight over geometry) while letting extensions own region *content*.

Initial regions: `"sidebar"`. Designed to extend to `"header"` / `"footer"`
later without an API change.

### 4.2 Extension API (added to `ctx.ui`)

```ts
interface RegionViewOptions {
  /** Region to fill. */
  region: "sidebar";
  /** Lower priority renders first / outermost; ties broken by registration order. */
  priority?: number;
  /** Whether this view can take keyboard focus (e.g. an editable notes field). */
  focusable?: boolean;
}

interface RegionViewHandle {
  update(): void;   // request a re-render of this view
  setVisible(visible: boolean): void;
  dispose(): void;
}

interface ExtensionUI {
  // ...existing setWidget / setFooter / setHeader / setEditorComponent...

  /**
   * Register a component into a named region. The factory receives the live
   * TUI + theme and the region's resolved inner width (post-borders/gap), and
   * is re-invoked on resize. Returns a handle for updates/visibility/disposal.
   */
  registerRegionView(
    options: RegionViewOptions,
    factory: (tui: TUI, theme: Theme, width: number) => Component & { dispose?(): void },
  ): RegionViewHandle;

  /** Convenience for the common single-sidebar case. */
  setSidebar(
    factory: ((tui: TUI, theme: Theme, width: number) => Component & { dispose?(): void }) | undefined,
    options?: Omit<RegionViewOptions, "region">,
  ): RegionViewHandle | undefined;
}
```

Notes:
- `setSidebar(undefined)` clears; mirrors `setWidget(key, undefined)` and
  `setHeader(undefined)` semantics already in the API.
- Multiple `registerRegionView` calls for the same region stack vertically in a
  `Flex(column)` ordered by `priority` — this is how the deferred extension
  redesign places Info / Plan / Notes as three views without one extension
  owning all three.

### 4.3 Focus routing

Reuse the existing overlay/editor focus plumbing. When a region view is
`focusable`, the host adds it to the focus cycle; a focused view receives key
events (so the Notes box editor and Plan scrolling work). The host renders a
focus affordance (border accent) on the active region. No new global keymap is
mandated by this RFC beyond "cycle focus into/out of regions"; the binding is the
host's choice (candidate: extend the existing focus-cycle key).

### 4.4 Host root wiring (coding-agent)

`interactive-mode` composes the root as:

```
Flex(column)
├─ header (full width, existing)
└─ Flex(row)  ← gated by Responsive: present only at `split`
   ├─ conversationColumn  grow:1            ← chat + editor + footer stack
   └─ sidebarRegion       basisPct:30 min:32 ← Flex(column) of registered views
```

At `compact`, the row collapses to just `conversationColumn` at full width —
identical to today. Because the conversation is handed `W - sidebarW` at `split`,
it **reflows** into the narrower column; nothing is hidden. Resize flips between
tokens and the next render reflects it.

Config knobs (host settings, override-able by the modes extension):
`layout.splitMinCols` (default 200), `layout.sidebarBasisPct` (30),
`layout.sidebarMinCols` (32).

### 4.5 Compatibility

- `Container`, `setWidget`, `setFooter`, `setHeader`, `setEditorComponent`, and
  overlays are unchanged. Existing extensions in this repo (caffeinate, commit,
  modes' plan panel, questions dialog, etc.) keep working: they render into the
  conversation column's width exactly as before.
- The current `modes` plan-panel overlay continues to function as the
  `< splitMinCols` fallback; the sidebar region is purely additive at wide
  widths. The deferred redesign later reconciles the two so they never both show.
- No change to the `Component.render(width)` contract — the entire design is a
  composition layer on top of it.

## 5. Worked examples

**Conversation + sidebar (row):**

```ts
const root = new Flex({ direction: "row", gap: 1 });
root.add(conversationColumn, { grow: 1 });
root.add(sidebar, { basisPct: 30, min: 32 });
// at width 240: conversation ≈ 167, gap 1, sidebar ≈ 72 (30% clamped ≥32)
```

**Sidebar internals (column, height-aware):**

```ts
const sidebar = new Flex({ direction: "column", gap: 0 });
sidebar.add(infoBox);                 // content-sized
sidebar.add(planBox, { grow: 1 });    // takes remaining height, scrolls
sidebar.add(notesBox, { min: 6 });    // editable, never smaller than 6 lines
```

**Responsive root:**

```ts
const responsive = new Responsive(
  [{ minCols: 200, layout: "split" }],
  "compact",
);
// render(): const token = responsive.resolve(cols, rows);
//           token === "split" ? rowWithSidebar : conversationOnly;
```

## 6. Open questions (resolve during prototype)

- Exact focus-cycle binding for regions (extend existing cycle vs. dedicated key).
- Whether `header`/`footer` regions ship in the first upstream PR or follow.
- Min readable conversation width — validate 200-col split threshold against real
  terminals during the proof phase; tune `splitMinCols` if cramped.
- Whether `Responsive` belongs in pi-tui (generic) or coding-agent (app-level).
  Leaning pi-tui so other TUI apps benefit and to keep the root pure.

## 7. Delivery

1. Prototype `Flex` + `Responsive` in the fork's `packages/tui`.
2. Wire the root + `registerRegionView`/`setSidebar` in `packages/coding-agent`.
3. Prove with the minimal sidebar consumer (info header + plan tree).
4. Open an upstream PR to `earendil-works/pi` (requires explicit approval per
   the public-repo rule), then retire the fork and restore upstream deps.
