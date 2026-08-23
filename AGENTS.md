# Kaleidoscope agent guide

Use this file as a map, not an encyclopedia. Keep durable architecture,
invariants, navigation hints, and verification rules here; put long explanations
and task-specific plans elsewhere.

## Start here

| Task                                  | Read first                                     |
| ------------------------------------- | ---------------------------------------------- |
| UI/control wiring                     | `app.js`, then the relevant HTML               |
| Rendering, animation, feedback, bloom | `render.js`                                    |
| Bitmap loading/persistence            | `bitmap-source.js`                             |
| Basic drawing source                  | `drawing-source.js`, then `app.js`             |
| Canvas2D brush rendering              | `brushes.js`                                   |
| Global wallpaper symmetry             | `global-wallpaper.js`                          |
| New source type                       | source contract below, then `bitmap-source.js` |
| Canvas gestures                       | `app.js`; transforms stay in `Renderer`        |

Read the owning module before broad repository greps. After that, prefer targeted
symbol searches.

## Architecture

### `render.js` — rendering core

Exports `Renderer` and exclusively owns WebGL2: shaders/GPU resources, source
texture uploads, resizing, local/global symmetry rendering, feedback, bloom,
animation/motion, timeline state/rebuilds, render loop, and pan/zoom transforms.

It must NOT query the DOM, use browser persistence, decode files, or branch on
specific source types.

Use public methods: `setSource`, `getState`, `restoreState`, `updateState`,
`updatePostProcess`, `updateMotion`, `seekToTime`, `panBy`, `zoomBy`,
`beginInteraction`, `endInteraction`. Persist `getState()` output, never
renderer internals.

### `bitmap-source.js` — bitmap source

Exports `BitmapSource`; owns validation/decoding, current image
pixels/dimensions, monotonic frame revision, IndexedDB persistence, and legacy
source-image migration. It must remain WebGL-free.

### `drawing-source.js` — drawing source

Exports `DrawingSource`; owns its offscreen Canvas2D surface, brush settings,
stroke interpolation, and frame revision. It remains WebGL-free and maps each
pointer-space stroke sample to one source coordinate using the effective mapping
state supplied by `Renderer`. Global wallpaper pointer mapping is not supported
until it can match `global-wallpaper.js` exactly; `app.js` temporarily switches
to `single` while Draw mode is active and restores the prior bitmap grid mode
when returning to Image mode.

### `brushes.js` — brush rendering

Exports Canvas2D-only brush implementations. Brushes receive mapped source
coordinates and paint options; they must not depend on pointer events, source
revisions, renderer state, WebGL, or symmetry mapping.

### `app.js` — orchestration/UI

Owns DOM/event wiring, control synchronization, active-source selection, pointer
routing, workspace persistence/status, and export/recording UI. Do not move
rendering math, GPU work, or source persistence here.

## Source contract

Every renderer source implements:

```
source.getFrame()
```

returning `null` or:

```
{ pixels, width, height, revision }
```

Rules:

- Sources own pixels, dimensions, and monotonic `revision`.
- Increment `revision` whenever source pixels change.
- `getFrame()` is non-destructive.
- `Renderer` owns GPU upload state (`uploadedSource` / `uploadedRevision`).
- Upload again when source identity changes, even if revision numbers match.
- Never add source-type branches to `Renderer`.

Keep two events distinct:

1. **Source activation/replacement** may reset feedback/rebuild presentation.
2. **Incremental source mutation** (e.g. drawing) uploads pixels while retaining
   feedback history; it must not emit renderer state or trigger workspace
   persistence merely because source pixels changed.

This distinction is required for high-frequency sources such as drawing/video.

## Rendering coordinate model

Sources do not implement kaleidoscope symmetry. `Renderer` samples one source
texture and applies:

```
screen UV
 -> center
 -> aspect correction
 -> global wallpaper map
 -> local symmetry/motif
 -> rotation
 -> undo aspect correction
 -> zoom
 -> pan
 -> source-image aspect correction
 -> fract/wrap
 -> source sample
 -> feedback
 -> hue
 -> bloom
```

Any future screen-to-source mapping (especially drawing input) must agree with
this order. Do not casually duplicate, reorder, or approximate it.

## Symmetry model

There are **two separate symmetry layers** in this app and they must not be conflated.

1. **Global wallpaper/grid symmetry** (`global-wallpaper.js`): maps a point in the plane into a canonical representative of a wallpaper-group quotient. This determines the large-scale lattice / tiling structure.
2. **Local motif symmetry** (`render.js` shader logic): after the global map, applies the kaleidoscope-style fold/rotation/motif transform inside that canonical region.

**Important: distinguish the visual pipeline from the shader coordinate pipeline.**

Conceptually, the app creates a **local kaleidoscope motif** from the source and then arranges that motif using the **global wallpaper/grid symmetry**:

```
source → local motif → global wallpaper/grid → screen
```

The fragment shader performs the inverse lookup for each screen pixel, so its coordinate-mapping order is:

```
screen → global wallpaper map → local motif map → source
```

These are the same transformation viewed in opposite directions.

Consequences:

- Do not move local motif logic into `global-wallpaper.js`.
- Do not reimplement wallpaper logic as a local motif effect.
- A rendered result may show more symmetry than the selected wallpaper group if the local motif itself has additional symmetry; that can be mathematically correct.

## Symmetry invariants

`global-wallpaper.js` is deliberately group-theoretic, not "tile-ish". Current
global modes: `single`, `p6m`, `p6`, `p4m`, `p4g`, `p3m1`, `p3`, `p31m`.

It uses translation lattices and coset representatives to construct genuine
quotient maps. Do not replace them with visually similar alternating-cell
shortcuts.

The local motif layer is applied afterward by `Renderer` (radial/mirror radial,
spiral, tunnel, fractal fold, tile, p2, p4, pg, hexagonal, wallpaper-style
behavior). A result may show more apparent symmetry than the selected global
group when the local motif already has extra symmetry; that can be correct.

## State/update semantics

- Geometry/motion changes may require scene rebuild/timeline replay.
- Pure post-processing such as bloom should use the post-process path and avoid
  unnecessary feedback rebuilds.
- Source-frame uploads are not renderer-state changes.
- High-frequency interactions must avoid UI resync, localStorage writes, and
  timeline rebuilds on every pointer event.
- Behavior-preserving refactors must preserve shader math, bloom behavior,
  feedback semantics, and coordinate order.

## Input ownership

`app.js` routes canvas gestures because meaning depends on the active source:

```
bitmap drag  -> Renderer pan
drawing drag -> DrawingSource
wheel        -> Renderer zoom
```

Pan/zoom are renderer transforms, not source properties. Use pointer capture for
drag/draw interactions so leaving the canvas does not drop the interaction.

## UI and persistence conventions

- Keep native ES modules; do not introduce a framework without explicit need.
- Preserve existing DOM IDs unless a feature requires an HTML change.
- Renderer controls (symmetry, motion, feedback, bloom, etc.) stay shared across
  source types; `app.js` shows/hides source-specific controls.
- Workspace settings persist serialized renderer state via `app.js`.
- Bitmap data persists through `BitmapSource` / IndexedDB.
- Never persist GPU objects, renderer internals, DOM nodes, decoded `Image`
  objects, or transient interaction state.

## Change discipline

Prefer the smallest change that preserves boundaries:

- no `SourceManager` just to switch sources
- no source-specific behavior in `Renderer`
- no renderer transforms in source classes
- no unrelated rendering rewrites during structural refactors
- do not combine structural and visual changes unless required

## Verification

Run existing automated tests covering changed behavior, then browser-smoke the
relevant paths:

- bitmap load/restore
- source switching, when applicable
- drag/pan and wheel zoom
- symmetry controls
- feedback and timeline seek/rebuild
- bloom without unintended timeline rebuilds
- PNG export and recording

For drawing/high-frequency sources also verify:

- bitmap -> drawing -> bitmap restores the correct source
- incremental drawing does not clear feedback history
- pointer capture survives leaving the canvas
- fast strokes remain continuous
- unchanged frames are not repeatedly uploaded

Report what was tested and anything that could not be run.

## Maintaining this file

Update `AGENTS.md` only for durable module responsibilities, invariants, common
navigation hints, or standard verification steps. Do not add task-specific
plans, temporary debugging notes, or changelog history. Link to a dedicated
document if a topic needs substantial prose.
