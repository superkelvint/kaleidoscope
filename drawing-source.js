import { brushTextureCatalog } from "./brush-textures.js";
import { paintBrushInstructions } from "./brush-painter.js";
import { validStrokeRecipe, validPaintSamples, validPaintSessionUpdate } from "./stroke-recipe.js";
import { drawableDependsOnTime } from "./drawable-path.js";
import { count, measure } from "./perf.js";
import { StaticRunCache } from "./drawing-raster-cache.js";
import { DrawingDocument } from "./drawing-document.js";
import { createStrokeLivePreview, createStrokeSession, prepareStroke, strokeDescription } from "./stroke-renderer.js";

const TILE_SIZE = 1024;
const ANTIALIAS_PADDING = 2;
const MAX_MATERIAL_PIXELS = 4096;
function createPaintCanvas(width, height) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height; return canvas;
}
function finite(value) { return Number.isFinite(Number(value)) ? Number(value) : 0; }
function tileKey(x, y) { return `${x},${y}`; }
function floorTile(value) { return Math.floor(value / TILE_SIZE); }
// The document persists explicit operation records. The rasterizer keeps a
// transient drawable projection so the geometry/brush seam stays unchanged.
function drawableForOperation(operation) {
  if (operation?.type === "PaintOperation") return { kind: "pathStroke", gesture: operation.gesture, geometry: operation.geometry, material: operation.material };
  if (operation?.type === "GeneratorOperation") {
    const { generator, generatorVersion, config, animation, domain, sampling, material } = operation;
    return { kind: "generatedStroke", generator, generatorVersion, config, animation, domain, sampling, geometry: { type: "generator" }, material };
  }
  return operation?.drawable || null;
}
function rasterOperation(operation) { return { ...structuredClone(operation), drawable: drawableForOperation(operation) }; }
function isPaintSessionDrawable(drawable) { return drawable?.kind === "pathStroke" && validStrokeRecipe(drawable); }
function drawablePoints(drawable) { return drawable?.gesture?.points || []; }
function padBounds(bounds, padding = ANTIALIAS_PADDING) {
  return bounds && { left: Math.floor(bounds.left - padding), top: Math.floor(bounds.top - padding), right: Math.ceil(bounds.right + padding), bottom: Math.ceil(bounds.bottom + padding) };
}
class RenderIndex {
  constructor() { this.operations = new Map(); this.tiles = new Map(); this.order = new Map(); }
  clear() { this.operations.clear(); this.tiles.clear(); this.order.clear(); }
  add(operation, bounds, materialBounds) {
    if (!operation?.id || !bounds) return;
    if (!this.order.has(operation.id)) this.order.set(operation.id, this.order.size);
    this.operations.set(operation.id, operation);
    for (const translation of periodicTranslations(bounds, materialBounds, materialBounds)) {
      const shifted = { left: bounds.left + translation.x, top: bounds.top + translation.y, right: bounds.right + translation.x, bottom: bounds.bottom + translation.y };
      for (let y = floorTile(shifted.top); y <= floorTile(shifted.bottom); y += 1) for (let x = floorTile(shifted.left); x <= floorTile(shifted.right); x += 1) {
        const key = tileKey(x, y); if (!this.tiles.has(key)) this.tiles.set(key, new Set()); this.tiles.get(key).add(operation.id);
      }
    }
  }
  remove(id) {
    this.operations.delete(id);
    for (const [key, ids] of this.tiles) { ids.delete(id); if (!ids.size) this.tiles.delete(key); }
  }
  forTile(x, y) { return [...(this.tiles.get(tileKey(x, y)) || [])].map(id => this.operations.get(id)).filter(Boolean).sort((a, b) => this.order.get(a.id) - this.order.get(b.id)); }
}
function periodicTranslations(bounds, material, target) {
  if (!bounds || !material || !target) return [];
  const minX = Math.ceil((target.left - bounds.right) / material.width);
  const maxX = Math.floor((target.left + target.width - bounds.left) / material.width);
  const minY = Math.ceil((target.top - bounds.bottom) / material.height);
  const maxY = Math.floor((target.top + target.height - bounds.top) / material.height);
  const translations = [];
  for (let y = minY; y <= maxY; y += 1) for (let x = minX; x <= maxX; x += 1) translations.push({ x: x * material.width, y: y * material.height });
  return translations;
}
function hasChangedPaintGeometry(previous = [], next = [], count = 0) {
  if (previous.length < count || next.length < count) return true;
  for (let index = 0; index < count; index += 1) {
    // Paint-session samples can be compacted by the controller to keep the
    // durable path bounded. A compacted prefix has the same length as the
    // already-consumed prefix, but different coordinates (or hold counts).
    const { holdCount: previousHold, ...previousPoint } = previous[index] || {};
    const { holdCount: nextHold, ...nextPoint } = next[index] || {};
    if (JSON.stringify(previousPoint) !== JSON.stringify(nextPoint)) return true;
  }
  return false;
}
/** Derived Canvas2D state only: tiles, finite material, previews, and raster revisions. */
export class DrawingRasterizer {
  constructor({ width = 2048, height = 2048, onFrameChange = () => {} } = {}) {
    this.width = Math.max(1, Math.floor(width)); this.height = Math.max(1, Math.floor(height));
    this.canvas = createPaintCanvas(this.width, this.height); this.ctx = this.canvas.getContext("2d");
    this.committedCanvas = createPaintCanvas(this.width, this.height); this.committedCtx = this.committedCanvas.getContext("2d"); this.committedDirty = true;
    this.materialBounds = { left: 0, top: 0, width: this.width, height: this.height };
    this.materialScale = 1; this.requestedPixelDensity = 1; this.materialRebuildCount = 0;
    this.tiles = new Map(); this.committedRasterGeneration = 0; this.operations = []; this.preview = null; this.livePreview = null;
    // Immediate paint is deliberately separate from committed reconstruction.
    // It is only discarded when a document-driven recomposition is necessary.
    this.paintSessions = new Map(); this.hasImmediatePixels = false; this.immediateIsComposite = false; this.activeReconcilePending = false;
    this.immediateCanvas = createPaintCanvas(this.width, this.height); this.immediateCtx = this.immediateCanvas.getContext("2d");
    this.backgroundColor = "#000000"; this.time = 0; this.revision = 0; this.onFrameChange = onFrameChange;
    this.pendingTextureReplays = new Set();
    // Bounds are derived cache metadata, never durable drawable state. They
    // let a newly exposed sparse tile skip expensive off-tile brush replay.
    this.preparedDrawables = new Map();
    this.renderIndex = new RenderIndex();
    this.staticPrefixEnd = 0;
    this.compositionCheckpoints = [];
    this.staticRunCaches = new Map();
    this.composeMaterial();
  }

  getWorldScale() { return { width: this.width, height: this.height }; }
  getFrame() { return { pixels: this.canvas, width: this.canvas.width, height: this.canvas.height, revision: this.revision, world: { origin: { x: this.materialBounds.left, y: this.materialBounds.top }, extent: { width: this.materialBounds.width, height: this.materialBounds.height }, scale: { width: this.width, height: this.height }, wrap: "repeat" } }; }
  isDrawable(drawable) { return validStrokeRecipe(drawable) && (drawable.kind !== "pathStroke" || drawablePoints(drawable).length > 0); }
  markFrameChanged() { this.revision += 1; this.onFrameChange(); }
  perfMetadata(extra = {}) {
    return {
      committedOperationCount: this.operations.length,
      activePreviewPointCount: drawablePoints(this.preview).length,
      materialBounds: { ...this.materialBounds },
      materialPixels: { width: this.canvas.width, height: this.canvas.height },
      requestedPixelDensity: this.requestedPixelDensity,
      materialRebuildCount: this.materialRebuildCount,
      committedDirty: this.committedDirty,
      ...extra
    };
  }

  previewDrawable(drawable) {
    this.preview = this.isDrawable(drawable) ? structuredClone(drawable) : null;
    if (!this.preview) this.disposeLivePreview();
    else this.advanceLivePreview(this.preview);
    return measure("Drawing preview drawable", () => this.rerender(), () => this.perfMetadata());
  }
  disposeLivePreview() {
    this.livePreview?.session?.dispose?.();
    this.livePreview = null;
  }
  advanceLivePreview(drawable) {
    let session = this.livePreview?.session;
    if (session && !session.acceptsDrawable(drawable)) this.disposeLivePreview();
    session = this.livePreview?.session;
    if (!session) {
      session = createStrokeLivePreview(drawable);
      if (!session) return false;
      if (this.committedDirty) this.composeCommittedMaterial();
      const canvas = createPaintCanvas(this.canvas.width, this.canvas.height), context = canvas.getContext("2d");
      context.drawImage(this.committedCanvas, 0, 0);
      this.livePreview = { canvas, context, session };
    }
    const consumedBefore = session.consumedSampleCount;
    if (drawablePoints(drawable).length < consumedBefore) return false;
    const advanced = measure("Drawing live brush preview simulation", () => session.advance(drawablePoints(drawable).slice(consumedBefore)), () => this.perfMetadata({ newSampleCount: session.consumedSampleCount - consumedBefore, activeParticleCount: session.activeParticleCount }));
    if (!advanced) return false;
    const bounds = session.deltaBounds();
    if (!bounds) { session.finishDelta?.(); return false; }
    const sx = this.canvas.width / this.materialBounds.width, sy = this.canvas.height / this.materialBounds.height;
    const context = this.livePreview.context;
    context.save(); context.translate(-this.materialBounds.left * sx, -this.materialBounds.top * sy); context.scale?.(sx, sy);
    for (const translation of periodicTranslations(bounds, this.materialBounds, this.materialBounds)) {
      context.save(); context.translate(translation.x, translation.y);
      measure("Drawing live brush preview paint", () => session.paintDelta(context), () => this.perfMetadata({ newSampleCount: session.consumedSampleCount - consumedBefore, activeParticleCount: session.activeParticleCount }));
      context.restore();
    }
    context.restore(); session.finishDelta?.();
    return true;
  }
  rebaseLivePreview() {
    const preview = this.livePreview;
    if (!preview) return;
    const { context, session } = preview;
    context.clearRect(0, 0, preview.canvas.width, preview.canvas.height); context.drawImage(this.committedCanvas, 0, 0);
    const sx = this.canvas.width / this.materialBounds.width, sy = this.canvas.height / this.materialBounds.height;
    context.save(); context.translate(-this.materialBounds.left * sx, -this.materialBounds.top * sy); context.scale?.(sx, sy);
    for (const translation of periodicTranslations(session.bounds, this.materialBounds, this.materialBounds)) {
      context.save(); context.translate(translation.x, translation.y); session.reconstruct(context); context.restore();
    }
    context.restore();
  }
  captureCompositionCheckpoint() {
    if (this.paintSessions.size || this.hasImmediatePixels) return;
    if (this.operations.some(operation => drawableDependsOnTime(operation.drawable))) return;
    this.composeCommittedMaterial();
    const canvas = createPaintCanvas(this.committedCanvas.width, this.committedCanvas.height);
    canvas.getContext("2d").drawImage(this.committedCanvas, 0, 0);
    this.compositionCheckpoints.push({ index: this.operations.length, canvas, width: canvas.width, height: canvas.height });
    if (this.compositionCheckpoints.length > 12) this.compositionCheckpoints.shift();
  }
  rebuildFrom(view, changedIndex = 0) {
    this.invalidateStaticRuns(changedIndex);
    this.backgroundColor = view.backgroundColor;
    this.operations = view.operations.map(rasterOperation);
    this.paintSessions.clear(); this.immediateCtx.clearRect(0, 0, this.immediateCanvas.width, this.immediateCanvas.height); this.hasImmediatePixels = false; this.immediateIsComposite = false; this.activeReconcilePending = false;
    this.preview = null; this.disposeLivePreview(); this.tiles.clear(); this.preparedDrawables.clear(); this.rebuildBase();
    this.compositionCheckpoints = this.compositionCheckpoints.filter(checkpoint => checkpoint.index <= changedIndex && checkpoint.width === this.committedCanvas.width && checkpoint.height === this.committedCanvas.height);
    const checkpoint = this.compositionCheckpoints.at(-1);
    if (checkpoint) {
      this.committedCtx.clearRect(0, 0, this.committedCanvas.width, this.committedCanvas.height); this.committedCtx.drawImage(checkpoint.canvas, 0, 0);
      const sx = this.canvas.width / this.materialBounds.width, sy = this.canvas.height / this.materialBounds.height;
      for (let index = checkpoint.index; index < this.operations.length; index += 1) this.paintOperation(this.operations[index], this.committedCtx, { periodic: true, transform: { x: -this.materialBounds.left, y: -this.materialBounds.top, sx, sy } });
      this.committedDirty = false;
    } else this.invalidateCommittedView();
    this.rerender(); this.captureCompositionCheckpoint();
  }
  reconcileImmediateRaster() {
    this.immediateCtx.clearRect(0, 0, this.immediateCanvas.width, this.immediateCanvas.height); this.hasImmediatePixels = false; this.immediateIsComposite = false;
    for (const session of this.paintSessions.values()) session.backdrop = null;
    this.activeReconcilePending = true;
  }
  rebuildActiveImmediateRaster() {
    this.activeReconcilePending = false;
    // Completed operations are now represented by the reconstructed committed
    // material. Only active/finishing sessions are redrawn into the overlay.
    for (const session of this.paintSessions.values()) {
      if (!drawablePoints(session.drawable).length) continue;
      const input = session.drawable;
      let batches;
      if (session.rebuildRenderer) {
        session.renderer?.dispose?.();
        session.renderer = createStrokeSession(session.drawable);
        batches = session.renderer?.advance(input) || [];
        session.rebuildRenderer = false;
      } else {
        // Reuse visible simulation progress, including a partially consumed
        // release tail. Material loss must not restart or finish the tail.
        batches = session.renderer?.reconstruct(input) || [];
      }
      session.consumed = drawablePoints(session.drawable).length;
      this.paintSessionInstructions(batches, session);
    }
  }
  applyChange(change, view) {
    if (!change) return false;
    if (change.type === "append") {
      this.preview = null; this.disposeLivePreview();
      if (change.operation?.type === "GeneratorOperation") this.rebuildFrom(view, change.index);
      else this.appendOperation(rasterOperation(change.operation));
      return true;
    }
    if (change.type === "background") { this.invalidateStaticRuns(); this.backgroundColor = change.after; this.disposeLivePreview(); this.reconcileImmediateRaster(); this.invalidateCommittedView(); this.rerender(); return true; }
    if (change.type === "clear") { this.invalidateStaticRuns(); this.preview = null; this.disposeLivePreview(); this.paintSessions.clear(); this.immediateCtx.clearRect(0, 0, this.immediateCanvas.width, this.immediateCanvas.height); this.hasImmediatePixels = false; this.immediateIsComposite = false; this.activeReconcilePending = false; this.operations = []; this.tiles.clear(); this.preparedDrawables.clear(); this.renderIndex.clear(); this.staticPrefixEnd = 0; this.compositionCheckpoints = []; this.invalidateCommittedView(); this.rerender(); return true; }
    // Replacement and undo have non-local z-order effects. Rebuild from the
    // authoritative document rather than guessing from two snapshots.
    this.rebuildFrom(view, change.index || 0); return true;
  }
  setTime(time) {
    const next = Number(time); if (!Number.isFinite(next) || next === this.time) return false;
    this.time = next;
    const animated = this.operations.filter(operation => drawableDependsOnTime(operation.drawable));
    if (!animated.length && !drawableDependsOnTime(this.preview)) return false;
    if (animated.length) {
      this.reconcileImmediateRaster();
      // Explicit tile requests still reconstruct current pixels lazily. The
      // animation compositor uses static runs, not full-history tile rebuilds.
      this.committedRasterGeneration += 1;
      for (const operation of animated) {
        this.renderIndex.remove(operation.id);
        this.renderIndex.add(operation, this.boundsForOperation(operation), this.materialBounds);
      }
      this.invalidateCommittedView();
    }
    this.rerender(); return true;
  }
  invalidateStaticRuns(changedIndex = 0) {
    for (const [key, run] of this.staticRunCaches) if (run.end > changedIndex) this.staticRunCaches.delete(key);
  }
  composeAnimatedMaterial(context, transform) {
    const used = new Set();
    let index = 0;
    while (index < this.operations.length) {
      const operation = this.operations[index];
      if (drawableDependsOnTime(operation.drawable)) {
        this.paintOperation(operation, context, { periodic: true, transform }); index += 1; continue;
      }
      const start = index;
      while (index < this.operations.length && !drawableDependsOnTime(this.operations[index].drawable)) index += 1;
      const key = `${start === 0 ? "prefix" : "run"}:${operation.id}`;
      used.add(key);
      let run = this.staticRunCaches.get(key);
      if (!run) {
        run = new StaticRunCache({ createCanvas: createPaintCanvas, width: this.canvas.width, height: this.canvas.height, backgroundColor: start === 0 ? this.backgroundColor : null });
        this.staticRunCaches.set(key, run);
      }
      for (let offset = run.operationIds.length; offset < index - start; offset += 1) {
        const next = this.operations[start + offset];
        this.paintOperation(next, run.context, { periodic: true, transform, painter: run.painter });
        run.operationIds.push(next.id);
      }
      run.end = index; run.compositeInto(context);
    }
    for (const key of this.staticRunCaches.keys()) if (!used.has(key)) this.staticRunCaches.delete(key);
  }

  appendOperation(operation) {
    this.invalidateStaticRuns(this.operations.length);
    this.operations.push(operation);
    this.renderIndex.add(operation, this.boundsForOperation(operation), this.materialBounds);
    const timeDependent = drawableDependsOnTime(operation.drawable);
    if (timeDependent) this.invalidateOperation(operation.drawable);
    else this.appendStaticOperationToCachedTiles(operation);
    this.staticPrefixEnd = this.operations.findIndex(op => drawableDependsOnTime(op.drawable));
    if (this.staticPrefixEnd < 0) this.staticPrefixEnd = this.operations.length;
    if (!timeDependent && this.appendStaticOperationToCommittedView(operation)) {
      this.rerender();
    } else {
      this.invalidateCommittedView(); this.rerender();
    }
  }
  rebuildBase() { this.tiles.clear(); this.staticPrefixEnd = this.operations.findIndex(op => drawableDependsOnTime(op.drawable)); if (this.staticPrefixEnd < 0) this.staticPrefixEnd = this.operations.length; this.rebuildRenderIndex(); }
  rebuildRenderIndex() { this.renderIndex.clear(); for (let index = 0; index < this.operations.length; index += 1) this.renderIndex.add(this.operations[index], this.boundsForOperation(this.operations[index]), this.materialBounds); }
  invalidateCommittedView() { this.committedDirty = true; }
  appendStaticOperationToCachedTiles(operation) {
    for (const tile of this.tiles.values()) {
      const worldTile = { x: tile.x * TILE_SIZE, y: tile.y * TILE_SIZE, width: TILE_SIZE, height: TILE_SIZE };
      if (!this.operationIntersectsTile(operation, worldTile)) continue;
      count("Drawing cached tile append", () => this.perfMetadata({ tile: { x: tile.x, y: tile.y }, operationIndex: this.operations.length - 1 }));
      this.paintCachedOperation(operation, tile.ctx, worldTile);
    }
  }
  appendStaticOperationToCommittedView(operation) {
    const sx = this.canvas.width / this.materialBounds.width, sy = this.canvas.height / this.materialBounds.height;
    if (this.committedDirty || !(sx > 1.001 || sy > 1.001)) return false;
    this.paintOperation(operation, this.committedCtx, { periodic: true, transform: { x: -this.materialBounds.left, y: -this.materialBounds.top, sx, sy } });
    count("Drawing magnified committed append", () => this.perfMetadata({ operationIndex: this.operations.length - 1 }));
    return true;
  }
  invalidateOperation(drawable) {
    for (const tile of this.tiles.values()) this.rebuildTile(tile.x, tile.y);
  }
  boundsForOperation(operation) {
    const drawable = operation?.drawable;
    if (!drawable) return null;
    return this.prepareOperation(operation).bounds;
  }
  prepareOperation(operation) {
    const id = operation?.id, dynamic = drawableDependsOnTime(operation?.drawable);
    const cached = this.preparedDrawables.get(id);
    if (cached && (!dynamic || cached.time === this.time)) return cached;
    count("Drawing stroke preparation", () => this.perfMetadata({ operationId: id, dynamic }));
    const prepared = { operationId: id, ...prepareStroke(operation.drawable, { width: this.width, height: this.height, time: this.time }), dynamic, time: this.time };
    if (id) this.preparedDrawables.set(id, prepared);
    return prepared;
  }
  operationIntersectsTile(operation, tile) {
    if (operation?.type === "clear") return true;
    const bounds = this.boundsForOperation(operation);
    if (!bounds) return false;
    return periodicTranslations(bounds, this.materialBounds, { left: tile.x, top: tile.y, width: tile.width, height: tile.height }).length > 0;
  }
  tile(x, y) {
    count("Drawing tile lookup", () => this.perfMetadata({ tile: { x, y }, hit: this.tiles.has(tileKey(x, y)) }));
    const key = tileKey(x, y); let tile = this.tiles.get(key);
    if (!tile) { const canvas = createPaintCanvas(TILE_SIZE, TILE_SIZE); tile = { x, y, canvas, ctx: canvas.getContext("2d"), generation: -1 }; this.tiles.set(key, tile); }
    if (tile.generation !== this.committedRasterGeneration) this.rebuildTile(x, y);
    return tile;
  }
  rebuildTile(x, y) {
    const tile = this.tiles.get(tileKey(x, y)); if (!tile) return;
    return measure("Drawing tile rebuild", () => {
      tile.ctx.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
      for (const operation of this.renderIndex.forTile(x, y)) {
        count("Drawing tile history operation replay", () => this.perfMetadata({ tile: { x, y }, brush: strokeDescription(operation.drawable) }));
        this.paintCachedOperation(operation, tile.ctx, { x: x * TILE_SIZE, y: y * TILE_SIZE, width: TILE_SIZE, height: TILE_SIZE });
      }
      tile.generation = this.committedRasterGeneration;
    }, () => this.perfMetadata({ tile: { x, y }, replayedOperations: this.operations.length }));
  }
  prepareView({ pixelDensity } = {}) {
    const requested = Math.max(1, Number(pixelDensity) || 1);
    const maxScale = Math.max(1, Math.min(MAX_MATERIAL_PIXELS / this.materialBounds.width, MAX_MATERIAL_PIXELS / this.materialBounds.height));
    let nextScale = this.materialScale;
    if (requested > this.materialScale * 1.25) nextScale = Math.min(maxScale, 2 ** Math.ceil(Math.log2(requested)));
    else if (requested < this.materialScale / 2.5) nextScale = Math.max(1, 2 ** Math.floor(Math.log2(requested)));
    this.requestedPixelDensity = requested;
    const changed = Math.abs(nextScale - this.materialScale) > .001;
    const metadata = this.perfMetadata({ changed, reason: changed ? "material-resolution" : "material-resolution-hysteresis" });
    count("Drawing prepare material", metadata);
    if (!changed) return measure("Drawing prepare material unchanged", () => false, metadata);
    return measure("Drawing prepare material change", () => {
      this.disposeLivePreview(); this.invalidateStaticRuns(); this.materialScale = nextScale;
      const pixelWidth = Math.max(1, Math.min(MAX_MATERIAL_PIXELS, Math.round(this.materialBounds.width * nextScale)));
      const pixelHeight = Math.max(1, Math.min(MAX_MATERIAL_PIXELS, Math.round(this.materialBounds.height * nextScale)));
      this.canvas.width = pixelWidth; this.canvas.height = pixelHeight;
      this.committedCanvas.width = pixelWidth; this.committedCanvas.height = pixelHeight;
      this.immediateCanvas.width = pixelWidth; this.immediateCanvas.height = pixelHeight;
      this.ctx = this.canvas.getContext("2d"); this.committedCtx = this.committedCanvas.getContext("2d");
      this.immediateCtx = this.immediateCanvas.getContext("2d"); this.reconcileImmediateRaster();
      this.invalidateCommittedView(); this.materialRebuildCount += 1; this.composeMaterial(); this.markFrameChanged(); return true;
    }, () => this.perfMetadata({ changed: true, reason: "material-resolution" }));
  }
  composeCommittedMaterial() {
    const context = this.committedCtx;
    const metadata = this.perfMetadata();
    return measure("Drawing committed material composition", () => {
    context.clearRect(0, 0, this.committedCanvas.width, this.committedCanvas.height);
    context.save(); context.globalAlpha = 1; context.fillStyle = this.backgroundColor; context.fillRect(0, 0, this.committedCanvas.width, this.committedCanvas.height);
    const sx = this.canvas.width / this.materialBounds.width, sy = this.canvas.height / this.materialBounds.height;
    // Tiles are a one-pixel-per-world-unit cache. Enlarging one after a zoom
    // makes a committed stroke softer than its live vector preview. At a
    // magnification, replay the durable paths into the material at its
    // actual pixel density instead; the regular tile cache remains the fast
    // path when it is sampled at native resolution or smaller.
    // A transparent tile cannot encode additive blending against a colored
    // backdrop. Reconstruct directly in document order in that case.
    const transform = { x: -this.materialBounds.left, y: -this.materialBounds.top, sx, sy };
    if (this.operations.some(operation => drawableDependsOnTime(operation.drawable))) {
      this.composeAnimatedMaterial(context, transform);
    } else if (sx > 1.001 || sy > 1.001 || this.backgroundColor !== "#000000") {
      for (let index = 0; index < this.operations.length; index += 1) {
        const operation = this.operations[index];
        if (operation?.drawable) this.paintOperation(operation, context, { periodic: true, transform: { x: -this.materialBounds.left, y: -this.materialBounds.top, sx, sy } });
      }
    } else for (let ty = floorTile(this.materialBounds.top); ty <= floorTile(this.materialBounds.top + this.materialBounds.height - 1); ty += 1) for (let tx = floorTile(this.materialBounds.left); tx <= floorTile(this.materialBounds.left + this.materialBounds.width - 1); tx += 1) {
      const tile = this.tile(tx, ty); context.drawImage(tile.canvas, (tx * TILE_SIZE - this.materialBounds.left) * sx, (ty * TILE_SIZE - this.materialBounds.top) * sy, TILE_SIZE * sx, TILE_SIZE * sy);
    }
    context.restore(); this.committedDirty = false;
    }, metadata);
  }
  composeMaterial() {
    const metadata = this.perfMetadata();
    return measure("Drawing material composition", () => {
      if (this.committedDirty) { this.composeCommittedMaterial(); this.rebaseLivePreview(); }
      if (this.activeReconcilePending) this.rebuildActiveImmediateRaster();
      const sx = this.canvas.width / this.materialBounds.width, sy = this.canvas.height / this.materialBounds.height;
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); this.ctx.save(); this.ctx.globalAlpha = 1;
      count("Drawing committed canvas drawImage", () => this.perfMetadata());
      if (this.hasImmediatePixels && this.immediateIsComposite) this.ctx.drawImage(this.immediateCanvas, 0, 0);
      else { this.ctx.drawImage(this.committedCanvas, 0, 0); if (this.hasImmediatePixels) this.ctx.drawImage(this.immediateCanvas, 0, 0); }
      if (this.livePreview) this.ctx.drawImage(this.livePreview.canvas, 0, 0);
      else if (this.preview) this.paintDrawable(this.preview, this.ctx, { preview: true, periodic: true, transform: { x: -this.materialBounds.left, y: -this.materialBounds.top, sx, sy } });
      this.ctx.restore();
    }, metadata);
  }
  rerender() { return measure("Drawing rerender", () => { this.composeMaterial(); this.markFrameChanged(); }, () => this.perfMetadata()); }
  hasPaintSessions() { return this.paintSessions.size > 0; }
  beginPaintSession(drawable) {
    // A transient renderer decides whether its current input prefix is visible.
    if (!isPaintSessionDrawable(drawable)) return null;
    const frozen = structuredClone({ ...drawable, gesture: { ...drawable.gesture, points: [] } });
    const renderer = createStrokeSession(frozen);
    if (!renderer) return null;
    if (renderer.resourceId && !brushTextureCatalog.get(renderer.resourceId)) this.requestTextureReplay(renderer.resourceId);
    const id = `paint-session-${globalThis.crypto?.randomUUID?.() || Math.random()}`;
    this.paintSessions.set(id, { drawable: frozen, renderer, consumed: 0, finishing: false });
    this.advancePaintSession(id, drawable);
    return id;
  }
  paintImmediateDrawable(drawable, { preview = false } = {}) {
    const sx = this.canvas.width / this.materialBounds.width, sy = this.canvas.height / this.materialBounds.height;
    this.paintDrawable(drawable, this.immediateCtx, { preview, periodic: true, transform: { x: -this.materialBounds.left, y: -this.materialBounds.top, sx, sy } }); this.hasImmediatePixels = true;
  }
  ensureCompositeImmediate() {
    if (this.immediateIsComposite) return;
    if (this.committedDirty) this.composeCommittedMaterial();
    const composite = createPaintCanvas(this.canvas.width, this.canvas.height), context = composite.getContext("2d");
    context.drawImage(this.committedCanvas, 0, 0);
    if (this.hasImmediatePixels) context.drawImage(this.immediateCanvas, 0, 0);
    this.immediateCanvas = composite; this.immediateCtx = context;
    this.hasImmediatePixels = true; this.immediateIsComposite = true;
  }
  paintSessionInstructions(batches = [], owner = null) {
    if (!batches.some(batch => batch?.instructions?.length && batch.bounds)) return false;
    if (owner?.renderer.rasterMode === "replace") {
      // Replacement-prefix adapters repaint only their current gesture against
      // a transient snapshot. Older finishing sessions stream into the snapshot
      // too, so updates never replay committed artwork or consumed Wisp input.
      if (!owner.backdrop) {
        this.ensureCompositeImmediate();
        owner.backdrop = createPaintCanvas(this.canvas.width, this.canvas.height);
        owner.backdrop.getContext("2d").drawImage(this.immediateCanvas, 0, 0);
      }
      this.immediateCtx.clearRect(0, 0, this.immediateCanvas.width, this.immediateCanvas.height);
      this.immediateCtx.drawImage(owner.backdrop, 0, 0);
      this.hasImmediatePixels = true; this.immediateIsComposite = true; owner.bounds = null;
    }
    const sx = this.canvas.width / this.materialBounds.width, sy = this.canvas.height / this.materialBounds.height;
    let painted = false;
    for (const batch of batches) {
      if (!batch?.instructions?.length || !batch.bounds) continue;
      if (batch.requiresBackdrop) this.ensureCompositeImmediate();
      const contexts = [this.immediateCtx];
      if (owner?.renderer.rasterMode !== "replace") for (const session of this.paintSessions.values()) {
        if (session !== owner && session.backdrop) contexts.push(session.backdrop.getContext("2d"));
      }
      for (const context of contexts) {
        context.save(); context.translate(-this.materialBounds.left * sx, -this.materialBounds.top * sy); context.scale?.(sx, sy);
        for (const translation of periodicTranslations(batch.bounds, this.materialBounds, this.materialBounds)) { context.save(); context.translate(translation.x, translation.y); paintBrushInstructions(context, batch.instructions); context.restore(); }
        context.restore();
      }
      if (owner) owner.bounds = owner.bounds ? { left: Math.min(owner.bounds.left, batch.bounds.left), top: Math.min(owner.bounds.top, batch.bounds.top), right: Math.max(owner.bounds.right, batch.bounds.right), bottom: Math.max(owner.bounds.bottom, batch.bounds.bottom) } : batch.bounds;
      painted = true;
    }
    if (painted) this.hasImmediatePixels = true;
    return painted;
  }
  advancePaintSession(id, drawable) {
    const session = this.paintSessions.get(id);
    if (!session || !validPaintSessionUpdate(drawable, session.consumed)) return false;
    if (!session.renderer?.acceptsDrawable(drawable)) return false;
    const next = drawablePoints(drawable), previous = drawablePoints(session.drawable);
    const changedPrefix = next.length <= session.consumed
      ? hasChangedPaintGeometry(previous, next, session.consumed)
      : session.consumed > 0 && hasChangedPaintGeometry([previous[session.consumed - 1]], [next[session.consumed - 1]], 1);
    if (changedPrefix) {
      if (!validPaintSamples(next)) return false;
      // The active path was compacted in-place rather than extended. Its
      // previous incremental renderer cannot consume those replacement
      // samples, so rebuild the transient overlay from its current path.
      session.drawable = structuredClone(drawable); session.rebuildRenderer = true;
      this.reconcileImmediateRaster(); this.rerender(); return true;
    }
    if (next.length > session.consumed) {
      // The accepted prefix is session-owned and immutable. Copy only the
      // appended samples plus the preceding sample's possible hold update.
      if (session.consumed) previous[session.consumed - 1] = structuredClone(next[session.consumed - 1]);
      for (let index = session.consumed; index < next.length; index += 1) previous.push(structuredClone(next[index]));
    } else session.drawable = structuredClone(drawable);
    this.paintSessionInstructions(session.renderer.advance(session.drawable), session);
    session.consumed = next.length;
    this.rerender(); return true;
  }
  schedulePaintFinish(id) {
    const schedule = globalThis.requestAnimationFrame || (callback => setTimeout(() => callback(performance.now()), 16));
    schedule(() => {
      const session = this.paintSessions.get(id); if (!session || !session.finishing) return;
      const deposited = this.paintSessionInstructions(session.renderer?.settle?.(), session);
      if (session.renderer?.isFinished) this.completePaintSession(id);
      else { if (deposited) this.rerender(); this.schedulePaintFinish(id); }
    });
  }
  completePaintSession(id) {
    const session = this.paintSessions.get(id); if (!session) return null;
    this.paintSessions.delete(id); const drawable = structuredClone(session.drawable), bounds = session.renderer?.bounds || session.bounds || null;
    session.renderer?.dispose?.(); session.onComplete?.(drawable, bounds); return drawable;
  }
  finishPaintSession(id, onComplete = null) {
    const session = this.paintSessions.get(id); if (!session) return false;
    session.finishing = true; session.onComplete = onComplete;
    if (session.renderer?.beginFinish) { session.renderer.beginFinish(); if (!session.renderer.isFinished) { this.schedulePaintFinish(id); return true; } }
    this.completePaintSession(id); return true;
  }
  commitImmediatePaint(operation, bounds = null) {
    this.invalidateStaticRuns(this.operations.length);
    const raster = rasterOperation(operation); this.operations.push(raster);
    this.renderIndex.add(raster, bounds ? padBounds(bounds) : this.boundsForOperation(raster), this.materialBounds);
    // A normal immediate commit promotes the pixels already deposited by the
    // PaintSession. Tiles deliberately remain stale: they are reconstructed
    // lazily from the durable recipe only if a later composition needs one.
    this.committedRasterGeneration += 1;
    this.staticPrefixEnd = this.operations.findIndex(operation => drawableDependsOnTime(operation.drawable));
    if (this.staticPrefixEnd < 0) this.staticPrefixEnd = this.operations.length;
    this.promoteImmediateRaster();
    this.rerender();
  }
  promoteImmediateRaster() {
    // This must stay a pixel-only operation. In particular, do not call the
    // committed composer here: completion must not replay a brush or history.
    let composite = this.immediateCanvas;
    if (!this.immediateIsComposite) {
      composite = createPaintCanvas(this.canvas.width, this.canvas.height);
      const context = composite.getContext("2d");
      context.drawImage(this.committedCanvas, 0, 0);
      if (this.hasImmediatePixels) context.drawImage(this.immediateCanvas, 0, 0);
    }
    if (this.paintSessions.size) {
      // Keep the exact interleaving visible while another session is still
      // depositing. Future immediate batches append to this composite.
      this.immediateCanvas = composite; this.immediateCtx = composite.getContext("2d");
      this.hasImmediatePixels = true; this.immediateIsComposite = true;
      return;
    }
    this.committedCtx.clearRect(0, 0, this.committedCanvas.width, this.committedCanvas.height);
    this.committedCtx.drawImage(composite, 0, 0);
    this.committedDirty = false;
    this.immediateCtx.clearRect(0, 0, this.immediateCanvas.width, this.immediateCanvas.height);
    this.hasImmediatePixels = false; this.immediateIsComposite = false;
  }
  paintOperation(operation, context, options = {}) { return this.paintDrawable(operation.drawable, context, { ...options, prepared: this.prepareOperation(operation) }); }
  paintCachedOperation(operation, context, tile) {
    if (operation.type === "clear") { context.clearRect(0, 0, tile?.width || this.canvas.width, tile?.height || this.canvas.height); return; }
    this.paintOperation(operation, context, { tile, periodic: true });
  }
  paintDrawable(drawable, context = this.ctx, { preview = false, tile = null, transform = null, prepared = null, periodic = false, painter = null } = {}) {
    const stroke = prepared || prepareStroke(drawable, { width: this.width, height: this.height, time: this.time }, { preview });
    if (stroke.resourceId && !brushTextureCatalog.get(stroke.resourceId)) { this.requestTextureReplay(stroke.resourceId); return; }
    if (!stroke.bounds) return;
    count("Drawing stroke rasterization", () => this.perfMetadata({ operationId: prepared?.operationId, preview, tile: tile ? { x: tile.x, y: tile.y } : null }));
    context.save();
    if (tile) { context.beginPath?.(); context.rect?.(0, 0, tile.width, tile.height); context.clip?.(); context.translate(-tile.x, -tile.y); }
    if (transform) { context.translate(transform.x * transform.sx, transform.y * transform.sy); context.scale?.(transform.sx, transform.sy); }
    const target = tile ? { left: tile.x, top: tile.y, width: tile.width, height: tile.height } : this.materialBounds;
    for (const translation of periodic ? periodicTranslations(stroke.bounds, this.materialBounds, target) : [{ x: 0, y: 0 }]) {
      context.save(); context.translate(translation.x, translation.y);
      measure("Drawing stroke replay", () => stroke.render(painter || context, { preview }), () => this.perfMetadata({ preview }));
      context.restore();
    }
    context.restore();
  }
  requestTextureReplay(textureId) { if (this.pendingTextureReplays.has(textureId)) return; this.pendingTextureReplays.add(textureId); brushTextureCatalog.ensure(textureId).then(texture => { if (texture) { this.invalidateStaticRuns(); this.reconcileImmediateRaster(); this.tiles.clear(); this.invalidateCommittedView(); this.rerender(); } }).finally(() => this.pendingTextureReplays.delete(textureId)); }
}

/** Renderer-facing drawing source. Durable mutations are translated to ChangeSets. */
export class DrawingSource {
  constructor({ width = 2048, height = 2048, onFrameChange = () => {}, onDocumentChange = () => {}, createId } = {}) {
    this.document = new DrawingDocument({ createId });
    this.onDocumentChange = onDocumentChange;
    this.rasterizer = new DrawingRasterizer({ width, height, onFrameChange });
  }
  get width() { return this.rasterizer.width; }
  get height() { return this.rasterizer.height; }
  get revision() { return this.rasterizer.revision; }
  get operationCount() { return this.document.operationCount; }
  get preview() { return this.rasterizer.preview; }
  get tiles() { return this.rasterizer.tiles; }
  get ctx() { return this.rasterizer.ctx; }
  get canvas() { return this.rasterizer.canvas; }
  get committedCtx() { return this.rasterizer.committedCtx; }
  get committedDirty() { return this.rasterizer.committedDirty; }
  get materialBounds() { return { ...this.rasterizer.materialBounds }; }
  get materialRebuildCount() { return this.rasterizer.materialRebuildCount; }
  get staticPrefixEnd() { return this.rasterizer.staticPrefixEnd; }
  tile(...args) { return this.rasterizer.tile(...args); }
  get paintDrawable() { return this.rasterizer.paintDrawable.bind(this.rasterizer); }
  set paintDrawable(value) { this.rasterizer.paintDrawable = value; }
  get paintCachedOperation() { return this.rasterizer.paintCachedOperation.bind(this.rasterizer); }
  set paintCachedOperation(value) { this.rasterizer.paintCachedOperation = value; }
  get paintOperation() { return this.rasterizer.paintOperation.bind(this.rasterizer); }
  set paintOperation(value) { this.rasterizer.paintOperation = value; }
  get rebuildTile() { return this.rasterizer.rebuildTile.bind(this.rasterizer); }
  set rebuildTile(value) { this.rasterizer.rebuildTile = value; }
  get rebuildBase() { return this.rasterizer.rebuildBase.bind(this.rasterizer); }
  set rebuildBase(value) { this.rasterizer.rebuildBase = value; }
  get composeCommittedMaterial() { return this.rasterizer.composeCommittedMaterial.bind(this.rasterizer); }
  set composeCommittedMaterial(value) { this.rasterizer.composeCommittedMaterial = value; }
  getWorldScale() { return this.rasterizer.getWorldScale(); }
  getFrame() { return this.rasterizer.getFrame(); }
  prepareView(request) { return this.rasterizer.prepareView(request); }
  setTime(time) { return this.rasterizer.setTime(time); }
  previewDrawable(drawable) { return this.rasterizer.previewDrawable(drawable); }
  hasPaintSessions() { return this.rasterizer.hasPaintSessions(); }
  beginPaintSession(drawable) { return this.rasterizer.beginPaintSession(drawable); }
  updatePaintSession(id, drawable) { return this.rasterizer.advancePaintSession(id, drawable); }
  finishPaintSession(id) {
    let committedId = null;
    const started = this.rasterizer.finishPaintSession(id, (drawable, bounds) => {
      const change = this.document.commit(drawable); if (!change) return;
      this.rasterizer.commitImmediatePaint(change.operation, bounds); committedId = change.id; this.onDocumentChange(change);
    });
    return started ? committedId || true : null;
  }
  getContentState() { return this.document.getContentState(); }
  restoreContentState(state) { if (this.hasPaintSessions()) return false; const change = this.document.restoreContentState(state); if (!change) return false; this.rasterizer.rebuildFrom(this.document.getRenderView()); this.onDocumentChange(change); return true; }
  canUndo() { return !this.hasPaintSessions() && this.document.canUndo(); }
  getDrawable(id) { return this.document.getDrawable(id); }
  findLatestDrawable(predicate) { return this.document.findLatest(predicate); }
  commitDrawable(drawable) {
    if (this.hasPaintSessions()) return null;
    const change = this.document.commit(drawable); if (!change) return null; this.rasterizer.applyChange(change, this.document.getRenderView()); this.onDocumentChange(change); return change.id;
  }
  beginReplaceAction(id) { return this.document.beginReplaceAction(id); }
  endReplaceAction() { this.document.endReplaceAction(); }
  replaceDrawable(id, drawable) { if (this.hasPaintSessions()) return false; const change = this.document.replace(id, drawable); if (!change) return false; this.rasterizer.applyChange(change, this.document.getRenderView()); this.onDocumentChange(change); return true; }
  setBackgroundColor(color) { const change = this.document.setBackgroundColor(color); if (!change) return false; this.rasterizer.applyChange(change, this.document.getRenderView()); this.onDocumentChange(change); return true; }
  undo() { if (this.hasPaintSessions()) return false; const change = this.document.undo(); if (!change) return false; this.rasterizer.applyChange(change, this.document.getRenderView()); this.onDocumentChange(change); return true; }
  clear() { if (this.hasPaintSessions()) return false; const change = this.document.clear(); if (!change) return false; this.rasterizer.applyChange(change, this.document.getRenderView()); this.onDocumentChange(change); return true; }
  perfMetadata(extra) { return this.rasterizer.perfMetadata(extra); }
}

/**
 * Development-only fixed-view probe for committed-artwork cost in live Fiber
 * previews. Enable __KALEIDOSCOPE_DEBUG_PERF__ before calling it; results are
 * appended to the normal rolling timing telemetry.
 */
export function benchmarkFiberPreview({ committedStrokes = 32, width = 512, height = 512 } = {}) {
  if (!globalThis.__KALEIDOSCOPE_DEBUG_PERF__) return null;
  const fiber = (offset = 0) => ({
    kind: "pathStroke", points: [{ x: 40, y: 156 + offset }, { x: 240, y: 156 + offset }],
    style: { brush: "fiber", version: 2, color: "#ffffff", colorMode: "solid", size: 8, opacity: 1, taper: "none", seed: 73, fibers: .5, gravity: 42, branching: 13, curl: 12, spread: .5, wispiness: .5, assistLevel: .55 }
  });
  const run = (source, phase) => measure("Drawing Fiber preview benchmark", () => source.previewDrawable(fiber()), () => source.perfMetadata({ phase, committedStrokes: source.operationCount, previewLength: 200 }));
  const empty = new DrawingSource({ width, height });
  run(empty, "empty");
  const populated = new DrawingSource({ width, height });
  for (let index = 0; index < Math.max(0, Math.floor(committedStrokes)); index += 1) populated.commitDrawable(fiber((index % 12) * 12));
  run(populated, "populated");
  return { empty, populated };
}
