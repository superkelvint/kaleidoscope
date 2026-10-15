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

`stroke-geometry.js` derives causal, prefix-stable `StrokeFrame` values. It
supports input-point and fixed-distance sampling. `stroke-material.js` owns
Ink and Silk and emits only `BrushPainter` instructions. Ink is one plain
source-over round centerline. Its replay deposits the initial dab and consecutive
round segments in the same order as live input, including translucent overlaps. Silk retains that exact centerline and adds
seeded core, secondary, and ghost filaments derived from frame normals and
absolute arc length; neither the filaments nor bounds are durable. Silk sessions
keep their seeded simulation across appended input and consume the release tail
after pointer-up. Reconstruction restores only the tail steps already shown.
Scratch curves expire by lifespan; emission histories are not retained.

Gradient Pen, Ribbon, Calligraphy, Spray, Texture, Fiber/Hair, and Wisp are intentional
transitional adapters. Their established algorithms remain in their owning
brush modules. Wisp retains its asynchronous release tail. The adapter is
explicit in the material recipe and must not become a source-type branch in
the renderer.

Schema-v3 documents restore as explicit adapter recipes with their original
material-version behavior and stable IDs. Saves use schema v4. Earlier document
versions remain unsupported. Derived canvases,
paint sessions, material bounds, and generated filament paths are not stored.

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

## Performance checks

Static append and preview updates must not replay historical committed artwork.
Source motion must not reconstruct or relocate the periodic material.
Static prepared geometry should be derived once per operation ID. The target
animation invariant is zero static derivations and rasterizations per tick.

Transparent tile caches cannot encode additive blending against a colored
background. Reconstruction on colored backgrounds replays document order
directly into the background-filled committed material. Normal immediate
completion still promotes already-deposited pixels without replay.
