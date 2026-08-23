import { BRUSHES, canReplayBrushPath, replayBrushPath } from "./brushes.js";
import { DEFAULT_BRUSH_TEXTURE_ID, brushTextureCatalog } from "./brush-textures.js";
import { interpretGesture, preprocessGesture, sampleCanonicalGesture } from "./gesture-interpreter.js";
import { globalWallpaperPoint } from "./global-wallpaper.js";
import { sampleCircularArc, sampleCubicBezier } from "./constructed-strokes.js";

const TAU = Math.PI * 2;
const GENERATED_SAMPLE_CAP = 512;
const FREEHAND_SAMPLE_CAP = 512;
const DEFAULT_SMOOTHING = 0.35;
const FLUSH_TARGET_DISTANCE = 0.25;
const MAX_FLUSH_STEPS = 64;
const CONTINUOUS_BRUSH_RATES = { spray: 30, texture: 12 };
const CONTINUOUS_TICK_MS = 1000 / 60;

// Each constructed tool describes geometry only. Pointer stages, frozen
// mapping, previews, guide snapshots, and committing a normal brush path are
// shared by DrawingSource so future curve tools do not need a second input
// system.
export const CONSTRUCTED_TOOLS = {
  arc: {
    anchors: ["start", "end"],
    handles: [{ id: "bend" }],
    stages: { start: "end", end: "handle", handle: "commit" },
    initialHandles({ start, end }) {
      const midpoint = { x: (start.x + end.x) * .5, y: (start.y + end.y) * .5 };
      const length = Math.hypot(end.x - start.x, end.y - start.y) || 1;
      return { bend: { x: midpoint.x - (end.y - start.y) / length * length * .25, y: midpoint.y + (end.x - start.x) / length * length * .25 } };
    },
    buildPreview({ anchors, handles, sampleCount }) {
      return sampleCircularArc(anchors.start, anchors.end, handles.bend, { sampleCount });
    },
    ready(construction) { return Boolean(construction.anchors.start && construction.anchors.end && construction.handles.bend); }
  },
  // The sampler and descriptor are intentionally present now; selecting it is
  // deferred until its exact two-handle staging has product direction.
  bezier: {
    anchors: ["start", "end"],
    handles: [{ id: "startHandle", anchor: "start" }, { id: "endHandle", anchor: "end" }],
    stages: { start: "end", end: "handle", handle: "commit" },
    initialHandles({ start, end }) {
      return { startHandle: { x: (start.x * 2 + end.x) / 3, y: (start.y * 2 + end.y) / 3 }, endHandle: { x: (start.x + end.x * 2) / 3, y: (start.y + end.y * 2) / 3 } };
    },
    buildPreview({ anchors, handles, sampleCount }) { return sampleCubicBezier(anchors.start, anchors.end, handles.startHandle, handles.endHandle, { sampleCount }); },
    ready(construction) { return Boolean(construction.anchors.start && construction.anchors.end && construction.handles.startHandle && construction.handles.endHandle); }
  }
};

function now() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function fract(value) {
  return value - Math.floor(value);
}

function mod(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

export function smoothingAlpha(amount) {
  const smoothing = Math.min(1, Math.max(0, Number(amount) || 0));
  return 1 - smoothing * 0.88;
}

// GLSL mat2 constructors are column-major: render.js's
// mat2(c, -s, s, c) rotates clockwise for a positive angle. Keep this CPU
// counterpart identical so drawing samples map to the pixels the shader reads.
export function rotateForRenderer(point, angle) {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return {
    x: cosine * point.x + sine * point.y,
    y: -sine * point.x + cosine * point.y
  };
}

function radialFold(point, segments, mirror) {
  const radius = Math.hypot(point.x, point.y);
  const wedge = TAU / Math.max(segments, 2);
  let angle = mod(Math.atan2(point.y, point.x) + TAU, wedge);
  if (mirror) angle = Math.abs(angle - wedge * 0.5);
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

function mirrorTile(point, scale) {
  return {
    x: Math.abs(fract(point.x * scale) - 0.5) / scale,
    y: Math.abs(fract(point.y * scale) - 0.5) / scale
  };
}

function radialRing(point, scale) {
  return Math.floor(Math.hypot(point.x, point.y) * Math.max(2, scale * 2));
}

function localMotifPoint(point, state) {
  const segments = Math.max(2, Number(state.segments) || 2);
  const twist = Number(state.twist) || 0;
  const mode = state.symmetryMode;
  const scale = segments * 0.25;
  const twisted = rotateForRenderer(point, Math.hypot(point.x, point.y) * twist);

  if (mode === "radial") return radialFold(twisted, segments, Boolean(state.mirror));
  if (mode === "mirrorRadial" || mode === "spiral") return radialFold(twisted, segments, true);
  if (mode === "tunnel") {
    const folded = radialFold(twisted, segments, true);
    const rings = Math.max(1, scale);
    const length = Math.hypot(folded.x + 0.00001, folded.y);
    return {
      x: ((folded.x + 0.00001) / length) * fract(Math.hypot(folded.x, folded.y) * rings) / rings,
      y: (folded.y / length) * fract(Math.hypot(folded.x, folded.y) * rings) / rings
    };
  }
  if (mode === "fractalFold") {
    let folded = { x: twisted.x * scale, y: twisted.y * scale };
    for (let index = 0; index < 3; index += 1) {
      folded = { x: Math.abs(folded.x), y: Math.abs(folded.y) };
      folded = rotateForRenderer(folded, Math.PI / 3);
      folded = { x: fract(folded.x * 1.75) - 0.5, y: fract(folded.y * 1.75) - 0.5 };
    }
    return { x: folded.x / scale, y: folded.y / scale };
  }
  if (mode === "tile" || mode === "wallpaper") return mirrorTile(twisted, scale);
  if (mode === "p2") {
    const ring = radialRing(twisted, scale);
    return rotateForRenderer(radialFold(twisted, segments, true), mod(ring, 2) * Math.PI);
  }
  if (mode === "p4") {
    const ring = radialRing(twisted, scale);
    return rotateForRenderer(radialFold(twisted, segments, true), mod(ring, 4) * Math.PI * 0.5);
  }
  if (mode === "pg") {
    const wedge = TAU / segments;
    const ring = radialRing(twisted, scale);
    let folded = radialFold(rotateForRenderer(twisted, mod(ring, 2) * wedge * 0.5), segments, true);
    if (mod(ring, 2) > 0.5) folded = rotateForRenderer(folded, Math.PI);
    return folded;
  }
  if (mode === "hexagonal") {
    const folded = { x: twisted.x * scale * 1.154700538, y: twisted.y * scale };
    folded.y += mod(Math.floor(folded.x), 2) * 0.5;
    folded.x = fract(folded.x) - 0.5;
    folded.y = fract(folded.y) - 0.5;
    folded.x *= 0.866025404;
    return { x: Math.abs(folded.x) / scale, y: Math.abs(folded.y) / scale };
  }
  return mirrorTile(twisted, scale);
}

function screenToSourcePoint(event, displayCanvas, rendererState, sourceWidth, sourceHeight) {
  const rect = displayCanvas.getBoundingClientRect();
  const clientX = Number(event.x ?? event.clientX);
  const clientY = Number(event.y ?? event.clientY);
  const displayX = (clientX - rect.left) / Math.max(rect.width, 1);
  const displayY = (clientY - rect.top) / Math.max(rect.height, 1);
  const uv = { x: displayX, y: 1 - displayY };
  const center = {
    x: Number.isFinite(rendererState.centerX) ? rendererState.centerX : 0.5,
    y: Number.isFinite(rendererState.centerY) ? rendererState.centerY : 0.5
  };
  const aspect = Math.max(rect.width, 1) / Math.max(rect.height, 1);
  const screenPoint = { x: (uv.x - center.x) * aspect, y: uv.y - center.y };

  let globalPoint = screenPoint;
  if (rendererState.wallpaperMode && rendererState.wallpaperMode !== "single") {
    globalPoint = rotateForRenderer({
      x: screenPoint.x - (Number(rendererState.gridX) || 0),
      y: screenPoint.y - (Number(rendererState.gridY) || 0)
    }, -(Number(rendererState.gridRotationDeg) || 0) * Math.PI / 180);
  }
  let sourcePoint = localMotifPoint(globalWallpaperPoint(
    globalPoint,
    rendererState.wallpaperMode,
    rendererState.wallpaperSize
  ), rendererState);
  sourcePoint = rotateForRenderer(sourcePoint, Number(rendererState.rotationRad) || 0);
  sourcePoint.x /= aspect;
  sourcePoint.x /= Math.max(Number(rendererState.zoom) || 1, 0.001);
  sourcePoint.y /= Math.max(Number(rendererState.zoom) || 1, 0.001);
  sourcePoint.x += Number(rendererState.panX) || 0;
  sourcePoint.y += Number(rendererState.panY) || 0;
  sourcePoint.x += 0.5;
  sourcePoint.y += 0.5;

  const imageAspect = sourceWidth / sourceHeight;
  if (imageAspect > aspect) sourcePoint.y = (sourcePoint.y - 0.5) * (aspect / imageAspect) + 0.5;
  else sourcePoint.x = (sourcePoint.x - 0.5) * (imageAspect / aspect) + 0.5;

  return {
    x: fract(sourcePoint.x) * sourceWidth,
    // WebGL uploads Canvas2D pixels with UNPACK_FLIP_Y_WEBGL, so invert this
    // texture-space coordinate back to Canvas2D's top-left origin.
    y: (1 - fract(sourcePoint.y)) * sourceHeight
  };
}

function createPaintCanvas(width, height) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** Build immutable display-space symmetry context from the gesture's mapping state. */
export function displayGeometryContext(rendererState, displayCanvas) {
  const rect = displayCanvas.getBoundingClientRect();
  const centerX = Number.isFinite(rendererState.centerX) ? rendererState.centerX : 0.5;
  const centerY = Number.isFinite(rendererState.centerY) ? rendererState.centerY : 0.5;
  return {
    segments: rendererState.segments,
    symmetryMode: rendererState.symmetryMode,
    mirror: rendererState.mirror,
    center: {
      x: rect.left + centerX * rect.width,
      y: rect.top + (1 - centerY) * rect.height
    }
  };
}

/**
 * WebGL-independent Canvas2D source. Renderer uploads its frame when revision
 * changes, just as it does for BitmapSource.
 */
export class DrawingSource {
  constructor({ width = 2048, height = 2048, getRendererState = () => ({}) } = {}) {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.canvas = createPaintCanvas(this.width, this.height);
    this.ctx = this.canvas.getContext("2d");
    this.baseCanvas = createPaintCanvas(this.width, this.height);
    this.baseCtx = this.baseCanvas.getContext("2d");
    this.revision = 0;
    this.backgroundColor = "#000000";
    this.color = "#ffffff";
    this.colorMode = "solid";
    this.gradientStartColor = "#ffffff";
    this.gradientEndColor = "#ff4da6";
    this.size = 8;
    this.opacity = 0.85;
    this.brushName = "pen";
    this.lines = 5;
    this.span = 24;
    this.nibRatio = 0.22;
    this.density = 24;
    this.particleSize = 1.5;
    this.textureId = DEFAULT_BRUSH_TEXTURE_ID;
    this.textureSpacing = 0.25;
    this.textureRotationMode = "followStroke";
    this.behavior = "freehand";
    this.smoothing = DEFAULT_SMOOTHING;
    this.history = [];
    this.historyIndex = 0;
    this.currentGesture = null;
    this.previewGesture = null;
    this.construction = null;
    // Texture decoding is asynchronous. Keep one replay request per texture
    // while a history rebuild is waiting for it, rather than letting the
    // temporary working canvas become the only place a late texture appears.
    this.pendingTextureReplays = new Set();
    this.pointerId = null;
    this.continuousDepositionTimer = null;
    this.lastPoint = null;
    this.rawPoint = null;
    this.smoothedPoint = null;
    this.getRendererState = getRendererState;
    this.clearPaint(this.baseCtx);
    this.copyBaseToWorking();
  }

  getFrame() {
    return { pixels: this.canvas, width: this.width, height: this.height, revision: this.revision };
  }

  /** Serializable state only: history replays into the Canvas2D source. */
  getState() {
    return structuredClone({
      backgroundColor: this.backgroundColor,
      color: this.color, colorMode: this.colorMode,
      gradientStartColor: this.gradientStartColor, gradientEndColor: this.gradientEndColor,
      size: this.size, opacity: this.opacity, brushName: this.brushName,
      lines: this.lines, span: this.span, nibRatio: this.nibRatio,
      density: this.density, particleSize: this.particleSize,
      textureId: this.textureId, textureSpacing: this.textureSpacing, textureRotationMode: this.textureRotationMode,
      behavior: this.behavior, smoothing: this.smoothing,
      history: this.history, historyIndex: this.historyIndex
    });
  }

  restoreState(state) {
    if (!state || typeof state !== "object") return false;
    this.setBackgroundColor(state.backgroundColor, { rerender: false });
    this.setColor(state.color); this.setColorMode(state.colorMode);
    this.setGradientStartColor(state.gradientStartColor); this.setGradientEndColor(state.gradientEndColor);
    this.setSize(state.size); this.setOpacity(state.opacity); this.setBrush(state.brushName);
    this.setLines(state.lines); this.setSpan(state.span); this.setNibRatio(state.nibRatio);
    this.setDensity(state.density); this.setParticleSize(state.particleSize);
    if (brushTextureCatalog.getEntry(state.textureId)) this.textureId = state.textureId;
    this.setTextureSpacing(state.textureSpacing); this.setTextureRotationMode(state.textureRotationMode);
    this.setBehavior(state.behavior); this.setSmoothing(state.smoothing);
    const history = Array.isArray(state.history) ? state.history.filter(operation => {
      if (operation?.type === "clear") return true;
      const gesture = operation?.type === "gesture" ? operation.gesture : null;
      return Array.isArray(gesture?.points) && gesture.points.every(point => Number.isFinite(point?.x) && Number.isFinite(point?.y) &&
        (point.holdCount === undefined || (Number.isFinite(point.holdCount) && point.holdCount >= 0))) &&
        gesture.style && Object.prototype.hasOwnProperty.call(BRUSHES, gesture.style.brush);
    }) : [];
    this.history = structuredClone(history);
    const savedIndex = Number(state.historyIndex);
    this.historyIndex = Math.min(history.length, Math.max(0, Math.floor(Number.isFinite(savedIndex) ? savedIndex : history.length)));
    this.previewGesture = null;
    this.rebuildBase();
    this.rerender();
    return true;
  }

  setColor(color) {
    if (typeof color === "string" && color.trim()) this.color = color;
  }

  setBackgroundColor(color, { rerender = true } = {}) {
    if (typeof color !== "string" || !color.trim() || color === this.backgroundColor) return false;
    this.backgroundColor = color;
    if (rerender) {
      // baseCanvas contains only the transparent stroke history. A background
      // change therefore needs one composite, not an expensive replay of every
      // stamped texture stroke while a color picker is moving.
      this.rerender();
    }
    return true;
  }

  setColorMode(mode) {
    if (mode === "solid" || mode === "gradient") this.colorMode = mode;
  }

  setGradientStartColor(color) {
    if (typeof color === "string" && color.trim()) this.gradientStartColor = color;
  }

  setGradientEndColor(color) {
    if (typeof color === "string" && color.trim()) this.gradientEndColor = color;
  }

  setSize(size) {
    const value = Number(size);
    if (Number.isFinite(value)) this.size = Math.min(100, Math.max(1, value));
  }

  setOpacity(opacity) {
    const value = Number(opacity);
    if (Number.isFinite(value)) this.opacity = Math.min(1, Math.max(0, value));
  }

  setBrush(name) {
    if (!Object.prototype.hasOwnProperty.call(BRUSHES, name) && !Object.prototype.hasOwnProperty.call(CONSTRUCTED_TOOLS, name)) return;
    if (name !== this.brushName) this.cancelConstruction();
    this.brushName = name;
  }

  async setTextureId(id) {
    if (!brushTextureCatalog.getEntry(id)) return null;
    this.textureId = id;
    let texture = await brushTextureCatalog.ensure(id);
    if (!texture && id === DEFAULT_BRUSH_TEXTURE_ID) {
      for (const entry of brushTextureCatalog.entries) {
        texture = await brushTextureCatalog.ensure(entry.id);
        if (texture) {
          this.textureId = entry.id;
          break;
        }
      }
    }
    this.rerender();
    return texture;
  }

  setTextureSpacing(value) {
    const number = Number(value);
    if (Number.isFinite(number)) this.textureSpacing = Math.min(1, Math.max(0.05, number));
  }

  setTextureRotationMode(mode) {
    if (mode === "followStroke" || mode === "fixed") this.textureRotationMode = mode;
  }

  setBehavior(behavior) {
    if (behavior === "geometric" || behavior === "freehand") this.behavior = behavior;
  }

  setSmoothing(amount) {
    const value = Number(amount);
    if (Number.isFinite(value)) this.smoothing = Math.min(1, Math.max(0, value));
  }

  setLines(value) {
    const number = Number(value);
    if (Number.isFinite(number)) this.lines = Math.min(20, Math.max(1, Math.round(number)));
  }

  setSpan(value) {
    const number = Number(value);
    if (Number.isFinite(number)) this.span = Math.min(200, Math.max(0, number));
  }

  setNibRatio(value) {
    const number = Number(value);
    if (Number.isFinite(number)) this.nibRatio = Math.min(1, Math.max(0.05, number));
  }

  setDensity(value) {
    const number = Number(value);
    if (Number.isFinite(number)) this.density = Math.min(100, Math.max(1, Math.round(number)));
  }

  setParticleSize(value) {
    const number = Number(value);
    if (Number.isFinite(number)) this.particleSize = Math.min(10, Math.max(0.5, number));
  }

  clear() {
    this.appendOperation({ type: "clear" });
  }

  fillBackground(context = this.ctx) {
    context.save();
    context.globalAlpha = 1;
    context.fillStyle = this.backgroundColor;
    context.fillRect(0, 0, this.width, this.height);
    context.restore();
  }

  clearPaint(context = this.ctx) {
    context.save();
    context.globalAlpha = 1;
    context.clearRect(0, 0, this.width, this.height);
    context.restore();
  }

  canUndo() { return this.historyIndex > 0; }
  canRedo() { return this.historyIndex < this.history.length; }

  undo() {
    if (!this.canUndo()) return false;
    this.historyIndex -= 1;
    this.rebuildBase();
    this.rerender();
    return true;
  }

  redo() {
    if (!this.canRedo()) return false;
    this.historyIndex += 1;
    this.rebuildBase();
    this.rerender();
    return true;
  }

  appendOperation(operation) {
    if (this.historyIndex < this.history.length) this.history.splice(this.historyIndex);
    this.history.push(operation);
    this.historyIndex = this.history.length;
    this.paintOperation(operation, this.baseCtx);
    this.copyBaseToWorking();
    this.revision += 1;
  }

  rerender() {
    this.copyBaseToWorking();
    if (this.previewGesture) this.paintGesture(this.previewGesture);
    this.revision += 1;
  }

  rebuildBase() {
    this.clearPaint(this.baseCtx);
    for (let index = 0; index < this.historyIndex; index += 1) this.paintOperation(this.history[index], this.baseCtx);
  }

  copyBaseToWorking() {
    this.ctx.save();
    this.ctx.globalAlpha = 1;
    this.fillBackground(this.ctx);
    this.ctx.drawImage(this.baseCanvas, 0, 0);
    this.ctx.restore();
  }

  paintOperation(operation, context = this.ctx) {
    if (operation.type === "clear") {
      this.clearPaint(context);
    } else if (operation.type === "gesture") {
      this.paintGesture(operation.gesture, context);
    }
  }

  paintGesture(gesture, context = this.ctx) {
    if (gesture.style.brush === "texture" && !brushTextureCatalog.get(gesture.style.textureId)) {
      this.requestTextureReplay(gesture.style.textureId);
      return;
    }
    replayBrushPath(context, gesture.points, gesture.style);
  }

  requestTextureReplay(textureId) {
    if (this.pendingTextureReplays.has(textureId)) return;
    this.pendingTextureReplays.add(textureId);
    brushTextureCatalog.ensure(textureId).then(texture => {
      if (!texture) return;
      // A texture may have been absent while appendOperation(), undo(), or
      // restoreState() rebuilt baseCanvas. Rebuild the committed base from the
      // current history index now, then copy that exact history to the working
      // canvas. Re-rendering alone would preserve the skipped base stroke only
      // until the next undo/rebuild.
      this.rebuildBase();
      this.rerender();
    }).finally(() => this.pendingTextureReplays.delete(textureId));
  }

  pointerDown(event, displayCanvas) {
    if (this.isConstructedTool()) {
      this.constructPointerDown(event, displayCanvas);
      return;
    }
    this.pointerId = event.pointerId;
    const rawPoint = this.displayPoint(event);
    const rendererState = { ...this.getRendererState() };
    const style = this.styleSnapshot(this.behavior === "geometric" ? "pen" : this.brushName, this.behavior === "geometric" ? "sine" : "none");
    const current = {
      behavior: this.behavior,
      displayCanvas,
      rendererState,
      geometryContext: displayGeometryContext(rendererState, displayCanvas),
      wedgeSnapRay: null,
      lineAnchor: null,
      straightLine: false,
      displayPoints: [],
      sourcePoints: [],
      style
    };
    const point = this.behavior === "freehand" ? this.snapFreehandPoint(rawPoint, current, event.ctrlKey) : rawPoint;
    current.displayPoints.push(point);
    if (this.behavior === "freehand") current.sourcePoints.push(this.sourcePoint(point, displayCanvas, rendererState));
    current.lineAnchor = { ...point };
    this.currentGesture = current;
    this.lastPoint = point;
    this.rawPoint = { ...point };
    this.smoothedPoint = { ...point };
    this.startContinuousDeposition(current);
  }

  pointerMove(event, displayCanvas) {
    if (this.construction) {
      this.constructPointerMove(event, displayCanvas);
      return;
    }
    if (event.pointerId !== this.pointerId || !this.currentGesture || !this.lastPoint) return;
    const rawPoint = this.displayPoint(event);
    if (this.currentGesture.behavior === "geometric") {
      this.pushBounded(this.currentGesture.displayPoints, rawPoint, 64);
      this.updateGeometricPreview();
    } else {
      const point = this.snapFreehandPoint(rawPoint, this.currentGesture, event.ctrlKey);
      this.rawPoint = { ...rawPoint };
      if (event.shiftKey) {
        this.currentGesture.straightLine = true;
        this.rebuildStraightFreehandLine(point, this.currentGesture);
        this.lastPoint = { ...point };
        this.smoothedPoint = { ...point };
        this.previewGesture = {
          primitive: "freehand",
          points: this.currentGesture.sourcePoints.map(sample => ({ ...sample })),
          style: this.currentGesture.style
        };
        this.rerender();
        return;
      }
      this.currentGesture.straightLine = false;
      // A snapped ray must remain mathematically exact; smoothing an off-ray
      // prior point into it would reintroduce a tiny seam at the boundary.
      const stabilized = this.currentGesture.wedgeSnapRay
        ? { ...point }
        : this.stabilizePoint(point);
      if (this.currentGesture.wedgeSnapRay) this.smoothedPoint = { ...stabilized };
      this.captureFreehandSegment(this.lastPoint, stabilized, displayCanvas, this.currentGesture);
      this.previewGesture = {
        primitive: "freehand",
        points: this.currentGesture.sourcePoints.map(sample => ({ ...sample })),
        style: this.currentGesture.style
      };
      this.rerender();
      this.lastPoint = stabilized;
      return;
    }
    this.lastPoint = rawPoint;
  }

  pointerUp(event) {
    if (this.construction) {
      this.constructPointerUp(event);
      return;
    }
    if (event.pointerId !== this.pointerId || !this.currentGesture) return;
    // Include the final fraction of a hold even when the interval has not
    // ticked again between the last callback and the release event.
    this.depositWhileHeld();
    const current = this.currentGesture;
    let gesture = null;
    if (current.behavior === "geometric") {
      const interpreted = interpretGesture(current.displayPoints, current.geometryContext);
      if (interpreted) gesture = this.generatedGesture(interpreted, current);
    } else if (current.sourcePoints.length) {
      const point = this.snapFreehandPoint(this.displayPoint(event), current, event.ctrlKey);
      if (event.shiftKey) this.rebuildStraightFreehandLine(point, current);
      else this.flushFreehandTo(point, current);
      const candidate = { primitive: "freehand", points: current.sourcePoints.map(point => ({ ...point })), style: current.style };
      if (canReplayBrushPath(candidate.points, candidate.style)) gesture = candidate;
    }
    this.previewGesture = null;
    if (gesture) this.appendOperation({ type: "gesture", gesture });
    else this.rerender();
    this.finishGesture();
  }

  pointerCancel(event) {
    if (this.construction) {
      if (event.pointerId === this.pointerId) this.cancelConstruction();
      return;
    }
    if (event.pointerId !== this.pointerId) return;
    this.previewGesture = null;
    this.rerender();
    this.finishGesture();
  }

  finishGesture() {
    this.stopContinuousDeposition();
    this.pointerId = null;
    this.lastPoint = null;
    this.rawPoint = null;
    this.smoothedPoint = null;
    this.currentGesture = null;
  }

  isConstructedTool() { return Object.prototype.hasOwnProperty.call(CONSTRUCTED_TOOLS, this.brushName); }

  cancelConstruction() {
    if (!this.construction) return false;
    this.construction = null;
    this.previewGesture = null;
    this.pointerId = null;
    this.rerender();
    return true;
  }

  getInteractionGuide() {
    const construction = this.construction;
    if (!construction) return null;
    const tool = CONSTRUCTED_TOOLS[construction.toolName];
    const clone = value => value ? { x: value.x, y: value.y } : null;
    return {
      segments: construction.preview?.points?.map(clone) || [],
      lines: [
        ...(construction.anchors.start && construction.anchors.end ? [{ from: clone(construction.anchors.start), to: clone(construction.anchors.end) }] : []),
        ...tool.handles.flatMap(handle => {
          const anchor = construction.anchors[handle.anchor];
          const control = construction.handles[handle.id];
          return anchor && control ? [{ from: clone(anchor), to: clone(control) }] : [];
        })
      ],
      anchors: Object.entries(construction.anchors).map(([id, value]) => ({ id, point: clone(value) })),
      handles: Object.entries(construction.handles).map(([id, value]) => ({ id, point: clone(value) })),
      activeHandle: construction.activeHandle,
      stage: construction.stage
    };
  }

  constructPointerDown(event, displayCanvas) {
    const displayPoint = this.displayPoint(event);
    this.pointerId = event.pointerId;
    if (!this.construction) {
      const rendererState = { ...this.getRendererState() };
      const tool = CONSTRUCTED_TOOLS[this.brushName];
      this.construction = {
        toolName: this.brushName, displayCanvas, rendererState,
        anchors: { start: displayPoint }, handles: {}, activeHandle: null,
        stage: tool.stages.start, handleIndex: -1, draggingHandle: false, preview: null,
        style: this.styleSnapshot("pen")
      };
      return;
    }
    const construction = this.construction;
    const tool = CONSTRUCTED_TOOLS[construction.toolName];
    if (construction.stage === tool.stages.start) {
      construction.anchors.end = displayPoint;
      construction.handles = tool.initialHandles(construction.anchors);
      construction.handleIndex = 0;
      construction.activeHandle = tool.handles[0]?.id || null;
      construction.stage = tool.stages.end;
      this.updateConstructionPreview();
      return;
    }
    const nearest = this.nearestConstructionHandle(displayPoint, construction);
    construction.draggingHandle = nearest === construction.activeHandle;
    if (construction.draggingHandle) this.moveConstructionHandle(displayPoint);
  }

  constructPointerMove(event) {
    const construction = this.construction;
    if (event.pointerId !== this.pointerId || !construction?.draggingHandle) return;
    this.moveConstructionHandle(this.displayPoint(event));
  }

  constructPointerUp(event) {
    const construction = this.construction;
    if (event.pointerId !== this.pointerId || !construction) return;
    if (construction.draggingHandle) {
      this.moveConstructionHandle(this.displayPoint(event));
      const tool = CONSTRUCTED_TOOLS[construction.toolName];
      const nextHandle = tool.handles[construction.handleIndex + 1];
      if (nextHandle) {
        construction.handleIndex += 1;
        construction.activeHandle = nextHandle.id;
        construction.draggingHandle = false;
        this.pointerId = null;
        return;
      }
      const gesture = tool.ready(construction) ? this.generatedConstructionGesture(construction) : null;
      this.construction = null;
      this.previewGesture = null;
      this.pointerId = null;
      if (gesture) this.appendOperation({ type: "gesture", gesture });
      else this.rerender();
      return;
    }
    this.pointerId = null;
  }

  nearestConstructionHandle(point, construction) {
    const radius = Math.max(12, this.size * 1.5);
    let nearest = null;
    let nearestDistance = radius;
    for (const [id, handle] of Object.entries(construction.handles)) {
      const handleDistance = Math.hypot(handle.x - point.x, handle.y - point.y);
      if (handleDistance <= nearestDistance) { nearest = id; nearestDistance = handleDistance; }
    }
    return nearest;
  }

  moveConstructionHandle(point) {
    const construction = this.construction;
    if (!construction?.activeHandle) return;
    construction.handles[construction.activeHandle] = { ...point };
    this.updateConstructionPreview();
  }

  updateConstructionPreview() {
    const construction = this.construction;
    const tool = construction && CONSTRUCTED_TOOLS[construction.toolName];
    if (!tool?.ready(construction)) return;
    const sampleCount = this.constructedSampleCount(construction);
    construction.preview = tool.buildPreview({ anchors: construction.anchors, handles: construction.handles, sampleCount });
    this.previewGesture = {
      primitive: construction.toolName,
      points: construction.preview.points.map(point => this.sourcePoint(point, construction.displayCanvas, construction.rendererState)),
      style: construction.style
    };
    this.rerender();
  }

  constructedSampleCount(construction) {
    const rect = construction.displayCanvas.getBoundingClientRect();
    const pixelsPerDisplayPixel = Math.max(this.width / Math.max(rect.width, 1), this.height / Math.max(rect.height, 1));
    const spacing = Math.min(2, Math.max(.5, Math.max(construction.style.size * .2, .5) / pixelsPerDisplayPixel));
    const preview = CONSTRUCTED_TOOLS[construction.toolName].buildPreview({ anchors: construction.anchors, handles: construction.handles, sampleCount: 32 });
    let length = 0;
    for (let index = 1; index < preview.points.length; index += 1) length += Math.hypot(preview.points[index].x - preview.points[index - 1].x, preview.points[index].y - preview.points[index - 1].y);
    return Math.min(GENERATED_SAMPLE_CAP, Math.max(2, Math.ceil(length / spacing) + 1));
  }

  generatedConstructionGesture(construction) {
    return {
      primitive: construction.toolName,
      // updateConstructionPreview already mapped these display samples through
      // the frozen state. Reuse that exact replay path on commit.
      points: this.previewGesture.points.map(point => ({ ...point })),
      style: construction.style
    };
  }

  startContinuousDeposition(current) {
    const rate = current.behavior === "freehand" ? CONTINUOUS_BRUSH_RATES[current.style.brush] : 0;
    if (!rate) return;
    current.lastDepositionTime = now();
    current.depositionRemainder = 0;
    this.continuousDepositionTimer = setInterval(() => this.depositWhileHeld(), CONTINUOUS_TICK_MS);
  }

  stopContinuousDeposition() {
    if (this.continuousDepositionTimer !== null) clearInterval(this.continuousDepositionTimer);
    this.continuousDepositionTimer = null;
  }

  depositWhileHeld() {
    const current = this.currentGesture;
    const rate = current?.behavior === "freehand" ? CONTINUOUS_BRUSH_RATES[current.style.brush] : 0;
    if (!rate || !current.sourcePoints.length) return;
    const time = now();
    const elapsed = Math.max(0, time - current.lastDepositionTime);
    current.lastDepositionTime = time;
    const available = current.depositionRemainder + elapsed * rate / 1000;
    const count = Math.floor(available);
    current.depositionRemainder = available - count;
    if (!count) return;
    const point = current.sourcePoints.at(-1);
    point.holdCount = (Number(point.holdCount) || 0) + count;
    this.previewGesture = {
      primitive: "freehand",
      points: current.sourcePoints.map(sample => ({ ...sample })),
      style: current.style
    };
    this.rerender();
  }

  displayPoint(event) {
    return { x: event.clientX, y: event.clientY };
  }

  sourcePoint(point, displayCanvas, rendererState = this.getRendererState()) {
    return screenToSourcePoint(point, displayCanvas, rendererState, this.width, this.height);
  }

  styleSnapshot(brush = this.brushName, taper = "none") {
    return {
      brush, color: this.color, colorMode: this.colorMode,
      startColor: this.gradientStartColor, endColor: this.gradientEndColor,
      size: this.size, opacity: this.opacity,
      lines: this.lines, span: this.span, nibRatio: this.nibRatio,
      density: this.density, particleSize: this.particleSize, taper,
      textureId: this.textureId, spacing: this.textureSpacing, rotationMode: this.textureRotationMode,
      seed: Math.floor(Math.random() * 0x100000000)
    };
  }

  snapFreehandPoint(point, current, snapEnabled) {
    if (!snapEnabled) {
      current.wedgeSnapRay = null;
      return point;
    }
    const context = current.geometryContext;
    const mode = context.symmetryMode;
    if (mode !== "radial" && mode !== "mirrorRadial" && mode !== "spiral") return point;
    if (!current.wedgeSnapRay) {
      const mirrored = mode === "mirrorRadial" || mode === "spiral" || Boolean(context.mirror);
      const step = TAU / Math.max(2, Number(context.segments) || 2) / (mirrored ? 2 : 1);
      const angle = Math.round(Math.atan2(point.y - context.center.y, point.x - context.center.x) / step) * step;
      current.wedgeSnapRay = { x: Math.cos(angle), y: Math.sin(angle) };
    }
    const offsetX = point.x - context.center.x;
    const offsetY = point.y - context.center.y;
    const distanceAlongRay = offsetX * current.wedgeSnapRay.x + offsetY * current.wedgeSnapRay.y;
    return {
      x: context.center.x + current.wedgeSnapRay.x * distanceAlongRay,
      y: context.center.y + current.wedgeSnapRay.y * distanceAlongRay
    };
  }

  stabilizePoint(rawPoint) {
    const previous = this.smoothedPoint || rawPoint;
    const alpha = smoothingAlpha(this.smoothing);
    const stabilized = {
      x: previous.x + (rawPoint.x - previous.x) * alpha,
      y: previous.y + (rawPoint.y - previous.y) * alpha
    };
    this.smoothedPoint = stabilized;
    return stabilized;
  }

  // Shift constrains the entire preview to the direct display-space segment
  // from the pointer-down point. Rebuilding it on each move prevents cursor
  // wiggles (and freehand smoothing) from becoming part of the stored path.
  rebuildStraightFreehandLine(endpoint, current) {
    const heldCount = current.sourcePoints.reduce((total, point) => total + (Number(point.holdCount) || 0), 0);
    const anchor = current.lineAnchor || endpoint;
    current.sourcePoints.splice(0, current.sourcePoints.length, this.sourcePoint(anchor, current.displayCanvas, current.rendererState));
    this.captureFreehandSegment(anchor, endpoint, current.displayCanvas, current);
    if (heldCount) {
      const point = current.sourcePoints.at(-1);
      point.holdCount = (Number(point.holdCount) || 0) + heldCount;
    }
  }

  flushFreehandTo(rawPoint, current) {
    this.rawPoint = { ...rawPoint };
    if (current.wedgeSnapRay) {
      if (Math.hypot(rawPoint.x - this.lastPoint.x, rawPoint.y - this.lastPoint.y) > 0.0001) {
        this.captureFreehandSegment(this.lastPoint, rawPoint, current.displayCanvas, current);
      }
      this.lastPoint = { ...rawPoint };
      this.smoothedPoint = { ...rawPoint };
      return;
    }
    const remaining = Math.hypot(rawPoint.x - this.lastPoint.x, rawPoint.y - this.lastPoint.y);
    const alpha = smoothingAlpha(this.smoothing);
    if (alpha < 1 && remaining > FLUSH_TARGET_DISTANCE) {
      const steps = Math.min(
        MAX_FLUSH_STEPS,
        Math.max(2, Math.ceil(Math.log(FLUSH_TARGET_DISTANCE / remaining) / Math.log(1 - alpha)))
      );
      for (let index = 0; index < steps; index += 1) {
        const stabilized = this.stabilizePoint(rawPoint);
        this.captureFreehandSegment(this.lastPoint, stabilized, current.displayCanvas, current);
        this.lastPoint = stabilized;
      }
    }
    if (Math.hypot(rawPoint.x - this.lastPoint.x, rawPoint.y - this.lastPoint.y) > 0.0001) {
      this.captureFreehandSegment(this.lastPoint, rawPoint, current.displayCanvas, current);
    }
    this.lastPoint = { ...rawPoint };
    this.smoothedPoint = { ...rawPoint };
  }

  pushBounded(points, point, max, { smooth = true } = {}) {
    if (points.length && Math.hypot(points.at(-1).x - point.x, points.at(-1).y - point.y) < 0.25) return;
    points.push({ ...point });
    if (points.length > max) {
      // Display input benefits from smoothing before interpretation. Freehand
      // keeps actual independently-mapped source samples; only its storage
      // density is reduced when it reaches the cap.
      const sampled = smooth ? preprocessGesture(points, max) : Array.from(
        { length: max },
        (_, index) => ({ ...points[Math.round(index * (points.length - 1) / (max - 1))] })
      );
      points.splice(0, points.length, ...sampled);
    }
  }

  updateGeometricPreview() {
    const current = this.currentGesture;
    const interpreted = interpretGesture(current.displayPoints, current.geometryContext);
    this.previewGesture = interpreted ? this.generatedGesture(interpreted, current) : null;
    this.rerender();
  }

  generatedGesture(interpreted, current) {
    const displayPoints = sampleCanonicalGesture(interpreted, this.generatedSampleCount(interpreted, current.displayCanvas, current.style));
    return {
      primitive: interpreted.primitive,
      // Sampling happens before the nonlinear map. A seam/fold can therefore
      // split into stamps without ever being bridged in source space.
      points: displayPoints.map(point => this.sourcePoint(point, current.displayCanvas, current.rendererState)),
      style: current.style,
      orientation: interpreted.orientation,
      handedness: interpreted.handedness
    };
  }

  generatedSampleCount(interpreted, displayCanvas, style) {
    const rect = displayCanvas.getBoundingClientRect();
    const sourcePixelsPerDisplayPixel = Math.max(this.width / Math.max(rect.width, 1), this.height / Math.max(rect.height, 1));
    const displaySpacing = Math.min(2, Math.max(0.5, Math.max(style.size * 0.2, 0.5) / sourcePixelsPerDisplayPixel));
    let length = 0;
    for (let index = 1; index < interpreted.points.length; index += 1) length += Math.hypot(interpreted.points[index].x - interpreted.points[index - 1].x, interpreted.points[index].y - interpreted.points[index - 1].y);
    return Math.min(GENERATED_SAMPLE_CAP, Math.max(interpreted.points.length, Math.ceil(length / displaySpacing) + 1));
  }

  captureFreehandSegment(from, to, displayCanvas, current) {
    const rect = displayCanvas.getBoundingClientRect();
    const sourcePixelsPerDisplayPixel = Math.max(this.width / Math.max(rect.width, 1), this.height / Math.max(rect.height, 1));
    const displaySpacing = Math.min(2, Math.max(0.5, Math.max(current.style.size * 0.2, 0.5) / sourcePixelsPerDisplayPixel));
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const stamps = Math.max(1, Math.ceil(distance / displaySpacing));
    for (let index = 1; index <= stamps; index += 1) {
      const amount = index / stamps;
      const displayPoint = {
        x: from.x + (to.x - from.x) * amount,
        y: from.y + (to.y - from.y) * amount
      };
      this.pushSourceSample(current.sourcePoints, this.sourcePoint(displayPoint, displayCanvas, current.rendererState));
    }
  }

  pushSourceSample(points, point) {
    if (points.length && Math.hypot(points.at(-1).x - point.x, points.at(-1).y - point.y) < 0.25) return;
    points.push({ ...point });
    if (points.length > FREEHAND_SAMPLE_CAP) {
      const reduced = Array.from(
        { length: FREEHAND_SAMPLE_CAP },
        (_, index) => {
          const sample = points[Math.round(index * (points.length - 1) / (FREEHAND_SAMPLE_CAP - 1))];
          const { holdCount, ...coordinates } = sample;
          return coordinates;
        }
      );
      for (let index = 0; index < points.length; index += 1) {
        const count = Number(points[index].holdCount) || 0;
        if (!count) continue;
        const target = Math.round(index * (FREEHAND_SAMPLE_CAP - 1) / (points.length - 1));
        reduced[target].holdCount = (Number(reduced[target].holdCount) || 0) + count;
      }
      points.splice(0, points.length, ...reduced);
    }
  }

}
