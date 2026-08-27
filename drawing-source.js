import { BRUSHES, brushFootprint, brushTextureId, canReplayBrushPath, createLiveBrushPreview, createPaintSessionRenderer, measureBrushReplay, needsStaticBrushCheckpoint, renderBrushReplay, replayBrushContours } from "./brushes.js";
import { brushTextureCatalog } from "./brush-textures.js";
import { paintBrushInstructions } from "./brush-painter.js";
import { derivePath, drawableDependsOnTime, isDrawable } from "./drawable-path.js";
import { count, measure } from "./perf.js";
import { DrawingDocument } from "./drawing-document.js";

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
  if (operation?.type === "PaintOperation") return { kind: "pathStroke", points: operation.points, style: operation.style };
  if (operation?.type === "GeneratorOperation") {
    const { generator, generatorVersion, config, animation, domain, sampling, style } = operation;
    return { kind: "generatedStroke", generator, generatorVersion, config, animation, domain, sampling, style };
  }
  return operation?.drawable || null;
}
function rasterOperation(operation) { return { ...structuredClone(operation), drawable: drawableForOperation(operation) }; }
function isPaintSessionDrawable(drawable) {
  return drawable?.kind === "pathStroke" && Boolean(BRUSHES[drawable?.style?.brush])
    && Array.isArray(drawable.points)
    && drawable.points.every(point => Number.isFinite(point?.x) && Number.isFinite(point?.y));
}
function boundsForPath(path, style) {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const contour of path.contours || []) for (const p of contour.points || []) {
    left = Math.min(left, p.x); right = Math.max(right, p.x); top = Math.min(top, p.y); bottom = Math.max(bottom, p.y);
  }
  if ((path.instances || []).length > 1) {
    const base = { left, top, right, bottom }; left = Infinity; top = Infinity; right = -Infinity; bottom = -Infinity;
    for (const instance of path.instances) { left = Math.min(left, base.left + instance.x); top = Math.min(top, base.top + instance.y); right = Math.max(right, base.right + instance.x); bottom = Math.max(bottom, base.bottom + instance.y); }
  }
  if (!Number.isFinite(left)) return null;
  const pad = brushFootprint(style) + ANTIALIAS_PADDING;
  return { left: Math.floor(left - pad), top: Math.floor(top - pad), right: Math.ceil(right + pad), bottom: Math.ceil(bottom + pad) };
}
function padBounds(bounds, padding = ANTIALIAS_PADDING) {
  return bounds && { left: Math.floor(bounds.left - padding), top: Math.floor(bounds.top - padding), right: Math.ceil(bounds.right + padding), bottom: Math.ceil(bounds.bottom + padding) };
}
class RenderIndex {
  constructor() { this.operations = new Map(); this.tiles = new Map(); }
  clear() { this.operations.clear(); this.tiles.clear(); }
  add(operation, bounds, materialBounds) {
    if (!operation?.id || !bounds) return;
    this.operations.set(operation.id, operation);
    for (const translation of periodicTranslations(bounds, materialBounds, materialBounds)) {
      const shifted = { left: bounds.left + translation.x, top: bounds.top + translation.y, right: bounds.right + translation.x, bottom: bounds.bottom + translation.y };
      for (let y = floorTile(shifted.top); y <= floorTile(shifted.bottom); y += 1) for (let x = floorTile(shifted.left); x <= floorTile(shifted.right); x += 1) {
        const key = tileKey(x, y); if (!this.tiles.has(key)) this.tiles.set(key, new Set()); this.tiles.get(key).add(operation.id);
      }
    }
  }
  forTile(x, y) { return [...(this.tiles.get(tileKey(x, y)) || [])].map(id => this.operations.get(id)).filter(Boolean); }
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
    // Compatibility mirrors for older integrations. They are never durable
    // paint surfaces; tiles remain the actual cache.
    this.baseCanvas = createPaintCanvas(this.width, this.height); this.baseCtx = this.baseCanvas.getContext("2d");
    this.baseStaticCanvas = createPaintCanvas(this.width, this.height); this.baseStaticCtx = this.baseStaticCanvas.getContext("2d");
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
    // Kept as compatibility/introspection fields; static tile replay is now lazy.
    this.staticPrefixEnd = 0; this.staticCheckpoints = [];
    this.compositionCheckpoints = [];
    this.composeMaterial();
  }

  getWorldScale() { return { width: this.width, height: this.height }; }
  getFrame() { return { pixels: this.canvas, width: this.canvas.width, height: this.canvas.height, revision: this.revision, world: { origin: { x: this.materialBounds.left, y: this.materialBounds.top }, extent: { width: this.materialBounds.width, height: this.materialBounds.height }, scale: { width: this.width, height: this.height }, wrap: "repeat" } }; }
  isDrawable(drawable) { return isDrawable(drawable) && Boolean(BRUSHES[drawable?.style?.brush]) && (drawable.kind !== "pathStroke" || canReplayBrushPath(drawable.points, drawable.style)); }
  markFrameChanged() { this.revision += 1; this.onFrameChange(); }
  perfMetadata(extra = {}) {
    return {
      committedOperationCount: this.operations.length,
      activePreviewPointCount: this.preview?.points?.length || 0,
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
    if (session && !session.acceptsStyle(drawable.style)) this.disposeLivePreview();
    session = this.livePreview?.session;
    if (!session) {
      session = createLiveBrushPreview(drawable);
      if (!session) return false;
      if (this.committedDirty) this.composeCommittedMaterial();
      const canvas = createPaintCanvas(this.canvas.width, this.canvas.height), context = canvas.getContext("2d");
      context.drawImage(this.committedCanvas, 0, 0);
      this.livePreview = { canvas, context, session };
    }
    const consumedBefore = session.consumedSampleCount;
    if (drawable.points.length < consumedBefore) return false;
    const advanced = measure("Drawing live brush preview simulation", () => session.advance(drawable.points.slice(consumedBefore)), () => this.perfMetadata({ newSampleCount: session.consumedSampleCount - consumedBefore, activeParticleCount: session.activeParticleCount }));
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
    this.activeReconcilePending = true;
  }
  rebuildActiveImmediateRaster() {
    this.activeReconcilePending = false;
    // Completed operations are now represented by the reconstructed committed
    // material. Only active/finishing sessions are redrawn into the overlay.
    for (const session of this.paintSessions.values()) {
      if (!session.drawable?.points?.length) continue;
      session.renderer = createPaintSessionRenderer({ ...session.drawable, points: [] });
      const batches = session.renderer?.advance(session.drawable) || [];
      session.consumed = session.drawable.points.length;
      this.paintSessionInstructions(batches);
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
    if (change.type === "background") { this.backgroundColor = change.after; this.disposeLivePreview(); this.reconcileImmediateRaster(); this.invalidateCommittedView(); this.rerender(); return true; }
    if (change.type === "clear") { this.preview = null; this.disposeLivePreview(); this.paintSessions.clear(); this.immediateCtx.clearRect(0, 0, this.immediateCanvas.width, this.immediateCanvas.height); this.hasImmediatePixels = false; this.immediateIsComposite = false; this.activeReconcilePending = false; this.operations = []; this.tiles.clear(); this.preparedDrawables.clear(); this.renderIndex.clear(); this.staticPrefixEnd = 0; this.staticCheckpoints = []; this.compositionCheckpoints = []; this.invalidateCommittedView(); this.rerender(); return true; }
    // Replacement and undo have non-local z-order effects. Rebuild from the
    // authoritative document rather than guessing from two snapshots.
    this.rebuildFrom(view, change.index || 0); return true;
  }
  setTime(time) { const next = Number(time); if (!Number.isFinite(next) || next === this.time) return false; this.time = next; if (!this.operations.some(op => drawableDependsOnTime(op.drawable)) && !drawableDependsOnTime(this.preview)) return false; this.reconcileImmediateRaster(); this.tiles.clear(); this.rebuildRenderIndex(); this.baseCtx.clearRect(0, 0, this.width, this.height); this.baseCtx.drawImage(this.baseStaticCanvas, 0, 0); for (let i = this.staticPrefixEnd; i < this.operations.length; i += 1) this.paintOperation(this.operations[i], this.baseCtx); this.invalidateCommittedView(); this.rerender(); return true; }

  appendOperation(operation) {
    this.operations.push(operation);
    this.renderIndex.add(operation, this.boundsForOperation(operation), this.materialBounds);
    const timeDependent = drawableDependsOnTime(operation.drawable);
    if (timeDependent) this.invalidateOperation(operation.drawable);
    else this.appendStaticOperationToCachedTiles(operation);
    this.staticPrefixEnd = this.operations.findIndex(op => drawableDependsOnTime(op.drawable));
    if (this.staticPrefixEnd < 0) this.staticPrefixEnd = this.operations.length;
    if (needsStaticBrushCheckpoint(operation.drawable?.style)) this.staticCheckpoints.push({ index: this.operations.length, canvas: this.baseStaticCanvas });
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
    const prepared = this.prepareOperation(operation);
    return prepared.dynamic ? boundsForPath(derivePath(drawable, { width: this.width, height: this.height, time: this.time }), drawable.style) : prepared.bounds;
  }
  prepareOperation(operation) {
    const id = operation?.id;
    const dynamic = drawableDependsOnTime(operation?.drawable);
    if (!dynamic && id && this.preparedDrawables.has(id)) return this.preparedDrawables.get(id);
    const brushMeasurement = dynamic ? null : measureBrushReplay(operation.drawable);
    const path = dynamic || brushMeasurement ? null : derivePath(operation.drawable, { width: this.width, height: this.height, time: this.time });
    const prepared = { dynamic, brushMeasurement, path, bounds: brushMeasurement ? brushMeasurement.bounds && { left: Math.floor(brushMeasurement.bounds.left - ANTIALIAS_PADDING), top: Math.floor(brushMeasurement.bounds.top - ANTIALIAS_PADDING), right: Math.ceil(brushMeasurement.bounds.right + ANTIALIAS_PADDING), bottom: Math.ceil(brushMeasurement.bounds.bottom + ANTIALIAS_PADDING) } : path ? boundsForPath(path, operation.drawable.style) : null };
    if (!dynamic && id) this.preparedDrawables.set(id, prepared);
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
        count("Drawing tile history operation replay", () => this.perfMetadata({ tile: { x, y }, brush: operation.drawable?.style?.brush }));
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
      this.disposeLivePreview(); this.materialScale = nextScale;
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
    if (sx > 1.001 || sy > 1.001) {
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
      if (this.committedDirty) this.composeCommittedMaterial();
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
    const textureId = brushTextureId(drawable.style);
    if (textureId && !brushTextureCatalog.get(textureId)) this.requestTextureReplay(textureId);
    const renderer = createPaintSessionRenderer(drawable);
    const id = `paint-session-${globalThis.crypto?.randomUUID?.() || Math.random()}`;
    this.paintSessions.set(id, { drawable: structuredClone(drawable), renderer, consumed: 0, finishing: false });
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
  paintSessionInstructions(batches = []) {
    const sx = this.canvas.width / this.materialBounds.width, sy = this.canvas.height / this.materialBounds.height;
    let painted = false;
    for (const batch of batches) {
      if (!batch?.instructions?.length || !batch.bounds) continue;
      if (batch.requiresBackdrop) this.ensureCompositeImmediate();
      this.immediateCtx.save(); this.immediateCtx.translate(-this.materialBounds.left * sx, -this.materialBounds.top * sy); this.immediateCtx.scale?.(sx, sy);
      for (const translation of periodicTranslations(batch.bounds, this.materialBounds, this.materialBounds)) { this.immediateCtx.save(); this.immediateCtx.translate(translation.x, translation.y); paintBrushInstructions(this.immediateCtx, batch.instructions); this.immediateCtx.restore(); }
      this.immediateCtx.restore(); painted = true;
    }
    if (painted) this.hasImmediatePixels = true;
    return painted;
  }
  advancePaintSession(id, drawable) {
    const session = this.paintSessions.get(id);
    if (!session || !isPaintSessionDrawable(drawable)) return false;
    if (!session.renderer?.acceptsStyle(drawable.style)) return false;
    if (drawable.points.length <= session.consumed && hasChangedPaintGeometry(session.drawable.points, drawable.points, session.consumed)) {
      // The active path was compacted in-place rather than extended. Its
      // previous incremental renderer cannot consume those replacement
      // samples, so rebuild the transient overlay from its current path.
      session.drawable = structuredClone(drawable);
      this.reconcileImmediateRaster(); this.rerender(); return true;
    }
    session.drawable = structuredClone(drawable);
    this.paintSessionInstructions(session.renderer.advance(drawable, session.consumed));
    session.consumed = drawable.points.length;
    this.rerender(); return true;
  }
  schedulePaintFinish(id) {
    const schedule = globalThis.requestAnimationFrame || (callback => setTimeout(() => callback(performance.now()), 16));
    schedule(() => {
      const session = this.paintSessions.get(id); if (!session || !session.finishing) return;
      const deposited = this.paintSessionInstructions(session.renderer?.settle?.());
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
    const raster = rasterOperation(operation); this.operations.push(raster);
    this.renderIndex.add(raster, bounds ? padBounds(bounds) : this.boundsForOperation(raster), this.materialBounds);
    // A normal immediate commit promotes the pixels already deposited by the
    // PaintSession. Tiles deliberately remain stale: they are reconstructed
    // lazily from the durable recipe only if a later composition needs one.
    this.committedRasterGeneration += 1;
    this.staticPrefixEnd = this.operations.length;
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
  paintDrawable(drawable, context = this.ctx, { preview = false, tile = null, transform = null, prepared = null, periodic = false } = {}) {
    const brushMeasurement = prepared?.brushMeasurement || measureBrushReplay(drawable, { tail: !preview });
    const path = brushMeasurement ? null : (prepared?.path || derivePath(drawable, { width: this.width, height: this.height, time: this.time })); if (!brushMeasurement && !path.contours.length) return;
    count("Drawing brush rasterization", () => this.perfMetadata({ preview, tile: tile ? { x: tile.x, y: tile.y } : null }));
    const textureId = brushTextureId(drawable.style);
    if (textureId && !brushTextureCatalog.get(textureId)) { this.requestTextureReplay(textureId); return; }
    context.save();
    if (tile) { context.beginPath?.(); context.rect?.(0, 0, tile.width, tile.height); context.clip?.(); context.translate(-tile.x, -tile.y); }
    if (transform) { context.translate(transform.x * transform.sx, transform.y * transform.sy); context.scale?.(transform.sx, transform.sy); }
    const target = tile
      ? { left: tile.x, top: tile.y, width: tile.width, height: tile.height }
      : this.materialBounds;
    const replay = brushMeasurement;
    const bounds = replay ? replay.bounds && { left: replay.bounds.left - ANTIALIAS_PADDING, top: replay.bounds.top - ANTIALIAS_PADDING, right: replay.bounds.right + ANTIALIAS_PADDING, bottom: replay.bounds.bottom + ANTIALIAS_PADDING } : boundsForPath(path, drawable.style);
    const translations = periodic
      ? periodicTranslations(bounds, this.materialBounds, target)
      : [{ x: 0, y: 0 }];
    for (const translation of translations) {
      if (replay) { context.save(); context.translate(translation.x, translation.y); renderBrushReplay(context, drawable, { tail: !preview }); context.restore(); }
      else this.replayContours(context, path.contours, drawable.style, translation, preview);
    }
    context.restore();
  }
  replayContours(context, contours, style, translation = { x: 0, y: 0 }, preview = false) { context.save(); context.translate(translation.x, translation.y); measure("Canvas brush replay", () => replayBrushContours(context, contours, preview ? { ...style, preview: true } : style), () => this.perfMetadata({ preview, contourCount: contours.length })); context.restore(); }
  requestTextureReplay(textureId) { if (this.pendingTextureReplays.has(textureId)) return; this.pendingTextureReplays.add(textureId); brushTextureCatalog.ensure(textureId).then(texture => { if (texture) { this.reconcileImmediateRaster(); this.tiles.clear(); this.invalidateCommittedView(); this.rerender(); } }).finally(() => this.pendingTextureReplays.delete(textureId)); }
}

/** Renderer-facing drawing source. Durable mutations are translated to ChangeSets. */
export class DrawingSource {
  constructor({ width = 2048, height = 2048, onFrameChange = () => {}, createId } = {}) {
    this.document = new DrawingDocument({ createId });
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
  get staticCheckpoints() { return this.rasterizer.staticCheckpoints; }
  get baseCtx() { return this.rasterizer.baseCtx; }
  get baseStaticCtx() { return this.rasterizer.baseStaticCtx; }
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
      this.rasterizer.commitImmediatePaint(change.operation, bounds); committedId = change.id;
    });
    return started ? committedId || true : null;
  }
  getContentState() { return this.document.getContentState(); }
  restoreContentState(state) { const change = this.document.restoreContentState(state); if (!change) return false; this.rasterizer.rebuildFrom(this.document.getRenderView()); return true; }
  canUndo() { return this.document.canUndo(); }
  getDrawable(id) { return this.document.getDrawable(id); }
  findLatestDrawable(predicate) { return this.document.findLatest(predicate); }
  commitDrawable(drawable) {
    if (drawable?.kind === "generatedStroke" && this.hasPaintSessions()) return null;
    const change = this.document.commit(drawable); if (!change) return null; this.rasterizer.applyChange(change, this.document.getRenderView()); return change.id;
  }
  beginReplaceAction(id) { return this.document.beginReplaceAction(id); }
  endReplaceAction() { this.document.endReplaceAction(); }
  replaceDrawable(id, drawable) { if (drawable?.kind === "generatedStroke" && this.hasPaintSessions()) return false; const change = this.document.replace(id, drawable); if (!change) return false; this.rasterizer.applyChange(change, this.document.getRenderView()); return true; }
  setBackgroundColor(color) { const change = this.document.setBackgroundColor(color); if (!change) return false; this.rasterizer.applyChange(change, this.document.getRenderView()); return true; }
  undo() { const change = this.document.undo(); if (!change) return false; this.rasterizer.applyChange(change, this.document.getRenderView()); return true; }
  clear() { const change = this.document.clear(); if (!change) return false; this.rasterizer.applyChange(change, this.document.getRenderView()); return true; }
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
