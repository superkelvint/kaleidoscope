import { BRUSHES, canReplayBrushPath, replayBrushPath } from "./brushes.js";
import { brushTextureCatalog } from "./brush-textures.js";
import { derivePath, drawableDependsOnTime, isDrawable } from "./drawable-path.js";

function createPaintCanvas(width, height) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  return canvas;
}

/** WebGL-free drawable cache, history, and replay owner. */
export class DrawingSource {
  constructor({ width = 2048, height = 2048 } = {}) {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.canvas = createPaintCanvas(this.width, this.height);
    this.ctx = this.canvas.getContext("2d");
    this.baseCanvas = createPaintCanvas(this.width, this.height);
    this.baseCtx = this.baseCanvas.getContext("2d");
    this.backgroundColor = "#000000";
    this.history = [];
    this.historyIndex = 0;
    this.preview = null;
    this.time = 0;
    this.pendingTextureReplays = new Set();
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
    const next = Number(time);
    if (!Number.isFinite(next) || next === this.time) return false;
    this.time = next;
    if (![...this.history.slice(0, this.historyIndex).map(operation => operation.drawable), this.preview].some(drawableDependsOnTime)) return false;
    this.rebuildBase(); this.rerender();
    return true;
  }

  appendOperation(operation) {
    if (this.historyIndex < this.history.length) this.history.splice(this.historyIndex);
    this.history.push(operation); this.historyIndex = this.history.length;
    this.paintOperation(operation, this.baseCtx);
    this.copyBaseToWorking(); this.revision += 1;
  }
  rebuildBase() { this.clearPaint(this.baseCtx); for (let i = 0; i < this.historyIndex; i += 1) this.paintOperation(this.history[i], this.baseCtx); }
  rerender() { this.copyBaseToWorking(); if (this.preview) this.paintDrawable(this.preview); this.revision += 1; }
  paintOperation(operation, context) { if (operation.type === "clear") this.clearPaint(context); else if (operation.type === "drawable") this.paintDrawable(operation.drawable, context); }
  paintDrawable(drawable, context = this.ctx) {
    const path = derivePath(drawable, { width: this.width, height: this.height, time: this.time });
    if (!path.contours.length) return;
    if (drawable.style.brush === "texture" && !brushTextureCatalog.get(drawable.style.textureId)) { this.requestTextureReplay(drawable.style.textureId); return; }
    for (const contour of path.contours) if (canReplayBrushPath(contour.points, drawable.style)) replayBrushPath(context, contour.points, drawable.style);
  }
  requestTextureReplay(textureId) {
    if (this.pendingTextureReplays.has(textureId)) return;
    this.pendingTextureReplays.add(textureId);
    brushTextureCatalog.ensure(textureId).then(texture => { if (texture) { this.rebuildBase(); this.rerender(); } }).finally(() => this.pendingTextureReplays.delete(textureId));
  }
  clearPaint(context) { context.save(); context.globalAlpha = 1; context.clearRect(0, 0, this.width, this.height); context.restore(); }
  fillBackground(context) { context.save(); context.globalAlpha = 1; context.fillStyle = this.backgroundColor; context.fillRect(0, 0, this.width, this.height); context.restore(); }
  copyBaseToWorking() { this.fillBackground(this.ctx); this.ctx.save(); this.ctx.globalAlpha = 1; this.ctx.drawImage(this.baseCanvas, 0, 0); this.ctx.restore(); }
}
