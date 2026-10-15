# Kaleidoscope agent guide

Use this file as a map, not an encyclopedia. Keep durable architecture,
invariants, navigation hints, and verification rules here. Put detailed module
notes and task-specific plans elsewhere.

## Start here

| Task                                  | Read first                               |
| ------------------------------------- | ---------------------------------------- |
| UI/control wiring                     | `app.js`, then relevant HTML             |
| Rendering, animation, feedback, bloom | `render.js`                              |
| Bitmap source/persistence             | `bitmap-source.js`                       |
| Drawing durable state / undo          | `drawing-document.js`                    |
| Drawing raster/caches/PaintSessions   | `drawing-source.js`                      |
| Drawing pointer/tool lifecycle        | `drawing-controller.js`                  |
| Screen-to-source drawing mapping      | `drawing-mapping.js`                     |
| Brush mechanics / replay              | `brushes.js`, `brush-painter.js`         |
| Recipe fields and validation          | `stroke-recipe.js`                      |
| Prepared rendering / sessions         | `stroke-renderer.js`                    |
| Shared stroke frames                  | `stroke-geometry.js`                    |
| Ink/Silk materials and sessions        | `stroke-material.js`                    |
| Static animation composition caches   | `drawing-raster-cache.js`               |
| Wisp                                  | `wisp-brush.js`                          |
| Fiber/Hair                            | `fiber-brush.js`, then `brushes.js`      |
| Texture brush assets                  | `brush-textures.js`                      |
| Generator geometry                    | `drawable-path.js`, then `generators.js` |
| Local motif symmetry                  | `local-motif.js`                         |
| Global wallpaper symmetry             | `global-wallpaper.js`                    |
| Performance telemetry                 | `perf.js`                                |

Read the owning module before broad repository greps. Prefer targeted symbol
searches once ownership is clear.

For drawing changes that cross boundaries, read
`docs/drawing-architecture.md`.

---

## Core architecture

### Renderer

`render.js` owns GPU presentation:

- WebGL resources and source texture uploads
- local motif and global wallpaper rendering
- animation, feedback, bloom, timeline
- pan/zoom and presentation transforms

It must not know about specific source implementations.

**Do not add source-type branches to `Renderer`.**

### Sources

Renderer sources expose:

```js
source.getFrame()
```

returning `null` or:

```js
{ pixels, width, height, revision, world? }
```

Rules:

- A source owns its pixels, dimensions, and monotonic `revision`.
- Increment `revision` when source pixels change.
- `getFrame()` is non-destructive.
- `Renderer` owns GPU upload state.
- A source mutation is not a renderer-state mutation.

---

## Drawing execution model

There are two fundamentally different operation types.

### PaintOperation — immediate mode

Paint brushes deposit pixels while the gesture is happening.

```text
pointer/input
    ↓
PaintSession
    ↓
pixels deposited immediately
    ↓
gesture finishes
    ↓
PaintOperation stored for reconstruction
```

A durable `PaintOperation` stores the input/style needed to reconstruct the
stroke later. It is **not authoritative retained raster state**.

**Paint completion changes history, not pixels.**

Normal paint completion must not discard the live result and repaint the
stored operation just to "commit" it.

Replay exists for reconstruction: restore, cache/material loss, undo rebuild,
export, resolution changes, and similar cases.

### GeneratorOperation — retained mode

Generators are retained state.

```text
GeneratorOperation
    ↓
generator config / animation / sampling
    ↓
derived geometry
    ↓
pixels
```

The generator recipe is authoritative. Changing generator state may require
recomposition.

Current generators include Spirograph and Guilloché Rosette.

### One ordered document

Paint and generator operations share one global operation sequence:

```text
Paint A
Generator X
Paint B
Generator Y
Paint C
```

They are not separate layer stacks.

---

## PaintSessions

A `PaintSession` is transient runtime state for an in-progress or finishing
paint gesture.

Rules:

- PaintSessions are never persisted.
- They own transient brush state such as RNG, tangent continuity, spacing,
  particles, or release-tail state.
- They deposit pixels incrementally.
- A PaintSession may continue briefly after pointer-up if the brush has a
  finishing phase.
- Raster/material loss may reconstruct the already-visible PaintSession state.
- Multiple PaintSessions may coexist when an older stroke is still finishing.
- Exact microscopic interleaving of concurrent PaintSessions does not need to
  survive later durable reconstruction.

**Do not create durable per-operation pixel layers or deposit logs to preserve
live interleaving.**

### Generator mutation gate

Do not create, edit, remove, or otherwise mutate retained generator state while
any PaintSession is active or finishing.

This prevents retained recomposition from racing unresolved immediate paint.
Durable replace, undo, clear, and restore also wait for PaintSessions to finish;
they must not discard an active gesture or its release tail.

---

## Undo semantics

Undo is one global single-use slot, not a stack.

```text
Paint commit       -> one undo
Generator commit   -> one undo
Generator edits    -> no new undo
```

A generator draft is preview-only. Committing it creates one
`GeneratorOperation` and one undoable creation action.

Subsequent property edits mutate that retained operation by stable ID and do
not create additional undo actions.

Do not casually change this behavior.

---

## Drawing module ownership

### `drawing-document.js`

Owns durable semantic truth:

- schema-v4 `PaintOperation` and `GeneratorOperation`
- stable IDs
- background
- validation
- single-level undo
- persistence
- replace-by-ID / clear

Every durable mutation returns an explicit ChangeSet.

It owns no Canvas, renderer, time, texture, pointer, or cache state.

### `drawing-source.js`

`DrawingSource` is the renderer-facing facade.

`DrawingRasterizer` owns derived raster mechanics:

- material canvases
- sparse tiles
- RenderIndex / bounds
- periodic copies
- composition and invalidation
- transient PaintSession orchestration
- previews
- raster reconstruction

It must remain WebGL-free.

**The rasterizer owns raster mechanics, not brush mechanics.**

Do not accumulate branches such as:

```js
if (brush === "wisp") ...
else if (brush === "fiber") ...
```

Brush-specific simulation and mechanics belong in the brush layer behind a
brush-neutral transient/replay contract.

### `drawing-controller.js`

Owns:

- pointer lifecycle
- tools and constraints
- input sampling
- frozen gesture style
- PaintSession start/update/finish
- constructed gesture interaction

It does not own raster caches, generator geometry, or renderer transforms.

### `drawing-mapping.js`

Owns frozen screen-to-source mapping for drawing input.

Do not reimplement renderer transforms ad hoc in the controller or brushes.

### `brushes.js` / `brush-painter.js`

Own brush mechanics and backend-neutral paint instructions.

Brushes receive mapped source coordinates and style. They must not depend on:

- pointer DOM events
- renderer state
- symmetry mapping
- drawing history
- WebGL

Transient brush state belongs to the PaintSession-side brush implementation,
not durable document state.

### Specialized brushes

`wisp-brush.js` owns Wisp simulation and source-faithful invariants.

Wisp is an immediate-mode PaintOperation, not a generator. It has transient
simulation state and an asynchronous release tail. Read its module-level
invariants before changing its mechanics.

Hot Wisp rendering should stream emissions; do not restore a full-stroke
`emissions[]` history or rescan the entire consumed input prefix on every new
sample.

`fiber-brush.js` owns deterministic Fiber/Hair material generation. Keep it
independent of drawing history, renderer state, WebGL, pointer events, and DOM.

### `generators.js` / `drawable-path.js`

`generators.js` owns pure normalized mathematical recipes and validation.

`drawable-path.js` owns conversion of a durable `GeneratorOperation` into
transient source-space contours at project time.

Brushes must not contain generator geometry.

Generator recipes must remain deterministic for a given durable state and time.

---

## Coordinate and symmetry model

There are two distinct symmetry layers:

1. global wallpaper/grid symmetry
2. local kaleidoscope motif symmetry

Conceptual visual direction:

```text
source
  -> local motif
  -> global wallpaper/grid
  -> screen
```

Fragment-shader lookup direction:

```text
screen
  -> global wallpaper map
  -> local motif map
  -> source
```

These are the same transform viewed in opposite directions.

Do not:

- move local motif logic into `global-wallpaper.js`
- implement wallpaper groups as local motif effects
- reorder the mapping casually
- duplicate screen-to-source math independently

A result can show more apparent symmetry than the selected wallpaper group if
the local motif contributes additional symmetry.

---

## Persistence

Persist:

- renderer state
- drawing schema-v4 document state (schema-v3 recipes restore through explicit adapters)
- controller settings
- bitmap source data through `BitmapSource`

Do not persist:

- PaintSessions
- particle systems / live brush simulation state
- emitted Wisp/Fiber geometry
- Canvas objects
- sparse tiles
- raster checkpoints
- prepared geometry caches
- GPU objects
- DOM nodes

For PaintOperations, stored samples/style are reconstruction input.

For GeneratorOperations, stored generator state is authoritative.

---

## Performance invariants

High-frequency drawing paths must not:

- replay historical committed artwork on every input sample
- rebuild the timeline on every pointer event
- resync the full UI on every pointer event
- write localStorage on every pointer event
- retain O(total emitted brush geometry) temporary histories without need

Static committed content should not be repeatedly derived or rasterized merely
because project time changes.

Use `perf.js` for meaningful debug-gated hot-stage timing instead of ad-hoc
production timers.

---

## Change discipline

First classify the change by owner:

```text
UI/orchestration        -> app.js
pointer/tool behavior   -> drawing-controller.js
screen/source mapping   -> drawing-mapping.js
durable state / undo    -> drawing-document.js
raster/cache/session    -> drawing-source.js
brush mechanics         -> brush module
generator math          -> generators.js / drawable-path.js
GPU/symmetry/display    -> render.js
```

Prefer the smallest change that preserves these boundaries.

Do not:

- add source-specific behavior to `Renderer`
- put brush physics in `DrawingRasterizer`
- put generator geometry in brushes
- persist derived raster state
- combine structural refactors with unrelated visual changes

---

## Bug-fix discipline

For reported defects:

1. Trace the real owning path.
2. Add a focused regression test that fails for the reported reason.
3. Implement the smallest fix.
4. Run focused and affected tests.
5. Browser-smoke the real interaction when the bug is interactive.

Do not claim an interactive bug fixed solely from a low-level unit test.

---

## Verification

For drawing changes, verify the affected invariants.

### Paint

- paint deposits incrementally during the gesture
- completion does not repaint the stroke
- fast strokes remain continuous
- active/finishing PaintSessions survive required raster reconstruction
- source switching restores the correct pixels

### Wisp / stateful brushes

- Wisp release tail continues after pointer-up and then stops
- Wisp reconstruction restores only the already-visible tail progress
- stationary samples remain meaningful
- stateful RNG/tangent/spacing behavior remains deterministic
- periodic copies do not advance logical brush state multiple times

### Generators

- draft changes do not mutate durable state
- Commit creates one GeneratorOperation
- generator creation creates one undo
- generator property edits create no additional undo
- generator mutation is blocked while PaintSessions are active/finishing
- animated generators follow project time
- workspace restore preserves generator recipe/style

### Renderer/source

- incremental drawing does not unnecessarily reset feedback
- unchanged source frames are not repeatedly uploaded
- symmetry/mapping behavior is unchanged
- bloom/post-processing changes do not cause unrelated reconstruction

Report what was tested and anything that could not be run.

---

## Maintaining this file

Keep only durable architecture, invariants, navigation hints, and standard
verification rules here.

If an implementation detail requires substantial explanation, document it in
the owning module or `docs/` and link to it from here.
