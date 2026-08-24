import { BRUSHES, canReplayBrushPath, replayBrushContours } from "./brushes.js";
import { brushTextureCatalog } from "./brush-textures.js";
import { derivePath, drawableDependsOnTime, isDrawable } from "./drawable-path.js";
import { measure } from "./perf.js";

function createPaintCanvas(width, height) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  return canvas;
}

const ANTIALIAS_PADDING = 2;

function finiteNonNegative(value) {
  return Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0);
}

function brushFootprint(style) {
  const size = finiteNonNegative(style.size);
  switch (style.brush) {
    case "ribbon":
      return finiteNonNegative(style.span) / 2 + size / 2;
    case "calligraphy":
      return Math.max(size, size * finiteNonNegative(style.nibRatio)) / 2;
    case "spray":
      return size / 2 + finiteNonNegative(style.particleSize) / 2;
    case "texture":
      return size * Math.SQRT2 / 2;
    case "pen":
    default:
      return size / 2;
  }
}

function contourBounds(contours, style) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const contour of contours) {
    if (!canReplayBrushPath(contour.points, style)) continue;
    for (const point of contour.points) {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
      minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
    }
  }
  if (!Number.isFinite(minX)) return null;
  const padding = brushFootprint(style) + ANTIALIAS_PADDING;
  const left = Math.floor(minX - padding), top = Math.floor(minY - padding);
  const right = Math.ceil(maxX + padding), bottom = Math.ceil(maxY + padding);
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

/** WebGL-free drawable cache, history, and replay owner. */
export class DrawingSource {
  constructor({ width = 2048, height = 2048, onFrameChange = () => {} } = {}) {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.canvas = createPaintCanvas(this.width, this.height);
    this.ctx = this.canvas.getContext("2d");
    this.baseCanvas = createPaintCanvas(this.width, this.height);
    this.baseCtx = this.baseCanvas.getContext("2d");
    this.baseStaticCanvas = createPaintCanvas(this.width, this.height);
    this.baseStaticCtx = this.baseStaticCanvas.getContext("2d");
    this.staticPrefixEnd = 0;
    this.motifCanvas = null;
    this.motifCtx = null;
    this.backgroundColor = "#000000";
    this.history = [];
    this.historyIndex = 0;
    this.preview = null;
    this.time = 0;
    this.pendingTextureReplays = new Set();
    this.onFrameChange = onFrameChange;
    this.revision = 0;
    this.copyBaseToWorking();
  }

  getFrame() { return { pixels: this.canvas, width: this.width, height: this.height, revision: this.revision }; }

  getContentState() { return structuredClone({ backgroundColor: this.backgroundColor, history: this.history, historyIndex: this.historyIndex }); }

  restoreContentState(state) {
    if (!state || typeof state !== "object") return false;
    if (typeof state.backgroundColor === "string" && state.backgroundColor.trim()) this.backgroundColor = state.backgroundColor;
    this.history = Array.isArray(state.history) ? structuredClone(state.history.filter(operation => operation?.type === "clear" || this.isDrawable(operation?.drawable))) : [];
    const index = Number(state.historyIndex);
    this.historyIndex = Math.min(this.history.length, Math.max(0, Math.floor(Number.isFinite(index) ? index : this.history.length)));
    this.preview = null;
    this.rebuildBase(); this.rerender();
    return true;
  }

  isDrawable(drawable) {
    if (!isDrawable(drawable)) return false;
    if (!BRUSHES[drawable.style.brush]) return false;
    return drawable.kind !== "pathStroke" || canReplayBrushPath(drawable.points, drawable.style);
  }
  setBackgroundColor(color) { if (typeof color !== "string" || !color.trim() || color === this.backgroundColor) return false; this.backgroundColor = color; this.rerender(); return true; }
  previewDrawable(drawable) { this.preview = this.isDrawable(drawable) ? structuredClone(drawable) : null; this.rerender(); }
  commitDrawable(drawable) { if (!this.isDrawable(drawable)) return false; this.preview = null; this.appendOperation({ type: "drawable", drawable: structuredClone(drawable) }); return true; }
  replaceDrawable(index, drawable) {
    if (!Number.isInteger(index) || index < 0 || index >= this.historyIndex || !this.isDrawable(drawable)) return false;
    const operation = this.history[index];
    if (operation?.type !== "drawable") return false;
    this.history[index] = { type: "drawable", drawable: structuredClone(drawable) };
    this.rebuildBase(); this.rerender();
    return true;
  }
  clear() { this.preview = null; this.appendOperation({ type: "clear" }); }
  canUndo() { return this.historyIndex > 0; }
  canRedo() { return this.historyIndex < this.history.length; }
  undo() { if (!this.canUndo()) return false; this.historyIndex -= 1; this.rebuildBase(); this.rerender(); return true; }
  redo() { if (!this.canRedo()) return false; this.historyIndex += 1; this.rebuildBase(); this.rerender(); return true; }
  setTime(time) {
    return measure("DrawingSource setTime", () => {
      const next = Number(time);
      if (!Number.isFinite(next) || next === this.time) return false;
      this.time = next;
      const committedDependsOnTime = this.staticPrefixEnd < this.historyIndex;
      const previewDependsOnTime = drawableDependsOnTime(this.preview);
      if (!committedDependsOnTime && !previewDependsOnTime) return false;
      if (committedDependsOnTime) this.composeBase();
      this.rerender();
      return true;
    });
  }

  markFrameChanged() { this.revision += 1; this.onFrameChange(); }
  appendOperation(operation) {
    if (this.historyIndex < this.history.length) this.history.splice(this.historyIndex);
    const hadStaticOnlyHistory = this.staticPrefixEnd === this.historyIndex;
    this.history.push(operation); this.historyIndex = this.history.length;
    if (hadStaticOnlyHistory && !drawableDependsOnTime(operation.drawable)) {
      this.paintOperation(operation, this.baseStaticCtx);
      this.staticPrefixEnd = this.historyIndex;
    } else if (hadStaticOnlyHistory) {
      this.staticPrefixEnd = this.historyIndex - 1;
    }
    this.paintOperation(operation, this.baseCtx);
    this.copyBaseToWorking(); this.markFrameChanged();
  }
  rebuildBase() {
    this.staticPrefixEnd = this.historyIndex;
    for (let index = 0; index < this.historyIndex; index += 1) {
      if (drawableDependsOnTime(this.history[index].drawable)) {
        this.staticPrefixEnd = index;
        break;
      }
    }
    this.clearPaint(this.baseStaticCtx);
    for (let index = 0; index < this.staticPrefixEnd; index += 1) this.paintOperation(this.history[index], this.baseStaticCtx);
    this.composeBase();
  }
  composeBase() {
    return measure("DrawingSource composeBase", () => {
      this.clearPaint(this.baseCtx);
      this.baseCtx.save(); this.baseCtx.globalAlpha = 1; this.baseCtx.drawImage(this.baseStaticCanvas, 0, 0); this.baseCtx.restore();
      for (let index = this.staticPrefixEnd; index < this.historyIndex; index += 1) this.paintOperation(this.history[index], this.baseCtx);
    });
  }
  rerender() { return measure("DrawingSource rerender", () => { this.copyBaseToWorking(); if (this.preview) this.paintDrawable(this.preview); this.markFrameChanged(); }); }
  paintOperation(operation, context) { if (operation.type === "clear") this.clearPaint(context); else if (operation.type === "drawable") this.paintDrawable(operation.drawable, context); }
  paintDrawable(drawable, context = this.ctx) {
    const path = derivePath(drawable, { width: this.width, height: this.height, time: this.time });
    if (!path.contours.length) return;
    if (drawable.style.brush === "texture" && !brushTextureCatalog.get(drawable.style.textureId)) { this.requestTextureReplay(drawable.style.textureId); return; }
    const instances = path.instances || [{ x: 0, y: 0 }];
    if (drawable.kind === "generatedStroke" && instances.length > 1) {
      this.paintInstancedMotif(path.contours, instances, drawable.style, context);
      return;
    }
    this.replayContours(context, path.contours, drawable.style, instances[0] || { x: 0, y: 0 });
  }
  replayContours(context, contours, style, translation = { x: 0, y: 0 }) {
    context.save(); context.translate(translation.x, translation.y);
    measure("Canvas brush replay", () => replayBrushContours(context, contours, style));
    context.restore();
  }
  paintInstancedMotif(contours, instances, style, context) {
    const bounds = contourBounds(contours, style);
    if (!bounds) return;
    this.ensureMotifCanvas(bounds.width, bounds.height);
    this.motifCtx.save();
    this.motifCtx.clearRect(0, 0, this.motifCanvas.width, this.motifCanvas.height);
    this.motifCtx.restore();
    measure("Generated motif rasterization", () => this.replayContours(this.motifCtx, contours, style, { x: -bounds.left, y: -bounds.top }));
    measure("Generated tile instance blits", () => {
      for (const instance of instances) {
        context.save();
        context.globalCompositeOperation = "source-over";
        context.drawImage(this.motifCanvas, bounds.left + instance.x, bounds.top + instance.y);
        context.restore();
      }
    });
  }
  ensureMotifCanvas(width, height) {
    if (!this.motifCanvas) {
      this.motifCanvas = createPaintCanvas(width, height);
      this.motifCtx = this.motifCanvas.getContext("2d");
      return;
    }
    if (this.motifCanvas.width < width) this.motifCanvas.width = width;
    if (this.motifCanvas.height < height) this.motifCanvas.height = height;
  }
  requestTextureReplay(textureId) {
    if (this.pendingTextureReplays.has(textureId)) return;
    this.pendingTextureReplays.add(textureId);
    brushTextureCatalog.ensure(textureId).then(texture => { if (texture) { this.rebuildBase(); this.rerender(); } }).finally(() => this.pendingTextureReplays.delete(textureId));
  }
  clearPaint(context) { context.save(); context.globalAlpha = 1; context.clearRect(0, 0, this.width, this.height); context.restore(); }
  fillBackground(context) { context.save(); context.globalAlpha = 1; context.fillStyle = this.backgroundColor; context.fillRect(0, 0, this.width, this.height); context.restore(); }
  copyBaseToWorking() { return measure("DrawingSource copyBaseToWorking", () => { this.fillBackground(this.ctx); this.ctx.save(); this.ctx.globalAlpha = 1; this.ctx.drawImage(this.baseCanvas, 0, 0); this.ctx.restore(); }); }
}
