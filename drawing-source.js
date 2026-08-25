import { BRUSHES, canReplayBrushPath, replayBrushContours } from "./brushes.js";
import { brushTextureCatalog } from "./brush-textures.js";
import { derivePath, drawableDependsOnTime, isDrawable } from "./drawable-path.js";
import { count, measure } from "./perf.js";
import { DrawingDocument } from "./drawing-document.js";

const TILE_SIZE = 1024;
const ANTIALIAS_PADDING = 2;
const PREPARED_ATLAS_SCALE = 2;
const PREPARED_SAFE_FRACTION = .6;
function createPaintCanvas(width, height) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height; return canvas;
}
function finite(value) { return Number.isFinite(Number(value)) ? Number(value) : 0; }
function tileKey(x, y) { return `${x},${y}`; }
function floorTile(value) { return Math.floor(value / TILE_SIZE); }
function brushFootprint(style = {}) {
  const size = Math.max(0, finite(style.size));
  if (style.brush === "ribbon") return Math.max(0, finite(style.span)) / 2 + size / 2;
  if (style.brush === "calligraphy") return Math.max(size, size * Math.max(0, finite(style.nibRatio))) / 2;
  if (style.brush === "spray") return size / 2 + Math.max(0, finite(style.particleSize)) / 2;
  if (style.brush === "texture") return size * Math.SQRT2 / 2;
  if (style.brush === "fiber" || style.brush === "hair") return size * 5;
  return size / 2;
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
class RenderIndex {
  constructor() { this.operations = new Map(); this.tiles = new Map(); }
  clear() { this.operations.clear(); this.tiles.clear(); }
  add(operation, bounds) {
    if (!operation?.id || !bounds) return;
    this.operations.set(operation.id, operation);
    for (let y = floorTile(bounds.top); y <= floorTile(bounds.bottom); y += 1) for (let x = floorTile(bounds.left); x <= floorTile(bounds.right); x += 1) {
      const key = tileKey(x, y); if (!this.tiles.has(key)) this.tiles.set(key, new Set()); this.tiles.get(key).add(operation.id);
    }
  }
  forTile(x, y) { return [...(this.tiles.get(tileKey(x, y)) || [])].map(id => this.operations.get(id)).filter(Boolean); }
}
/** Derived Canvas2D state only: tiles, atlas, previews, and raster revisions. */
export class DrawingRasterizer {
  constructor({ width = 2048, height = 2048, onFrameChange = () => {} } = {}) {
    // width/height are the world scale used by the renderer mapping, not bounds.
    this.width = Math.max(1, Math.floor(width)); this.height = Math.max(1, Math.floor(height));
    this.canvas = createPaintCanvas(this.width, this.height); this.ctx = this.canvas.getContext("2d");
    this.committedCanvas = createPaintCanvas(this.width, this.height); this.committedCtx = this.committedCanvas.getContext("2d"); this.committedDirty = true;
    // Compatibility mirrors for older integrations. They are never durable
    // paint surfaces; tiles remain the actual cache.
    this.baseCanvas = createPaintCanvas(this.width, this.height); this.baseCtx = this.baseCanvas.getContext("2d");
    this.baseStaticCanvas = createPaintCanvas(this.width, this.height); this.baseStaticCtx = this.baseStaticCanvas.getContext("2d");
    this.atlasOrigin = { x: 0, y: 0 }; this.atlasExtent = { width: this.width, height: this.height };
    // The renderer's most recent request is diagnostic state. The frame still
    // exposes the larger prepared atlas via atlasOrigin/atlasExtent.
    this.requestedWorldBounds = null; this.requestedPixelSize = null; this.atlasRecenterCount = 0;
    this.tiles = new Map(); this.operations = []; this.preview = null;
    this.backgroundColor = "#000000"; this.time = 0; this.revision = 0; this.onFrameChange = onFrameChange;
    this.pendingTextureReplays = new Set();
    // Bounds are derived cache metadata, never durable drawable state. They
    // let a newly exposed sparse tile skip expensive off-tile brush replay.
    this.preparedDrawables = new Map();
    this.renderIndex = new RenderIndex();
    // Kept as compatibility/introspection fields; static tile replay is now lazy.
    this.staticPrefixEnd = 0; this.staticCheckpoints = [];
    this.composeAtlas();
  }

  getWorldScale() { return { width: this.width, height: this.height }; }
  getFrame() { return { pixels: this.canvas, width: this.canvas.width, height: this.canvas.height, revision: this.revision, world: { origin: this.atlasOrigin, extent: this.atlasExtent, scale: { width: this.width, height: this.height }, wrap: "clamp" } }; }
  isDrawable(drawable) { return isDrawable(drawable) && Boolean(BRUSHES[drawable?.style?.brush]) && (drawable.kind !== "pathStroke" || canReplayBrushPath(drawable.points, drawable.style)); }
  markFrameChanged() { this.revision += 1; this.onFrameChange(); }
  perfMetadata(extra = {}) {
    return {
      committedOperationCount: this.operations.length,
      activePreviewPointCount: this.preview?.points?.length || 0,
      atlasBounds: { left: this.atlasOrigin.x, top: this.atlasOrigin.y, width: this.atlasExtent.width, height: this.atlasExtent.height },
      atlasPixels: { width: this.canvas.width, height: this.canvas.height },
      requestedBounds: this.requestedWorldBounds ? { ...this.requestedWorldBounds } : null,
      requestedPixels: this.requestedPixelSize ? { ...this.requestedPixelSize } : null,
      atlasRecenterCount: this.atlasRecenterCount,
      committedDirty: this.committedDirty,
      ...extra
    };
  }

  previewDrawable(drawable) {
    this.preview = this.isDrawable(drawable) ? structuredClone(drawable) : null;
    return measure("Drawing preview drawable", () => this.rerender(), () => this.perfMetadata());
  }
  rebuildFrom(view) {
    this.backgroundColor = view.backgroundColor;
    this.operations = view.operations.map(operation => ({ type: "drawable", id: operation.id, drawable: structuredClone(operation.drawable) }));
    this.preview = null; this.tiles.clear(); this.preparedDrawables.clear(); this.rebuildBase(); this.invalidateCommittedView(); this.rerender();
  }
  applyChange(change, view) {
    if (!change) return false;
    if (change.type === "append") {
      this.preview = null;
      this.appendOperation({ type: "drawable", id: change.id, drawable: structuredClone(change.drawable) });
      return true;
    }
    if (change.type === "background") { this.backgroundColor = change.after; this.invalidateCommittedView(); this.rerender(); return true; }
    if (change.type === "clear") { this.preview = null; this.operations = []; this.tiles.clear(); this.preparedDrawables.clear(); this.renderIndex.clear(); this.staticPrefixEnd = 0; this.staticCheckpoints = []; this.invalidateCommittedView(); this.rerender(); return true; }
    // Replacement and undo have non-local z-order effects. Rebuild from the
    // authoritative document rather than guessing from two snapshots.
    this.rebuildFrom(view); return true;
  }
  setTime(time) { const next = Number(time); if (!Number.isFinite(next) || next === this.time) return false; this.time = next; if (!this.operations.some(op => drawableDependsOnTime(op.drawable)) && !drawableDependsOnTime(this.preview)) return false; this.tiles.clear(); this.rebuildRenderIndex(); this.baseCtx.clearRect(0, 0, this.width, this.height); this.baseCtx.drawImage(this.baseStaticCanvas, 0, 0); for (let i = this.staticPrefixEnd; i < this.operations.length; i += 1) this.paintOperation(this.operations[i], this.baseCtx); this.invalidateCommittedView(); this.rerender(); return true; }

  appendOperation(operation) {
    this.operations.push(operation);
    this.renderIndex.add(operation, this.boundsForOperation(operation));
    const timeDependent = drawableDependsOnTime(operation.drawable);
    if (timeDependent) this.invalidateOperation(operation.drawable);
    else this.appendStaticOperationToCachedTiles(operation);
    this.staticPrefixEnd = this.operations.findIndex(op => drawableDependsOnTime(op.drawable));
    if (this.staticPrefixEnd < 0) this.staticPrefixEnd = this.operations.length;
    if (["fiber", "hair"].includes(operation.drawable?.style?.brush)) this.staticCheckpoints.push({ index: this.operations.length, canvas: this.baseStaticCanvas });
    if (!timeDependent && this.appendStaticOperationToCommittedView(operation)) {
      this.rerender();
    } else {
      this.invalidateCommittedView(); this.rerender();
    }
  }
  rebuildBase() { this.tiles.clear(); this.staticPrefixEnd = this.operations.findIndex(op => drawableDependsOnTime(op.drawable)); if (this.staticPrefixEnd < 0) this.staticPrefixEnd = this.operations.length; this.rebuildRenderIndex(); }
  rebuildRenderIndex() { this.renderIndex.clear(); for (let index = 0; index < this.operations.length; index += 1) this.renderIndex.add(this.operations[index], this.boundsForOperation(this.operations[index])); }
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
    const { width, height } = this.atlasExtent;
    const sx = this.canvas.width / width, sy = this.canvas.height / height;
    if (this.committedDirty || !(sx > 1.001 || sy > 1.001)) return false;
    this.paintOperation(operation, this.committedCtx, { transform: { x: -this.atlasOrigin.x, y: -this.atlasOrigin.y, sx, sy } });
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
    const path = dynamic ? null : derivePath(operation.drawable, { width: this.width, height: this.height, time: this.time });
    const prepared = { dynamic, path, bounds: path ? boundsForPath(path, operation.drawable.style) : null };
    if (!dynamic && id) this.preparedDrawables.set(id, prepared);
    return prepared;
  }
  operationIntersectsTile(operation, tile) {
    if (operation?.type === "clear") return true;
    const bounds = this.boundsForOperation(operation);
    if (!bounds) return false;
    return bounds.right >= tile.x && bounds.left <= tile.x + tile.width && bounds.bottom >= tile.y && bounds.top <= tile.y + tile.height;
  }
  tile(x, y) {
    count("Drawing tile lookup", () => this.perfMetadata({ tile: { x, y }, hit: this.tiles.has(tileKey(x, y)) }));
    const key = tileKey(x, y); let tile = this.tiles.get(key);
    if (!tile) { const canvas = createPaintCanvas(TILE_SIZE, TILE_SIZE); tile = { x, y, canvas, ctx: canvas.getContext("2d") }; this.tiles.set(key, tile); this.rebuildTile(x, y); }
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
    }, () => this.perfMetadata({ tile: { x, y }, replayedOperations: this.operations.length }));
  }
  prepareView({ worldBounds, pixelWidth, pixelHeight } = {}) {
    if (!worldBounds) {
      const metadata = this.perfMetadata({ changed: false, reason: "missing-bounds" });
      count("Drawing prepare view", metadata); return measure("Drawing prepare view unchanged", () => false, metadata);
    }
    const left = Math.floor(worldBounds.left), top = Math.floor(worldBounds.top), right = Math.ceil(worldBounds.right), bottom = Math.ceil(worldBounds.bottom);
    if (!(right > left && bottom > top)) {
      const metadata = this.perfMetadata({ changed: false, reason: "empty-bounds" });
      count("Drawing prepare view", metadata); return measure("Drawing prepare view unchanged", () => false, metadata);
    }
    const requestedBounds = { left, top, width: right - left, height: bottom - top };
    const requestedPixels = { width: Math.max(1, Math.floor(pixelWidth || this.width)), height: Math.max(1, Math.floor(pixelHeight || this.height)) };
    const previousRequestedPixels = this.requestedPixelSize;
    this.requestedWorldBounds = requestedBounds; this.requestedPixelSize = requestedPixels;
    const safeWidth = this.atlasExtent.width * PREPARED_SAFE_FRACTION, safeHeight = this.atlasExtent.height * PREPARED_SAFE_FRACTION;
    const safeLeft = this.atlasOrigin.x + (this.atlasExtent.width - safeWidth) / 2, safeTop = this.atlasOrigin.y + (this.atlasExtent.height - safeHeight) / 2;
    const insideSafeRegion = left >= safeLeft && top >= safeTop && right <= safeLeft + safeWidth && bottom <= safeTop + safeHeight;
    const atlasPixelWidth = Math.min(4096, requestedPixels.width * PREPARED_ATLAS_SCALE), atlasPixelHeight = Math.min(4096, requestedPixels.height * PREPARED_ATLAS_SCALE);
    const outputResolutionChanged = !previousRequestedPixels || previousRequestedPixels.width !== requestedPixels.width || previousRequestedPixels.height !== requestedPixels.height;
    const changed = outputResolutionChanged || !insideSafeRegion;
    const reason = outputResolutionChanged ? "resolution" : insideSafeRegion ? "safe-region" : "outside-safe-region";
    count("Drawing prepare view", () => this.perfMetadata({ changed, reason }));
    if (!changed) return measure("Drawing prepare view unchanged", () => false, this.perfMetadata({ changed: false, reason }));
    return measure("Drawing prepare view change", () => {
      const atlasWidth = requestedBounds.width * PREPARED_ATLAS_SCALE, atlasHeight = requestedBounds.height * PREPARED_ATLAS_SCALE;
      this.atlasOrigin = { x: left - (atlasWidth - requestedBounds.width) / 2, y: top - (atlasHeight - requestedBounds.height) / 2 };
      this.atlasExtent = { width: atlasWidth, height: atlasHeight };
      if (this.canvas.width !== atlasPixelWidth) this.canvas.width = atlasPixelWidth; if (this.canvas.height !== atlasPixelHeight) this.canvas.height = atlasPixelHeight;
      if (this.committedCanvas.width !== atlasPixelWidth) this.committedCanvas.width = atlasPixelWidth; if (this.committedCanvas.height !== atlasPixelHeight) this.committedCanvas.height = atlasPixelHeight;
      this.ctx = this.canvas.getContext("2d"); this.committedCtx = this.committedCanvas.getContext("2d"); this.invalidateCommittedView(); this.atlasRecenterCount += 1; this.composeAtlas(); this.markFrameChanged(); return true;
    }, () => this.perfMetadata({ changed: true, reason }));
  }
  composeCommittedAtlas() {
    const { x, y } = this.atlasOrigin, { width, height } = this.atlasExtent;
    const context = this.committedCtx;
    const metadata = this.perfMetadata();
    return measure("Drawing committed atlas composition", () => {
    context.clearRect(0, 0, this.committedCanvas.width, this.committedCanvas.height);
    context.save(); context.globalAlpha = 1; context.fillStyle = this.backgroundColor; context.fillRect(0, 0, this.committedCanvas.width, this.committedCanvas.height);
    const sx = this.canvas.width / width, sy = this.canvas.height / height;
    // Tiles are a one-pixel-per-world-unit cache. Enlarging one after a zoom
    // makes a committed stroke softer than its live vector preview. At a
    // magnification, replay the durable paths into the view atlas at its
    // actual pixel density instead; the regular tile cache remains the fast
    // path when it is sampled at native resolution or smaller.
    if (sx > 1.001 || sy > 1.001) {
      for (let index = 0; index < this.operations.length; index += 1) {
        const operation = this.operations[index];
        if (operation?.drawable) this.paintOperation(operation, context, { transform: { x: -x, y: -y, sx, sy } });
      }
    } else for (let ty = floorTile(y); ty <= floorTile(y + height); ty += 1) for (let tx = floorTile(x); tx <= floorTile(x + width); tx += 1) {
      const tile = this.tile(tx, ty); context.drawImage(tile.canvas, (tx * TILE_SIZE - x) * sx, (ty * TILE_SIZE - y) * sy, TILE_SIZE * sx, TILE_SIZE * sy);
    }
    context.restore(); this.committedDirty = false;
    }, metadata);
  }
  composeAtlas() {
    const metadata = this.perfMetadata();
    return measure("Drawing atlas composition", () => {
      if (this.committedDirty) this.composeCommittedAtlas();
      const { x, y } = this.atlasOrigin, { width, height } = this.atlasExtent;
      const sx = this.canvas.width / width, sy = this.canvas.height / height;
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); this.ctx.save(); this.ctx.globalAlpha = 1;
      count("Drawing committed canvas drawImage", () => this.perfMetadata());
      this.ctx.drawImage(this.committedCanvas, 0, 0);
      if (this.preview) this.paintDrawable(this.preview, this.ctx, { preview: true, transform: { x: -x, y: -y, sx, sy } });
      this.ctx.restore();
    }, metadata);
  }
  rerender() { return measure("Drawing rerender", () => { this.composeAtlas(); this.markFrameChanged(); }, () => this.perfMetadata()); }
  paintOperation(operation, context, options = {}) { return this.paintDrawable(operation.drawable, context, { ...options, prepared: this.prepareOperation(operation) }); }
  paintCachedOperation(operation, context, tile) {
    if (operation.type === "clear") { context.clearRect(0, 0, tile?.width || this.canvas.width, tile?.height || this.canvas.height); return; }
    this.paintOperation(operation, context, { tile });
  }
  paintDrawable(drawable, context = this.ctx, { preview = false, tile = null, transform = null, prepared = null } = {}) {
    const path = prepared?.path || derivePath(drawable, { width: this.width, height: this.height, time: this.time }); if (!path.contours.length) return;
    if (["fiber", "hair"].includes(drawable.style.brush)) count("Drawing Fiber rasterization", () => this.perfMetadata({ preview, tile: tile ? { x: tile.x, y: tile.y } : null }));
    if (drawable.style.brush === "texture" && !brushTextureCatalog.get(drawable.style.textureId)) { this.requestTextureReplay(drawable.style.textureId); return; }
    context.save();
    if (tile) { context.beginPath?.(); context.rect?.(0, 0, tile.width, tile.height); context.clip?.(); context.translate(-tile.x, -tile.y); }
    if (transform) { context.translate(transform.x * transform.sx, transform.y * transform.sy); context.scale?.(transform.sx, transform.sy); }
    this.replayContours(context, path.contours, drawable.style, { x: 0, y: 0 }, preview);
    context.restore();
  }
  replayContours(context, contours, style, translation = { x: 0, y: 0 }, preview = false) { context.save(); context.translate(translation.x, translation.y); measure("Canvas brush replay", () => replayBrushContours(context, contours, preview ? { ...style, preview: true } : style), () => this.perfMetadata({ preview, contourCount: contours.length })); context.restore(); }
  requestTextureReplay(textureId) { if (this.pendingTextureReplays.has(textureId)) return; this.pendingTextureReplays.add(textureId); brushTextureCatalog.ensure(textureId).then(texture => { if (texture) { this.tiles.clear(); this.invalidateCommittedView(); this.rerender(); } }).finally(() => this.pendingTextureReplays.delete(textureId)); }
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
  get atlasOrigin() { return this.rasterizer.atlasOrigin; }
  get atlasExtent() { return this.rasterizer.atlasExtent; }
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
  get composeCommittedAtlas() { return this.rasterizer.composeCommittedAtlas.bind(this.rasterizer); }
  set composeCommittedAtlas(value) { this.rasterizer.composeCommittedAtlas = value; }
  getWorldScale() { return this.rasterizer.getWorldScale(); }
  getFrame() { return this.rasterizer.getFrame(); }
  prepareView(request) { return this.rasterizer.prepareView(request); }
  setTime(time) { return this.rasterizer.setTime(time); }
  previewDrawable(drawable) { return this.rasterizer.previewDrawable(drawable); }
  getContentState() { return this.document.getContentState(); }
  restoreContentState(state) { const change = this.document.restoreContentState(state); if (!change) return false; this.rasterizer.rebuildFrom(this.document.getRenderView()); return true; }
  canUndo() { return this.document.canUndo(); }
  getDrawable(id) { return this.document.getDrawable(id); }
  findLatestDrawable(predicate) { return this.document.findLatest(predicate); }
  commitDrawable(drawable) { const change = this.document.commit(drawable); if (!change) return null; this.rasterizer.applyChange(change, this.document.getRenderView()); return change.id; }
  beginReplaceAction(id) { return this.document.beginReplaceAction(id); }
  endReplaceAction() { this.document.endReplaceAction(); }
  replaceDrawable(id, drawable) { const change = this.document.replace(id, drawable); if (!change) return false; this.rasterizer.applyChange(change, this.document.getRenderView()); return true; }
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
