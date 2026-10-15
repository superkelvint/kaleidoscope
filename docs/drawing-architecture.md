# Drawing architecture

## Gesture → geometry → material

Durable drawing recipes use this explicit pipeline:

```text
Gesture → Geometry transform → StrokeGeometry → Material → BrushPainter → pixels
```

Schema-v4 paint operations store `gesture`, `geometry`, and `material`.
`gesture` is only the sampled input plus deterministic metadata such as its
seed. Geometry and material never mutate it. Generator operations store their
generator recipe and a material recipe; their geometry is the `generator`
transform.

`stroke-recipe.js` owns pure field partitioning, validation, and compatibility
conversion. New paint recipes store samples, seed, and frozen input mapping in
`gesture`; geometry controls in `geometry`; and palette, width, and brush
mechanics in `material`. Neither geometry nor material stores a second complete
style object. Generator seed/style belongs to its material recipe. The
controller's legacy `brush` selector is a derived runtime alias, not persisted
controller state.

Transient controller recipes borrow the controller-owned sample array. The
rasterizer freezes recipe metadata once and validates/copies only appended
samples (plus a possible last-sample hold update). Prefix replacements receive
full validation and reconstruction. Commit and restore take durable snapshots;
later caller mutations cannot alter accepted samples or document history.

`stroke-geometry.js` derives causal, prefix-stable `StrokeFrame` values, with
input-point and fixed-distance sampling. `stroke-material.js` registers Ink and
Silk renderers and path-session factories. Ink replay deposits the initial dab
and consecutive round segments in the same order as live input, including
translucent overlaps. Silk retains an exact structural spine and seeded,
tethered filaments. Its simulation survives appended input and consumes its
release tail after pointer-up. Reconstruction restores only tail steps already
shown; scratch curves expire by lifespan and emissions are not retained.

`stroke-renderer.js` provides one boundary for all materials:

- `prepareStroke(drawable, project)` returns bounds, an optional resource ID,
  and a `render(target, options)` method accepting backend-neutral painters.
- `createStrokeSession(drawable)` returns frozen-recipe acceptance, `advance`,
  `beginFinish`, `settle`, `reconstruct`, bounds, completion, and disposal.
- An optional accumulating live-preview capability supports time-sampled input.

The rasterizer neither converts old styles nor chooses a brush implementation.
Gradient Pen, Ribbon, Calligraphy, Spray, Texture, Fiber/Hair, and Wisp use the
registered adapter boundary; their established algorithms remain in their own
modules. These adapters implement the same preparation/session contract. Fiber
and Hair declare replacement-prefix raster behavior: a new prefix replaces the
current gesture against one transient backdrop snapshot. Other finishing
sessions stream into that snapshot without replaying consumed input. Completion
still promotes visible pixels and drops the snapshot; it never persists a layer
or replays a stroke to commit it.

Schema-v3 and earlier schema-v4 recipes restore through pure compatibility
conversion, retaining stable IDs, seed, mapping, and effective brush settings.
V3 adapter material-version behavior remains explicit. Saves use canonical
schema v4. Unsupported types, non-finite values, invalid palette/frame settings,
non-serializable state, and duplicate IDs are rejected before mutation. Restore
is atomic, operation type cannot change under a stable ID, and Undo remains one
session-only slot. Earlier document versions remain unsupported.

The drawing pipeline is deliberately change-driven:

```text
display pointer → DrawingController → immutable drawable
  → DrawingDocument → ChangeSet → DrawingRasterizer → DrawingSource frame → Renderer
```

`DrawingDocument` is durable semantic truth. It owns versioned operations,
stable IDs, background, validation, single-level undo, and destructive clear. It owns no
Canvas, time, texture, or renderer state. Mutation methods return a ChangeSet;
the rasterizer must never discover a change by comparing document snapshots.

`DrawingRasterizer` owns all derived state: prepared drawables, bounds,
time-dependent derivation/evaluation, resource metadata, sparse tiles, one fixed
finite raster material, preview, and pixel revision. It also owns the `RenderIndex` / spatial
index: operation ID maps to z-order, bounds, prepared geometry, time/resource
dependencies; each tile maps to relevant operation IDs. Tile reconstruction
queries that index rather than scanning the full document. Prepared static
drawables are keyed by operation ID so one geometry derivation can serve bounds
and rasterization.

`DrawingSource` is the only renderer source adapter. It applies document changes
to the rasterizer, forwards `setTime`, and exposes the finite material with
periodic (`repeat`) sampling to the renderer. The renderer never navigates an
infinite drawing world: source animation changes sampling coordinates, not where
the drawing cache lives. `prepareView()` may choose a quantized raster-density
tier but must never move or resize the semantic material domain. UI code must
never read rasterizer internals.

`BrushPainter` is the raster-backend seam. Canvas2D is today's painter backend;
brush and Fiber recipes are backend-independent material/path behavior, not a
permanent Canvas2D architectural constraint.

## Immediate paint completion

Normal immediate-paint completion is a pixel promotion, not a replay. Mouseup,
Wisp release-tail completion, starting another stroke, and ordinary session
commits retain the already-visible immediate raster and promote it with
canvas-to-canvas pixel copies only. Durable paint recipes and `RenderIndex`
bounds are saved at that point, while sparse tiles become lazy/stale caches.
Replay is reserved for unavailable or invalid derived material (restore,
undo/replace/clear, resolution changes, and texture recovery), never for a
normal session completion.

## Non-negotiable behavior

- A source-frame change is not renderer state and must retain feedback.
- `DrawingDocument` remains vector/procedural semantic truth; material pixels,
  tile caches, and raster density are derived and never persisted.
- Static-prefix/dynamic-tail and full-history high-zoom replay are current
  strategies, not architectural contracts. Preserve visual ordering and sharp
  magnification while allowing isolated dynamic content and future caches.
- Texture readiness invalidates only semantics affected by that resource; broad
  cache clears are an implementation fallback, not a contract.
- `clear()` discards all operations and the single Undo state.
- The workspace drawing wrapper is version 3; wrappers 1 and 2 can restore
  supported document recipes through the document migration boundary.

## Animation caches and performance checks

`drawing-raster-cache.js` caches consecutive static runs between animated
operations, preserving the single document order. The first static prefix is an
opaque material snapshot. Later runs cache source, transmission, and ceiling
surfaces so mixed source-over/additive paint can be applied against a changing
backdrop, including additive saturation followed by translucent paint. These
are transient run caches at material density, not durable per-operation layers.
No emitted-geometry history is retained. Canvas edge coverage may differ from a
fresh path rasterization; browser comparisons bound image error and separately
check fully covered saturated/translucent blends.

Animation ticks prepare/rasterize only time-dependent operations and composite
cached static runs. Static cache extension paints only newly appended operations.
Changes to affected recipes, background, resolution, or texture readiness
invalidate the relevant derived caches. The spatial index preserves document
z-order even when dynamic bounds move. Explicit tile requests rebuild stale
pixels lazily; the animation compositor never rebuilds full-history tiles on
an ordinary tick. An animated draft preview does not invalidate committed paint.

Static append and preview updates must not replay historical committed artwork.
Source motion must not reconstruct or relocate the periodic material. Static
prepared geometry is cached by operation ID. Verification must observe actual
paint destinations and preparation calls, rather than compatibility counters or
unused canvases. Warm animation ticks perform zero static preparations or
geometry rasterizations at native and magnified material densities.

Transparent tile caches cannot encode additive blending against a colored
background. Non-animated reconstruction on colored backgrounds replays document
order directly into the background-filled committed material. Normal immediate
completion always promotes already-deposited pixels without replay.
