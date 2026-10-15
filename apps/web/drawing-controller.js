import { makePaintRecipe } from "./stroke-recipe.js";
import { BRUSHES, canReplayBrushPath } from "./brushes.js";
import { DEFAULT_BRUSH_TEXTURE_ID } from "./brush-textures.js";
import { interpretGesture, preprocessGesture, sampleCanonicalGesture } from "./gesture-interpreter.js";
import { sampleCircularArc, sampleCubicBezier } from "./constructed-strokes.js";
import { displayGeometryContext, screenToSourcePoint, sourceUnitsPerDisplayPixel } from "./drawing-mapping.js";

const TAU = Math.PI * 2, CONTINUOUS = { spray: 30, texture: 12, wisp: 60 };
const TOOLS = new Set(["freehand", "smart", "arc", "bezier"]);
export const DRAWING_GEOMETRIES = ["freehand", "ribbon", "calligraphy", "fiber", "hair", "wisp"];
export const DRAWING_MATERIALS = ["ink", "silk", "spray", "texture"];
// Compatibility export for integrations that still enumerate the old selector.
export const DRAWING_BRUSHES = DRAWING_GEOMETRIES;
const clone = value => structuredClone(value);

export class DrawingController {
  constructor({ source, getRendererState = () => ({}) }) {
    this.source = source; this.getRendererState = getRendererState;
    this.settings = { tool: "freehand", geometry: "freehand", material: "ink", brush: "pen", color: "#ffffff", colorMode: "solid", gradientStartColor: "#ffffff", gradientEndColor: "#ff4da6", size: 8, opacity: .85, lines: 5, span: 24, nibRatio: .22, density: 8, particleSize: 1, textureId: DEFAULT_BRUSH_TEXTURE_ID, textureSpacing: .25, textureRotationMode: "followStroke", assistLevel: .6, fibers: 6, gravity: 42, branching: 13, curl: 12, spread: .5, wispiness: .5, wispEnergy: .5, wispMomentum: .3, wispTurbulence: 1, wispPersistence: 150, wispDensity: 5, smoothing: .35, silkStrands: 10, silkSpread: 16, silkWander: .22, silkGlow: .18 };
    this.current = null; this.construction = null; this.timer = null; this.previewFrame = null;
  }
  getState() { const { brush, ...state } = this.settings; return clone(state); }
  restoreState(settings) {
    if (!settings || typeof settings !== "object") return false;
    for (const [key, value] of Object.entries(settings)) {
      if (!(key in this.settings)) continue;
      if (key === "tool" && !TOOLS.has(value)) continue;
      if (key === "brush" && !BRUSHES[value]) continue;
      if (key === "geometry" && !DRAWING_GEOMETRIES.includes(value)) continue;
      if (key === "material" && !DRAWING_MATERIALS.includes(value)) continue;
      this.settings[key] = value;
    }
    if (!("geometry" in settings) && BRUSHES[settings.brush]) this.setBrush(settings.brush);
    else { this.setGeometry(this.settings.geometry); this.setMaterial(settings.material || this.settings.material); }
    return true;
  }
  setTool(tool) { if (TOOLS.has(tool)) { this.cancel(); this.settings.tool = this.settings.brush === "wisp" ? "freehand" : tool; } }
  setBrush(brush) {
    if (!BRUSHES[brush]) return;
    this.setGeometry(["pen", "spray", "texture"].includes(brush) ? "freehand" : brush);
    this.setMaterial(["spray", "texture"].includes(brush) ? brush : "ink");
  }
  setGeometry(geometry) { if (DRAWING_GEOMETRIES.includes(geometry)) { this.settings.geometry = geometry; if (geometry !== "freehand") this.settings.material = "ink"; this.settings.brush = geometry === "freehand" ? (["spray", "texture"].includes(this.settings.material) ? this.settings.material : "pen") : geometry; if (geometry === "wisp") this.settings.tool = "freehand"; } }
  setMaterial(material) { if (DRAWING_MATERIALS.includes(material) && (this.settings.geometry === "freehand" || material === "ink")) { this.settings.material = material; this.settings.brush = this.settings.geometry === "freehand" ? (["spray", "texture"].includes(material) ? material : "pen") : this.settings.geometry; } }
  set(key, value) { if (key in this.settings) this.settings[key] = value; }
  styleSnapshot() {
    const s = this.settings, gradient = s.colorMode === "gradient";
    // Make a saved style self-consistent. This is deliberately redundant with
    // brush rendering: no solid stroke may inherit stale endpoint swatches.
    const style = { brush: s.brush, version: s.brush === "fiber" || s.brush === "hair" || s.brush === "wisp" ? 2 : undefined, color: s.color, colorMode: s.colorMode, startColor: gradient ? s.gradientStartColor : s.color, endColor: gradient ? s.gradientEndColor : s.color, size: Number(s.size), opacity: Number(s.opacity), lines: Number(s.lines), span: Number(s.span), nibRatio: Number(s.nibRatio), density: Number(s.density), particleSize: Number(s.particleSize), textureId: s.textureId, spacing: Number(s.textureSpacing), rotationMode: s.textureRotationMode, assistLevel: Number(s.assistLevel), fibers: Number(s.fibers), gravity: Number(s.gravity), branching: Number(s.branching), curl: Number(s.curl), spread: Number(s.spread), wispiness: Number(s.wispiness), taper: "none", seed: Math.floor(Math.random() * 0x100000000), geometry: s.geometry, material: s.material, silkStrands: Number(s.silkStrands), silkSpread: Number(s.silkSpread), silkWander: Number(s.silkWander), silkGlow: Number(s.silkGlow) };
    return s.brush === "wisp" ? { ...style, energy: Number(s.wispEnergy), momentum: Number(s.wispMomentum), turbulence: Number(s.wispTurbulence), persistence: Number(s.wispPersistence), density: Number(s.wispDensity) } : style;
  }
  drawable(points, style) { return makePaintRecipe(points, style, { snapshotPoints: false }); }
  point(event) { return { x: event.clientX, y: event.clientY }; }
  map(point, current) { return screenToSourcePoint(point, current.canvas, current.mapping, this.source.width, this.source.height); }
  begin(event, canvas) {
    if (this.settings.tool === "arc" || this.settings.tool === "bezier") return this.constructDown(event, canvas);
    const mapping = { ...this.getRendererState() }, p = this.point(event);
    const current = { pointerId: event.pointerId, canvas, mapping, context: displayGeometryContext(mapping, canvas), anchor: p, last: p, smooth: p, displayPoints: [p], points: [], style: this.styleSnapshot(), heldAt: performance.now(), remainder: 0, wedge: null };
    const constrained = this.interactionPoint(event, current);
    current.anchor = constrained; current.last = constrained; current.smooth = constrained; current.displayPoints = [constrained]; current.wispPreviousInput = this.lastInputPoint || p; current.wispLatestInput = p;
    // Wisp updates its input position on mouse-down, but does not
    // create a particle until the next fixed-rate inputFrame.
    current.points = current.style.brush === "wisp" ? [] : [this.map(constrained, current)];
    if (current.style.brush === "wisp") {
      current.style.wispUnitsPerPixel = sourceUnitsPerDisplayPixel(canvas, mapping, this.source.width, this.source.height);
      const sourceCenter = this.map(current.context.center, current);
      current.style.wispCenterX = sourceCenter.x;
      current.style.wispCenterY = sourceCenter.y;
    }
    // Smart gestures and a Shift-constrained gesture replace their geometry
    // at completion. Keep those preview-only until that final path exists.
    current.deferredPaint = this.settings.tool === "smart" || Boolean(event.shiftKey);
    this.current = current;
    const drawable = this.drawable(current.points, current.style);
    if (!current.deferredPaint && this.source.beginPaintSession) current.paintSessionId = this.source.beginPaintSession(drawable);
    this.startContinuous();
  }
  move(event) {
    this.lastInputPoint = this.point(event);
    if (this.construction) return this.constructMove(event);
    const c = this.current; if (!c || c.pointerId !== event.pointerId) return;
    const p = this.interactionPoint(event, c);
    // Wisp samples only on its fixed 60 Hz clock. Pointer moves merely update
    // the next source-space sample; replaying the full simulation here would
    // create a preview for a frame that was never durably sampled.
    if (c.style.brush === "wisp") { c.last = p; c.wispLatestInput = this.lastInputPoint; return; }
    if (this.settings.tool === "smart") { c.displayPoints.push(p); if (c.displayPoints.length > 64) c.displayPoints = preprocessGesture(c.displayPoints, 64); this.previewSmart(c); c.last = p; return; }
    if (event.shiftKey) { c.points = [this.map(c.anchor, c), this.map(p, c)]; c.last = p; this.preview(c); return; }
    const alpha = 1 - Math.min(1, Math.max(0, Number(this.settings.smoothing) || 0)) * .88;
    const q = c.wedge ? p : { x: c.smooth.x + (p.x - c.smooth.x) * alpha, y: c.smooth.y + (p.y - c.smooth.y) * alpha };
    this.capture(c.last, q, c); c.last = q; c.smooth = q; this.preview(c);
  }
  end(event) {
    if (this.construction) return this.constructUp(event);
    const c = this.current; if (!c || c.pointerId !== event.pointerId) return;
    if (c.style.brush !== "wisp") { this.deposit(); this.flushPreview(c); }
    if (this.settings.tool === "smart") { const gesture = interpretGesture(c.displayPoints, c.context); if (gesture) c.points = sampleCanonicalGesture(gesture, this.count(gesture.points, c)).map(p => this.map(p, c)); }
    else if (c.style.brush === "wisp") {
      // Wisp input is sampled only by the fixed-rate clock. Mouseup completes
      // the gesture without manufacturing an off-clock velocity impulse.
    }
    else if (!event.shiftKey) this.capture(c.last, this.interactionPoint(event, c), c);
    const drawable = this.drawable(c.points, c.style);
    if (c.paintSessionId) { this.source.updatePaintSession(c.paintSessionId, drawable); this.source.finishPaintSession(c.paintSessionId); }
    else {
      this.source.previewDrawable(null);
      if (drawable.gesture.points.length && this.source.beginPaintSession) {
        const id = this.source.beginPaintSession(drawable); if (id) this.source.finishPaintSession(id);
      } else if (drawable.gesture.points.length) this.source.commitDrawable(drawable);
    }
    this.stopContinuous(); this.current = null;
  }
  cancel(event) {
    if (event && this.current?.pointerId !== event.pointerId && this.construction?.pointerId !== event.pointerId) return false;
    const hadInteraction = Boolean(this.current || this.construction); if (!hadInteraction) return false;
    // Immediate paint has no rollback. A cancellation completes the samples
    // already deposited, which also releases the generator-mutation gate.
    if (this.current?.paintSessionId) {
      const c = this.current;
      const drawable = this.drawable(c.points, c.style);
      this.source.updatePaintSession(c.paintSessionId, drawable); this.source.finishPaintSession(c.paintSessionId);
    }
    this.cancelPreviewFrame(); this.current = null; this.construction = null; this.stopContinuous(); this.source.previewDrawable(null); return true;
  }
  isFiberPreview(c) { return ["fiber", "hair", "wisp"].includes(c?.style?.brush); }
  publishPreview(c) {
    if (this.current !== c) return;
    const drawable = this.drawable(c.points, c.style);
    if (c.paintSessionId) this.source.updatePaintSession(c.paintSessionId, drawable);
    else this.source.previewDrawable(drawable);
  }
  preview(c) {
    if (!this.isFiberPreview(c)) return this.publishPreview(c);
    if (this.previewFrame !== null) return;
    const schedule = globalThis.requestAnimationFrame || (callback => setTimeout(() => callback(performance.now()), 16));
    this.previewFrame = schedule(() => { this.previewFrame = null; this.publishPreview(c); });
  }
  flushPreview(c) {
    if (this.previewFrame === null) return;
    this.cancelPreviewFrame(); this.publishPreview(c);
  }
  cancelPreviewFrame() {
    if (this.previewFrame === null) return;
    if (globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame(this.previewFrame); else clearTimeout(this.previewFrame);
    this.previewFrame = null;
  }
  capture(a, b, c) { const rect = c.canvas.getBoundingClientRect(), spp = Math.max(this.source.width / Math.max(rect.width, 1), this.source.height / Math.max(rect.height, 1)), steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / Math.min(2, Math.max(.5, c.style.size * .2 / spp)))); for (let i = 1; i <= steps; i += 1) { const p = this.map({ x: a.x + (b.x - a.x) * i / steps, y: a.y + (b.y - a.y) * i / steps }, c); this.pushPoint(c.points, p, { compact: false }); } }
  pushPoint(points, point, { compact = true } = {}) { if (points.length && Math.hypot(point.x - points.at(-1).x, point.y - points.at(-1).y) < .25) return; points.push({ ...point }); if (compact) this.compactPoints(points); }
  compactPoints(points) { if (points.length <= 512) return; const reduced = Array.from({ length: 512 }, (_, i) => { const source = points[Math.round(i * (points.length - 1) / 511)]; return { x: source.x, y: source.y }; }); for (let i = 0; i < points.length; i += 1) { const held = Number(points[i].holdCount) || 0; if (held) { const target = Math.round(i * 511 / (points.length - 1)); reduced[target].holdCount = (Number(reduced[target].holdCount) || 0) + held; } } points.splice(0, points.length, ...reduced); }
  count(points, c) { const rect = c.canvas.getBoundingClientRect(), spp = Math.max(this.source.width / rect.width, this.source.height / rect.height); let length = 0; for (let i = 1; i < points.length; i += 1) length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y); return Math.min(512, Math.max(points.length, Math.ceil(length / Math.min(2, Math.max(.5, c.style.size * .2 / spp))) + 1)); }
  previewSmart(c) { const gesture = interpretGesture(c.displayPoints, c.context); if (!gesture) return this.source.previewDrawable(null); const points = sampleCanonicalGesture(gesture, this.count(gesture.points, c)).map(p => this.map(p, c)); this.source.previewDrawable(this.drawable(points, c.style)); }
  snapWedge(p, c) { const mode = c.context.symmetryMode; if (!["radial", "mirrorRadial", "spiral"].includes(mode)) return p; if (!c.wedge) { const step = TAU / Math.max(2, Number(c.context.segments) || 2) / ((mode !== "radial" || c.context.mirror) ? 2 : 1), a = Math.round(Math.atan2(p.y - c.context.center.y, p.x - c.context.center.x) / step) * step; c.wedge = { x: Math.cos(a), y: Math.sin(a) }; } const dx = p.x - c.context.center.x, dy = p.y - c.context.center.y, d = dx * c.wedge.x + dy * c.wedge.y; return { x: c.context.center.x + c.wedge.x * d, y: c.context.center.y + c.wedge.y * d }; }
  interactionPoint(event, current) { const point = this.point(event); if (!event.ctrlKey) { current.wedge = null; return point; } return this.snapWedge(point, current); }
  startContinuous() { const rate = CONTINUOUS[this.current?.style.brush]; if (!rate) return; this.timer = setInterval(() => this.deposit(), 1000 / 60); }
  stopContinuous() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  deposit() { const c = this.current, rate = CONTINUOUS[c?.style.brush]; if (!rate || !c) return; if (c.style.brush === "wisp") { const input = c.wispLatestInput || c.last, previous = c.wispPreviousInput || input, point = this.map(c.last, c); point.inputScreenVx = input.x - previous.x; point.inputScreenVy = input.y - previous.y; c.wispPreviousInput = { ...input }; c.points.push(point); this.preview(c); return; } if (!c.points.length) return; const t = performance.now(), available = c.remainder + (t - c.heldAt) * rate / 1000, n = Math.floor(available); c.heldAt = t; c.remainder = available - n; if (n) { const p = c.points.at(-1); p.holdCount = (p.holdCount || 0) + n; this.preview(c); } }
  constructDown(event, canvas) { const p = this.point(event); if (!this.construction) { const mapping = { ...this.getRendererState() }; this.construction = { pointerId: event.pointerId, canvas, mapping, tool: this.settings.tool, anchors: { start: p }, handles: {}, stage: "end", style: this.styleSnapshot() }; return; } const c = this.construction; if (!c.anchors.end) { c.anchors.end = p; c.handles = c.tool === "arc" ? { bend: p } : { startHandle: { x: (c.anchors.start.x * 2 + p.x) / 3, y: (c.anchors.start.y * 2 + p.y) / 3 }, endHandle: { x: (c.anchors.start.x + p.x * 2) / 3, y: (c.anchors.start.y + p.y * 2) / 3 } }; c.active = Object.keys(c.handles)[0]; c.dragging = false; this.updateConstruction(c); return; } c.pointerId = event.pointerId; c.dragging = true; }
  constructMove(event) { const c = this.construction; if (!c?.dragging || c.pointerId !== event.pointerId) return; c.handles[c.active] = this.point(event); this.updateConstruction(c); }
  constructUp(event) { const c = this.construction; if (!c || c.pointerId !== event.pointerId) return; if (!c.dragging) return; c.handles[c.active] = this.point(event); const keys = Object.keys(c.handles), next = keys[keys.indexOf(c.active) + 1]; if (next) { c.active = next; c.dragging = false; c.pointerId = null; this.updateConstruction(c); return; } const drawable = this.constructDrawable(c); this.source.previewDrawable(null); if (drawable && this.source.beginPaintSession) { const id = this.source.beginPaintSession(drawable); if (id) this.source.finishPaintSession(id); } else if (drawable) this.source.commitDrawable(drawable); this.construction = null; }
  constructDrawable(c) { const sampled = c.tool === "arc" ? sampleCircularArc(c.anchors.start, c.anchors.end, c.handles.bend, { sampleCount: 96 }) : sampleCubicBezier(c.anchors.start, c.anchors.end, c.handles.startHandle, c.handles.endHandle, { sampleCount: 96 }); return this.drawable(sampled.points.map(p => this.map(p, c)), c.style); }
  updateConstruction(c) { const drawable = this.constructDrawable(c); this.source.previewDrawable(drawable); c.preview = drawable; }
  getInteractionGuide() { const c = this.construction; if (!c) return null; const lines = c.anchors.end ? [{ from: c.anchors.start, to: c.anchors.end }] : []; for (const [id, p] of Object.entries(c.handles)) lines.push({ from: id === "endHandle" ? c.anchors.end : c.anchors.start, to: p }); const segments = c.anchors.end ? (c.tool === "arc" ? sampleCircularArc(c.anchors.start, c.anchors.end, c.handles.bend, { sampleCount: 48 }) : sampleCubicBezier(c.anchors.start, c.anchors.end, c.handles.startHandle, c.handles.endHandle, { sampleCount: 48 })).points : []; return { segments, lines, anchors: Object.entries(c.anchors).map(([id, point]) => ({ id, point })), handles: Object.entries(c.handles).map(([id, point]) => ({ id, point })), activeHandle: c.active, stage: c.stage }; }
}
