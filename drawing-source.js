import { BRUSHES, canReplayBrushPath, replayBrushContours } from "./brushes.js";
import { brushTextureCatalog } from "./brush-textures.js";
import { derivePath, drawableDependsOnTime, isDrawable } from "./drawable-path.js";
import { count, measure } from "./perf.js";

const TILE_SIZE = 1024;
const ANTIALIAS_PADDING = 2;
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
function boundsFor(drawable, width, height, time) {
  const path = derivePath(drawable, { width, height, time });
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const contour of path.contours || []) for (const p of contour.points || []) {
    left = Math.min(left, p.x); right = Math.max(right, p.x); top = Math.min(top, p.y); bottom = Math.max(bottom, p.y);
  }
  if ((path.instances || []).length > 1) {
    const base = { left, top, right, bottom }; left = Infinity; top = Infinity; right = -Infinity; bottom = -Infinity;
    for (const instance of path.instances) { left = Math.min(left, base.left + instance.x); top = Math.min(top, base.top + instance.y); right = Math.max(right, base.right + instance.x); bottom = Math.max(bottom, base.bottom + instance.y); }
  }
  if (!Number.isFinite(left)) return null;
  const pad = brushFootprint(drawable.style) + ANTIALIAS_PADDING;
  return { left: Math.floor(left - pad), top: Math.floor(top - pad), right: Math.ceil(right + pad), bottom: Math.ceil(bottom + pad) };
}
function contourBounds(contours, style) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const contour of contours) for (const point of contour.points || []) {
    minX = Math.min(minX, point.x); minY = Math.min(minY, point.y); maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
  }
  if (!Number.isFinite(minX)) return null;
  const pad = brushFootprint(style) + ANTIALIAS_PADDING;
  return { left: Math.floor(minX - pad), top: Math.floor(minY - pad), width: Math.ceil(maxX + pad) - Math.floor(minX - pad), height: Math.ceil(maxY + pad) - Math.floor(minY - pad) };
}

/** A sparse, unbounded Canvas2D drawing world. Tile/atlas pixels are caches. */
export class DrawingSource {
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
    this.tiles = new Map(); this.history = []; this.historyIndex = 0; this.preview = null;
    this.backgroundColor = "#000000"; this.time = 0; this.revision = 0; this.onFrameChange = onFrameChange;
    this.pendingTextureReplays = new Set(); this.motifCanvas = null; this.motifCtx = null;
    // Kept as compatibility/introspection fields; static tile replay is now lazy.
    this.staticPrefixEnd = 0; this.staticCheckpoints = [];
    this.composeAtlas();
  }

  getWorldScale() { return { width: this.width, height: this.height }; }
  getFrame() { return { pixels: this.canvas, width: this.canvas.width, height: this.canvas.height, revision: this.revision, world: { origin: this.atlasOrigin, extent: this.atlasExtent, scale: { width: this.width, height: this.height }, wrap: "clamp" } }; }
  getContentState() {
    // A clear makes all earlier applied operations visually unreachable. Keep
    // them in memory so Clear remains undoable during this session, but never
    // serialize an expensive Fiber history that a restored workspace cannot
    // display without undoing the clear.
    let start = 0;
    for (let index = this.historyIndex - 1; index >= 0; index -= 1) {
      if (this.history[index]?.type === "clear") { start = index + 1; break; }
    }
    return structuredClone({ backgroundColor: this.backgroundColor, history: this.history.slice(start), historyIndex: this.historyIndex - start });
  }
  isDrawable(drawable) { return isDrawable(drawable) && Boolean(BRUSHES[drawable?.style?.brush]) && (drawable.kind !== "pathStroke" || canReplayBrushPath(drawable.points, drawable.style)); }
  markFrameChanged() { this.revision += 1; this.onFrameChange(); }
  perfMetadata(extra = {}) {
    return {
      committedHistoryCount: this.historyIndex,
      activePreviewPointCount: this.preview?.points?.length || 0,
      atlasBounds: { left: this.atlasOrigin.x, top: this.atlasOrigin.y, width: this.atlasExtent.width, height: this.atlasExtent.height },
      atlasPixels: { width: this.canvas.width, height: this.canvas.height },
      committedDirty: this.committedDirty,
      ...extra
    };
  }

  restoreContentState(state) {
    if (!state || typeof state !== "object") return false;
    if (typeof state.backgroundColor === "string" && state.backgroundColor.trim()) this.backgroundColor = state.backgroundColor;
    this.history = Array.isArray(state.history) ? structuredClone(state.history.filter(op => op?.type === "clear" || (op?.type === "drawable" && this.isDrawable(op.drawable)))) : [];
    this.historyIndex = Math.min(this.history.length, Math.max(0, Math.floor(Number.isFinite(Number(state.historyIndex)) ? Number(state.historyIndex) : this.history.length)));
    this.preview = null; this.tiles.clear(); this.rebuildBase(); this.invalidateCommittedView(); this.rerender(); return true;
  }
  setBackgroundColor(color) { if (typeof color !== "string" || !color.trim() || color === this.backgroundColor) return false; this.backgroundColor = color; this.invalidateCommittedView(); this.rerender(); return true; }
  previewDrawable(drawable) {
    this.preview = this.isDrawable(drawable) ? structuredClone(drawable) : null;
    return measure("Drawing preview drawable", () => this.rerender(), () => this.perfMetadata());
  }
  commitDrawable(drawable) { if (!this.isDrawable(drawable)) return false; this.preview = null; this.appendOperation({ type: "drawable", drawable: structuredClone(drawable) }); return true; }
  replaceDrawable(index, drawable) { if (!Number.isInteger(index) || index < 0 || index >= this.historyIndex || !this.isDrawable(drawable) || this.history[index]?.type !== "drawable") return false; this.history[index] = { type: "drawable", drawable: structuredClone(drawable) }; this.rebuildBase(); this.invalidateCommittedView(); this.rerender(); return true; }
  clear() { this.preview = null; this.appendOperation({ type: "clear" }); }
  canUndo() { return this.historyIndex > 0; } canRedo() { return this.historyIndex < this.history.length; }
  undo() { if (!this.canUndo()) return false; this.historyIndex -= 1; this.rebuildBase(); this.invalidateCommittedView(); this.rerender(); return true; }
  redo() { if (!this.canRedo()) return false; this.historyIndex += 1; this.rebuildBase(); this.invalidateCommittedView(); this.rerender(); return true; }
  setTime(time) { const next = Number(time); if (!Number.isFinite(next) || next === this.time) return false; this.time = next; if (!this.history.slice(0, this.historyIndex).some(op => drawableDependsOnTime(op.drawable)) && !drawableDependsOnTime(this.preview)) return false; this.tiles.clear(); this.baseCtx.clearRect(0, 0, this.width, this.height); this.baseCtx.drawImage(this.baseStaticCanvas, 0, 0); for (let i = this.staticPrefixEnd; i < this.historyIndex; i += 1) this.paintOperation(this.history[i], this.baseCtx); this.invalidateCommittedView(); this.rerender(); return true; }

  appendOperation(operation) {
    if (this.historyIndex < this.history.length) this.history.splice(this.historyIndex);
    this.history.push(operation); this.historyIndex = this.history.length;
    // A clear invalidates every cached world tile. Other operations only rebuild
    // cached tiles they can reach; unseen tiles are reconstructed on demand.
    if (operation.type === "clear") this.tiles.clear(); else this.invalidateOperation(operation.drawable);
    this.staticPrefixEnd = this.history.slice(0, this.historyIndex).findIndex(op => drawableDependsOnTime(op.drawable));
    if (this.staticPrefixEnd < 0) this.staticPrefixEnd = this.historyIndex;
    if (["fiber", "hair"].includes(operation.drawable?.style?.brush)) this.staticCheckpoints.push({ index: this.historyIndex, canvas: this.baseStaticCanvas });
    this.invalidateCommittedView(); this.rerender();
  }
  rebuildBase() { this.tiles.clear(); this.staticPrefixEnd = this.history.slice(0, this.historyIndex).findIndex(op => drawableDependsOnTime(op.drawable)); if (this.staticPrefixEnd < 0) this.staticPrefixEnd = this.historyIndex; }
  invalidateCommittedView() { this.committedDirty = true; }
  invalidateOperation(drawable) {
    const bounds = boundsFor(drawable, this.width, this.height, this.time);
    if (!bounds) { this.tiles.clear(); return; }
    for (let y = floorTile(bounds.top); y <= floorTile(bounds.bottom); y += 1) for (let x = floorTile(bounds.left); x <= floorTile(bounds.right); x += 1) {
      const key = tileKey(x, y); if (this.tiles.has(key)) this.rebuildTile(x, y);
    }
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
      for (let index = 0; index < this.historyIndex; index += 1) {
        count("Drawing tile history operation replay", () => this.perfMetadata({ tile: { x, y }, historyIndex: index }));
        this.paintCachedOperation(this.history[index], tile.ctx, { x: x * TILE_SIZE, y: y * TILE_SIZE, width: TILE_SIZE, height: TILE_SIZE });
      }
    }, () => this.perfMetadata({ tile: { x, y }, replayedOperations: this.historyIndex }));
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
    const width = Math.max(1, Math.min(4096, Math.floor(pixelWidth || this.width)));
    const height = Math.max(1, Math.min(4096, Math.floor(pixelHeight || this.height)));
    const changed = left !== this.atlasOrigin.x || top !== this.atlasOrigin.y || right - left !== this.atlasExtent.width || bottom - top !== this.atlasExtent.height || width !== this.canvas.width || height !== this.canvas.height;
    count("Drawing prepare view", () => this.perfMetadata({ changed, requestedBounds: { left, top, width: right - left, height: bottom - top }, requestedPixels: { width, height } }));
    if (!changed) return measure("Drawing prepare view unchanged", () => false, this.perfMetadata({ changed: false }));
    return measure("Drawing prepare view change", () => {
      this.atlasOrigin = { x: left, y: top }; this.atlasExtent = { width: right - left, height: bottom - top };
      if (this.canvas.width !== width) this.canvas.width = width; if (this.canvas.height !== height) this.canvas.height = height;
      if (this.committedCanvas.width !== width) this.committedCanvas.width = width; if (this.committedCanvas.height !== height) this.committedCanvas.height = height;
      this.ctx = this.canvas.getContext("2d"); this.committedCtx = this.committedCanvas.getContext("2d"); this.invalidateCommittedView(); this.composeAtlas(); this.markFrameChanged(); return true;
    }, () => this.perfMetadata({ changed: true }));
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
      let first = 0;
      for (let index = this.historyIndex - 1; index >= 0; index -= 1) {
        if (this.history[index]?.type === "clear") { first = index + 1; break; }
      }
      for (let index = first; index < this.historyIndex; index += 1) {
        const drawable = this.history[index]?.drawable;
        if (drawable) this.paintDrawable(drawable, context, { transform: { x: -x, y: -y, sx, sy } });
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
  paintOperation(operation, context, tile) { return this.paintCachedOperation(operation, context, tile); }
  paintCachedOperation(operation, context, tile) {
    if (operation.type === "clear") { context.clearRect(0, 0, tile?.width || this.canvas.width, tile?.height || this.canvas.height); return; }
    this.paintDrawable(operation.drawable, context, { tile });
  }
  paintDrawable(drawable, context = this.ctx, { preview = false, tile = null, transform = null } = {}) {
    const path = derivePath(drawable, { width: this.width, height: this.height, time: this.time }); if (!path.contours.length) return;
    if (drawable.style.brush === "texture" && !brushTextureCatalog.get(drawable.style.textureId)) { this.requestTextureReplay(drawable.style.textureId); return; }
    context.save();
    if (tile) { context.beginPath?.(); context.rect?.(0, 0, tile.width, tile.height); context.clip?.(); context.translate(-tile.x, -tile.y); }
    if (transform) { context.translate(transform.x * transform.sx, transform.y * transform.sy); context.scale?.(transform.sx, transform.sy); }
    const instances = path.instances || [{ x: 0, y: 0 }];
    if (drawable.kind === "generatedStroke" && instances.length > 1) this.paintInstancedMotif(path.contours, instances, drawable.style, context, preview);
    else for (const instance of instances) this.replayContours(context, path.contours, drawable.style, instance, preview);
    context.restore();
  }
  replayContours(context, contours, style, translation = { x: 0, y: 0 }, preview = false) { context.save(); context.translate(translation.x, translation.y); measure("Canvas brush replay", () => replayBrushContours(context, contours, preview ? { ...style, preview: true } : style), () => this.perfMetadata({ preview, contourCount: contours.length })); context.restore(); }
  paintInstancedMotif(contours, instances, style, context, preview) {
    const bounds = contourBounds(contours, style); if (!bounds) return;
    this.ensureMotifCanvas(bounds.width, bounds.height); this.motifCtx.clearRect(0, 0, this.motifCanvas.width, this.motifCanvas.height);
    measure("Generated motif rasterization", () => this.replayContours(this.motifCtx, contours, style, { x: -bounds.left, y: -bounds.top }, preview), () => this.perfMetadata({ preview, contourCount: contours.length }));
    measure("Generated tile instance blits", () => { for (const instance of instances) { context.save(); context.globalCompositeOperation = "source-over"; if (preview) count("Drawing preview drawImage", () => this.perfMetadata()); context.drawImage(this.motifCanvas, bounds.left + instance.x, bounds.top + instance.y); context.restore(); } }, () => this.perfMetadata({ preview, instanceCount: instances.length }));
  }
  ensureMotifCanvas(width, height) { if (!this.motifCanvas) { this.motifCanvas = createPaintCanvas(width, height); this.motifCtx = this.motifCanvas.getContext("2d"); return; } if (this.motifCanvas.width < width) this.motifCanvas.width = width; if (this.motifCanvas.height < height) this.motifCanvas.height = height; }
  requestTextureReplay(textureId) { if (this.pendingTextureReplays.has(textureId)) return; this.pendingTextureReplays.add(textureId); brushTextureCatalog.ensure(textureId).then(texture => { if (texture) { this.tiles.clear(); this.invalidateCommittedView(); this.rerender(); } }).finally(() => this.pendingTextureReplays.delete(textureId)); }
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
  const run = (source, phase) => measure("Drawing Fiber preview benchmark", () => source.previewDrawable(fiber()), () => source.perfMetadata({ phase, committedStrokes: source.historyIndex, previewLength: 200 }));
  const empty = new DrawingSource({ width, height });
  run(empty, "empty");
  const populated = new DrawingSource({ width, height });
  for (let index = 0; index < Math.max(0, Math.floor(committedStrokes)); index += 1) populated.commitDrawable(fiber((index % 12) * 12));
  run(populated, "populated");
  return { empty, populated };
}
