# Drawing architecture

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
- Workspace drawing content is schema v1. Earlier workspace keys are ignored.

## Performance checks

Static append and preview updates must not replay historical committed artwork.
Source motion must not reconstruct or relocate the periodic material.
Static prepared geometry should be derived once per operation ID. The target
animation invariant is zero static derivations and rasterizations per tick.
