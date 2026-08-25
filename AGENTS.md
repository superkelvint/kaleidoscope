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
| Drawing durable content               | `drawing-document.js`                          |
| Drawing pixels/caches                 | `drawing-source.js` (`DrawingRasterizer`)      |
| Basic drawing source                  | `drawing-source.js`, then `app.js`             |
| BrushPainter raster backend           | `brushes.js`                                   |
| Assisted Fiber material rendering     | `fiber-brush.js`, then `brushes.js`            |
| Brush texture assets/caching           | `brush-textures.js`, then `brushes.js`         |
| Development performance telemetry      | `perf.js`                                      |
| Local motif symmetry mapping          | `local-motif.js`                               |
| Drawing pointer mapping               | `drawing-mapping.js`                           |
| Drawing interaction/tools             | `drawing-controller.js`                        |
| Smart gesture recognition             | `gesture-interpreter.js`                       |
| Arc/Bezier construction sampling      | `constructed-strokes.js`                       |
| Procedural drawable geometry          | `drawable-path.js`, then `generators.js`       |
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

### Drawing pipeline

The drawing path is `controller → immutable drawable → document → ChangeSet →
rasterizer → source frame → renderer`. Read
[`docs/drawing-architecture.md`](docs/drawing-architecture.md) before changing
more than one drawing boundary.

`drawing-document.js` exports `DrawingDocument`, the durable semantic truth:
versioned operations with stable IDs, background, validation, single-level undo,
replace-by-ID, destructive clear, and persistence. It owns no Canvas, renderer,
time, texture, or cache state. Every mutation returns an explicit ChangeSet;
never make the rasterizer infer changes by comparing snapshots.

`drawing-source.js` exports `DrawingSource` and `DrawingRasterizer`.
`DrawingSource` is the renderer-facing facade: frame/view/time/preview plus
document mutation and query APIs. UI code must use `getDrawable`,
`findLatestDrawable`, `canUndo`, and `operationCount`; it must never inspect operation
arrays, tiles, canvases, or atlas state.

`DrawingRasterizer` owns all derived raster state: prepared drawable geometry
and bounds keyed by operation ID, time-dependent derivation/evaluation, a
RenderIndex (operation ID → z-order/bounds/dependencies and tile → relevant
operation IDs), sparse tiles, prepared atlas, preview, texture readiness,
invalidation, and frame revision. It remains WebGL-free and has no pointer,
renderer mapping, tool, persistence, or DOM UI state. `DrawingSource.setTime`
only forwards project time; it does not derive paths.

Static-prefix caching and high-zoom path replay preserve current output, but are
implementation strategies—not drawing architecture. The durable requirements
are z-order correctness, sharp magnification, and no static-work amplification
on future animation ticks.

Missing texture assets are loaded through `brushTextureCatalog`; when a texture
becomes ready, invalidate the affected raster-derived state and rerender.
`onFrameChange` only requests presentation—it does not turn a source-pixel
update into renderer state.

### Drawing mapping and controller

`local-motif.js` owns the CPU local motif transform and its GLSL counterpart.
`drawing-mapping.js` owns frozen screen-to-source mapping, including wallpaper,
motif, transforms, aspect correction, and Canvas Y inversion.
`drawing-controller.js` owns pointer lifecycle, tools, constraints, previews,
and immutable drawable styles; it commits `pathStroke` drawables to
`DrawingSource`.

`gesture-interpreter.js` is pure display-space smart-gesture recognition and
canonical gesture sampling. `constructed-strokes.js` is pure display-space arc
and cubic Bézier sampling. `DrawingController` freezes the renderer mapping at
gesture start and maps their resulting points to source space; neither helper
may acquire Canvas, renderer, source, or DOM dependencies.

### Procedural drawables

`generators.js` contains pure, normalized mathematical recipes, limits,
validation, and time-frame helpers—no Canvas, DOM, renderer, or persistence
concerns. A generator has a stable `id`, a version, defaults, a normalized
sampler, and a period. Bump its version when changing the durable recipe
meaning; old `generatedStroke` records are deliberately rejected rather than
silently reinterpreted.

The current recipes are `spirograph` and `guillocheRosette`. Guilloché rosettes
are a family of closed contours: the shared frame computes animation once per
draw, and the geometry blends adjacent *integer* secondary frequencies so a
motion frame remains closed at its seam. Keep the math normalized and
deterministic for a given recipe and time.

`drawable-path.js` validates durable `generatedStroke` records, bounds
parameter sampling, and converts normalized geometry to one transient
pixel-space contour family. It is the only layer that knows how a
`generatedStroke` executes. A durable generated stroke contains its
generator/version, `config`, `animation`, parameter `domain`/`sampling`, and
immutable brush `style`; it has no per-generator placement state.

`DrawingRasterizer` evaluates generic paths at project time and rerenders only
when committed or preview content depends on time. `DrawingSource` forwards the
time update. Drawing is a continuous,
unbounded drawing world: sparse tiles and prepared atlases paint each drawable
only at its actual world coordinates. Brushes remain
contour/path replay only: they must not contain generator-specific geometry or
placement logic.

### `brushes.js` — brush rendering

Defines the `BrushPainter` raster-backend seam and today's Canvas2D painter.
Brushes receive mapped source coordinates and paint options; they must not
depend on pointer events, source revisions, renderer state, WebGL, or symmetry
mapping. Do not make Canvas2D a durable brush or Fiber architectural contract.

### `fiber-brush.js` — assisted Fiber material

Owns the deterministic Fiber material recipe: bounded master-path derivation,
population generation, gradient sampling, lifecycles, fan-out, branches, and
preview population reduction. It receives an immutable path/style snapshot and
must remain independent of pointer events, drawing history, renderer state,
WebGL, and DOM UI. Fiber stroke version, seed, and user controls are persisted
in the `pathStroke` style and must replay identically.

### `brush-textures.js` — texture brush resources

Owns the explicit PNG catalog, async decode, alpha-mask normalization,
thumbnails, and bounded tinted-tip cache used by the `texture` Canvas2D brush.
It must remain independent of drawing history and UI selection. Keep the asset
catalog explicit because the native-module app has no build-time asset glob.

### `perf.js` — development performance telemetry

Owns debug-gated rolling timing measurement shared by rendering stages. It is
runtime-only and must stay negligible when the debug flag is disabled.

Use `measure(label, work)` around meaningful hot stages rather than adding
ad-hoc timers. Telemetry is enabled only with
`globalThis.__KALEIDOSCOPE_DEBUG_PERF__`; it accumulates rolling stats under
`globalThis.__KALEIDOSCOPE_PERF_TIMINGS__` and must not affect normal behavior.

### `app.js` — orchestration/UI

Owns DOM/event wiring, control synchronization, active-source selection, pointer
routing, workspace persistence/status, and export/recording UI. Do not move
rendering math, GPU work, or source persistence here.

It also owns generator draft/edit UI, reference-image overlay UI, brush-browser
UI, and presentation-only FPS reporting. Generator drafts are previews; commits
and edits use stable-ID `DrawingSource` document query/mutation APIs. The renderer's `onBeforeFrame`
advances `DrawingSource` time, while its frame-change callback merely requests a
render so drawing mutations remain incremental source updates.

## Source contract

Every renderer source implements:

```
source.getFrame()
```

returning `null` or:

```
{ pixels, width, height, revision, world? }
```

Rules:

- Sources own pixels, dimensions, and monotonic `revision`.
- Increment `revision` whenever source pixels change.
- `getFrame()` is non-destructive.
- `world` is optional metadata for unbounded sources: `{ origin, extent, scale,
  wrap }`, where `origin` and `extent` describe the prepared world region,
  `scale` is the source-world scale used by mapping, and `wrap` declares source
  sampling semantics. Bounded bitmap sources omit it.
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
- Drawing content persists `DrawingSource.getContentState()` and controller
  settings; generated strokes persist their durable recipes, never sampled
  contour caches or motif canvases.
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

## Bug-fix discipline

For a reported defect, do not implement a speculative fix first.

1. Trace the reported behavior through the real owning path, including UI,
   controller, persistence, and rendering boundaries where applicable.
2. Add a focused automated regression test that reproduces the reported failure
   through that path. Run it and confirm it fails for the stated reason.
3. Implement the smallest fix that makes the new test pass.
4. Run the focused regression test and all existing tests covering affected
   behavior.
5. Do not report a bug fixed solely because unit tests pass when the report is
   about browser interaction; browser-smoke the exact reported interaction, or
   explicitly state that it could not be run.

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

For generators and texture brushes also verify:

- draft preview, commit, edit, undo, and workspace restore preserve the
  generated recipe and style
- an animated generator changes with timeline time, while static drawing does
  not cause a source rerasterization on timeline ticks
- distant sparse tiles and prepared atlases do not replay artwork outside its
  actual world bounds during linear drift
- texture selection survives async asset loading and causes a replay when its
  mask becomes available
- Guilloché animation keeps closed contours at its frequency-transition seam

Report what was tested and anything that could not be run.

For interactive bugs, tests must cover the highest practical integration
boundary; a renderer-only test does not validate controller/UI wiring.

## Drawing change protocol

First classify the change: durable document, pointer/tool, screen-to-source
mapping, path/generator, brush, or derived raster/cache. Change only its owner,
add a failing regression at the highest practical boundary, then run the
relevant unit tests and browser smoke.

For performance-sensitive drawing changes, preserve these checks: static append
and preview updates do not replay historical committed artwork; safe-region view
movement does not reconstruct the committed atlas; static prepared geometry is
not re-derived for bounds and rasterization. The target animation contract is
that static drawables are neither derived nor rasterized on a time tick.

## Maintaining this file

Update `AGENTS.md` only for durable module responsibilities, invariants, common
navigation hints, or standard verification steps. Do not add task-specific
plans, temporary debugging notes, or changelog history. Link to a dedicated
document if a topic needs substantial prose.
