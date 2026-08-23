import test from "node:test";
import assert from "node:assert/strict";
import { DrawingSource, displayGeometryContext, rotateForRenderer, smoothingAlpha } from "../drawing-source.js";
import { DEFAULT_BRUSH_TEXTURE_ID, brushTextureCatalog } from "../brush-textures.js";

class FakeContext2D {
  constructor() { this.calls = []; }
  save() { this.calls.push(["save"]); }
  restore() { this.calls.push(["restore"]); }
  fillRect(...args) { this.calls.push(["fillRect", ...args]); }
  clearRect(...args) { this.calls.push(["clearRect", ...args]); }
  drawImage(...args) { this.calls.push(["drawImage", ...args]); }
  beginPath() { this.calls.push(["beginPath"]); }
  arc(...args) { this.calls.push(["arc", ...args]); }
  fill() { this.calls.push(["fill"]); }
  ellipse(...args) { this.calls.push(["ellipse", ...args]); }
  translate(...args) { this.calls.push(["translate", ...args]); }
  rotate(...args) { this.calls.push(["rotate", ...args]); }
}

class FakeOffscreenCanvas {
  constructor(width, height) { this.width = width; this.height = height; this.context = new FakeContext2D(); }
  getContext(kind) { return kind === "2d" ? this.context : null; }
}

const displayCanvas = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) };
const state = {
  symmetryMode: "radial", segments: 4, mirror: false, twist: 0,
  rotationRad: 0, zoom: 1, panX: 0, panY: 0, centerX: 0.5, centerY: 0.5,
  wallpaperMode: "single"
};
const event = (pointerId, clientX, clientY, modifiers = {}) => ({ pointerId, clientX, clientY, ...modifiers });

function withSource(run) {
  const previous = globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas = FakeOffscreenCanvas;
  try { run(); } finally { globalThis.OffscreenCanvas = previous; }
}

async function withSourceAsync(run) {
  const previous = globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas = FakeOffscreenCanvas;
  try { await run(); } finally { globalThis.OffscreenCanvas = previous; }
}

test("uses one frozen renderer mapping and commits one generated operation", () => withSource(() => {
  let reads = 0;
  const source = new DrawingSource({ width: 100, height: 100, getRendererState: () => ({ ...state, panX: reads++ }) });
  source.setBehavior("geometric");
  source.pointerDown(event(1, 10, 50), displayCanvas);
  source.pointerMove(event(1, 55, 50), displayCanvas);
  source.pointerMove(event(1, 90, 50), displayCanvas);
  assert.equal(reads, 1, "moves must not sample changing renderer state");
  assert.equal(source.history.length, 0, "preview is not a committed operation");
  assert.ok(source.previewGesture);
  const previewRevision = source.revision;
  source.pointerUp(event(1, 90, 50));
  assert.equal(source.history.length, 1);
  assert.equal(source.historyIndex, 1);
  assert.equal(source.history[0].type, "gesture");
  assert.equal(source.history[0].gesture.primitive, "arc");
  assert.equal(source.history[0].gesture.style.taper, "sine");
  assert.ok(source.history[0].gesture.points.length > 24, "generated curves are densely sampled before mapping");
  assert.ok(source.history[0].gesture.points.length <= 512);
  assert.equal(source.previewGesture, null);
  assert.equal(source.revision, previewRevision + 1, "commit rerenders exactly once");
}));

test("cancel discards a geometric preview without creating history", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100, getRendererState: () => state });
  source.setBehavior("geometric");
  source.pointerDown(event(1, 10, 50), displayCanvas);
  source.pointerMove(event(1, 90, 50), displayCanvas);
  assert.ok(source.previewGesture);
  const revision = source.revision;
  source.pointerCancel(event(1, 90, 50));
  assert.equal(source.history.length, 0);
  assert.equal(source.previewGesture, null);
  assert.equal(source.revision, revision + 1);
}));

test("Arc uses staged anchors and a draggable handle with one frozen replay path", () => withSource(() => {
  let reads = 0;
  const source = new DrawingSource({ width: 100, height: 100, getRendererState: () => ({ ...state, panX: reads++ }) });
  source.setBrush("arc");
  source.pointerDown(event(1, 10, 50), displayCanvas);
  source.pointerUp(event(1, 10, 50));
  source.pointerDown(event(2, 90, 50), displayCanvas);
  source.pointerUp(event(2, 90, 50));
  const guide = source.getInteractionGuide();
  assert.equal(reads, 1, "the mapping is captured at the first anchor only");
  assert.equal(source.history.length, 0, "the preview does not append history");
  assert.equal(guide.stage, "handle");
  assert.equal(guide.anchors.length, 2);
  assert.equal(guide.handles.length, 1);
  assert.ok(guide.segments.length > 2);
  const handle = guide.handles[0].point;
  source.pointerDown(event(3, handle.x, handle.y), displayCanvas);
  source.pointerMove(event(3, 50, 10), displayCanvas);
  source.pointerUp(event(3, 50, 10));
  assert.equal(source.history.length, 1);
  assert.equal(source.history[0].gesture.primitive, "arc");
  assert.equal(source.history[0].gesture.style.brush, "pen");
  assert.ok(source.history[0].gesture.points.length > 20);
  assert.equal(source.getInteractionGuide(), null);
  assert.equal(reads, 1);
  assert.equal(source.undo(), true);
  assert.equal(source.redo(), true);
}));

test("Arc cancellation discards generic construction state without painting", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100, getRendererState: () => state });
  source.setBrush("arc");
  source.pointerDown(event(1, 10, 10), displayCanvas);
  source.pointerUp(event(1, 10, 10));
  source.pointerDown(event(2, 90, 10), displayCanvas);
  source.pointerUp(event(2, 90, 10));
  assert.ok(source.getInteractionGuide());
  assert.equal(source.cancelConstruction(), true);
  assert.equal(source.history.length, 0);
  assert.equal(source.previewGesture, null);
  assert.equal(source.getInteractionGuide(), null);
}));

test("Bézier stages its two control handles before committing a pen replay", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100, getRendererState: () => state });
  source.setBrush("bezier");
  source.pointerDown(event(1, 10, 50), displayCanvas);
  source.pointerUp(event(1, 10, 50));
  source.pointerDown(event(2, 90, 50), displayCanvas);
  source.pointerUp(event(2, 90, 50));
  let guide = source.getInteractionGuide();
  assert.equal(guide.handles.length, 2);
  assert.equal(guide.activeHandle, "startHandle");
  assert.equal(guide.lines.length, 3, "the generic guide includes chord and control lines");
  const first = guide.handles.find(handle => handle.id === "startHandle").point;
  source.pointerDown(event(3, first.x, first.y), displayCanvas);
  source.pointerMove(event(3, 20, 10), displayCanvas);
  source.pointerUp(event(3, 20, 10));
  guide = source.getInteractionGuide();
  assert.equal(source.history.length, 0);
  assert.equal(guide.activeHandle, "endHandle");
  const second = guide.handles.find(handle => handle.id === "endHandle").point;
  source.pointerDown(event(4, second.x, second.y), displayCanvas);
  source.pointerMove(event(4, 80, 10), displayCanvas);
  source.pointerUp(event(4, 80, 10));
  assert.equal(source.history.length, 1);
  assert.equal(source.history[0].gesture.primitive, "bezier");
  assert.equal(source.history[0].gesture.style.brush, "pen");
  assert.equal(source.getInteractionGuide(), null);
}));

test("history branches after undo and Clear is itself undoable", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100, getRendererState: () => state });
  source.setBehavior("geometric");
  for (const [id, y] of [[1, 20], [2, 40]]) {
    source.pointerDown(event(id, 10, y), displayCanvas);
    source.pointerMove(event(id, 90, y), displayCanvas);
    source.pointerUp(event(id, 90, y));
  }
  assert.equal(source.historyIndex, 2);
  source.undo();
  assert.equal(source.historyIndex, 1);
  assert.equal(source.canRedo(), true);
  source.redo();
  assert.equal(source.historyIndex, 2);
  source.undo();
  source.clear();
  assert.equal(source.history.length, 2, "new operation truncates the redo branch");
  assert.equal(source.history.at(-1).type, "clear");
  source.undo();
  assert.equal(source.historyIndex, 1);
  assert.equal(source.canUndo(), true);
  assert.equal(source.canRedo(), true);
}));

test("freehand stores bounded mapped points and replays its selected brush", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100, getRendererState: () => state });
  source.setBehavior("freehand");
  source.setBrush("ribbon");
  source.pointerDown(event(1, 10, 10), displayCanvas);
  source.pointerMove(event(1, 90, 10), displayCanvas);
  assert.ok(source.previewGesture.points.length > 2, "one fast move is captured as seam-safe mapped stamps");
  for (let index = 1; index <= 160; index += 1) source.pointerMove(event(1, 10 + index / 2, 10 + index / 2), displayCanvas);
  source.pointerUp(event(1, 90, 90));
  const gesture = source.history[0].gesture;
  assert.equal(gesture.primitive, "freehand");
  assert.equal(gesture.style.brush, "ribbon");
  assert.equal(gesture.style.taper, "none");
  assert.ok(gesture.points.length <= 512);
  assert.equal(source.revision > 0, true);
}));

test("uses frozen display geometry context and clamps brush settings", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100, getRendererState: () => state });
  const context = displayGeometryContext({ ...state, centerX: .25, centerY: .75 }, {
    getBoundingClientRect: () => ({ left: 20, top: 30, width: 200, height: 80 })
  });
  assert.deepEqual(context.center, { x: 70, y: 50 });
  source.setSize(999); source.setOpacity(-1); source.setLines(100); source.setSpan(-1);
  source.setNibRatio(99); source.setDensity(0); source.setParticleSize(99);
  assert.deepEqual([source.size, source.opacity, source.lines, source.span, source.nibRatio, source.density, source.particleSize], [100, 0, 20, 0, 1, 1, 10]);
}));

test("gesture style snapshots retain the selected solid or gradient colors", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100, getRendererState: () => state });
  source.setColor("#112233");
  source.setColorMode("gradient");
  source.setGradientStartColor("#ff0000");
  source.setGradientEndColor("#0000ff");
  const gradient = source.styleSnapshot();
  assert.deepEqual(
    { color: gradient.color, colorMode: gradient.colorMode, start: gradient.startColor, end: gradient.endColor },
    { color: "#112233", colorMode: "gradient", start: "#ff0000", end: "#0000ff" }
  );
  source.setColorMode("solid");
  assert.equal(source.styleSnapshot().colorMode, "solid");

  source.setColorMode("gradient");
  source.setBrush("texture");
  assert.equal(source.styleSnapshot().colorMode, "gradient", "texture preserves the existing gradient color mode");
}));

test("serializes drawing settings and replayable history without canvas snapshots", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100, getRendererState: () => state });
  const backgroundRevision = source.revision;
  assert.equal(source.setBackgroundColor("#102030"), true);
  assert.equal(source.revision, backgroundRevision + 1, "changing the background repaints the source frame");
  assert.equal(source.setBackgroundColor("#102030"), false, "reselecting the same color does not create a redundant frame");
  source.setBrush("texture");
  source.setColorMode("gradient");
  source.setTextureSpacing(.5);
  source.setTextureRotationMode("fixed");
  source.appendOperation({ type: "gesture", gesture: {
    primitive: "freehand", points: [{ x: 20, y: 20 }], style: source.styleSnapshot("pen")
  }});
  const saved = source.getState();
  assert.equal("canvas" in saved, false);
  const restored = new DrawingSource({ width: 100, height: 100, getRendererState: () => state });
  assert.equal(restored.restoreState(saved), true);
  assert.equal(restored.brushName, "texture");
  assert.equal(restored.backgroundColor, "#102030");
  assert.equal(restored.colorMode, "gradient");
  assert.equal(restored.textureSpacing, .5);
  assert.equal(restored.textureRotationMode, "fixed");
  assert.equal(restored.history.length, 1);
}));

test("freehand only commits click gestures for brushes that can replay them", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100, getRendererState: () => state });
  source.setBehavior("freehand");
  for (const brush of ["ribbon", "calligraphy"]) {
    source.setBrush(brush);
    source.pointerDown(event(1, 50, 50), displayCanvas);
    source.pointerUp(event(1, 50, 50));
    assert.equal(source.history.length, 0, `${brush} click has no replayable direction`);
  }
  for (const brush of ["pen", "spray"]) {
    source.setBrush(brush);
    source.pointerDown(event(1, 50, 50), displayCanvas);
    source.pointerUp(event(1, 50, 50));
    assert.equal(source.history.length, brush === "pen" ? 1 : 2, `${brush} preserves its immediate click mark`);
  }
}));

test("freehand Spray stores timed hold emissions in its committed replay path", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100, getRendererState: () => state });
  source.setBehavior("freehand");
  source.setBrush("spray");
  source.pointerDown(event(1, 50, 50), displayCanvas);
  source.currentGesture.lastDepositionTime -= 1000;
  source.depositWhileHeld();
  assert.ok(source.previewGesture, "holding updates the live preview before release");
  assert.ok(source.currentGesture.sourcePoints[0].holdCount >= 29, "a one-second hold records repeated spray emissions");
  source.pointerUp(event(1, 50, 50));
  assert.ok(source.history[0].gesture.points[0].holdCount >= 29);
  assert.equal(source.continuousDepositionTimer, null, "release stops the deposition timer");
}));

test("freehand move rebuilds its preview exactly once after capturing samples", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100, getRendererState: () => state });
  source.setBehavior("freehand");
  source.pointerDown(event(1, 10, 10), displayCanvas);
  let rerenders = 0;
  const originalRerender = source.rerender.bind(source);
  source.rerender = () => { rerenders += 1; originalRerender(); };
  source.pointerMove(event(1, 90, 10), displayCanvas);
  assert.equal(rerenders, 1);
  assert.ok(source.previewGesture.points.length > 1);
}));

test("live previews copy the committed base without replaying drawing history", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100, getRendererState: () => state });
  const gesture = {
    primitive: "freehand",
    points: [{ x: 10, y: 10 }, { x: 20, y: 10 }],
    style: source.styleSnapshot("pen")
  };
  source.appendOperation({ type: "gesture", gesture });
  source.appendOperation({ type: "gesture", gesture });
  source.previewGesture = gesture;
  let historyPaints = 0;
  const originalPaintOperation = source.paintOperation.bind(source);
  source.paintOperation = (...args) => { historyPaints += 1; return originalPaintOperation(...args); };
  source.rerender();
  assert.equal(historyPaints, 0, "preview rerender copies base pixels instead of replaying operations");
  assert.ok(source.ctx.calls.some(([name]) => name === "drawImage"));

  source.undo();
  assert.equal(historyPaints, 1, "undo rebuilds only the remaining committed history into the base");
}));

test("late texture loading rebuilds the committed gradient history after undo", async () => withSourceAsync(async () => {
  const originalGet = brushTextureCatalog.get;
  const originalEnsure = brushTextureCatalog.ensure;
  const originalTintedTip = brushTextureCatalog.getTintedTip;
  let loaded = false;
  let resolveTexture;
  const colors = [];
  const texture = { width: 16, height: 8 };
  brushTextureCatalog.get = id => loaded && id === DEFAULT_BRUSH_TEXTURE_ID ? texture : null;
  brushTextureCatalog.ensure = id => new Promise(resolve => { resolveTexture = () => { loaded = true; resolve(id === DEFAULT_BRUSH_TEXTURE_ID ? texture : null); }; });
  brushTextureCatalog.getTintedTip = (_id, color) => { colors.push(color); return texture; };
  try {
    const source = new DrawingSource({ width: 100, height: 100, getRendererState: () => state });
    source.setBrush("texture");
    source.setColorMode("gradient");
    source.setGradientStartColor("#ff0000");
    source.setGradientEndColor("#0000ff");
    source.appendOperation({ type: "gesture", gesture: {
      primitive: "freehand", points: [{ x: 10, y: 10 }, { x: 50, y: 10 }], style: source.styleSnapshot()
    }});
    source.appendOperation({ type: "gesture", gesture: {
      primitive: "freehand", points: [{ x: 20, y: 40 }], style: source.styleSnapshot("pen")
    }});
    source.undo();
    assert.equal(source.historyIndex, 1);
    resolveTexture();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(colors[0], "#ff0000", "the rebuilt stroke begins with its saved gradient start");
    assert.equal(colors.at(-1), "#0000ff", "the rebuilt stroke reaches its saved gradient end");
    assert.ok(source.baseCtx.calls.some(([name]) => name === "rotate"), "the loaded texture is replayed into baseCanvas, not only the working canvas");
  } finally {
    brushTextureCatalog.get = originalGet;
    brushTextureCatalog.ensure = originalEnsure;
    brushTextureCatalog.getTintedTip = originalTintedTip;
  }
}));

test("freehand smoothing stabilizes in display space and flushes to the release point", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100, getRendererState: () => state });
  assert.equal(source.behavior, "freehand");
  assert.equal(source.smoothing, .35);
  assert.equal(smoothingAlpha(0), 1);
  assert.equal(smoothingAlpha(1), .12);

  source.setSmoothing(.5);
  source.pointerDown(event(1, 10, 50), displayCanvas);
  source.pointerMove(event(1, 90, 50), displayCanvas);
  assert.equal(source.lastPoint.x, 10 + 80 * smoothingAlpha(.5), "the virtual brush lags the raw pointer");
  source.pointerUp(event(1, 90, 50));

  const committed = source.history.at(-1).gesture.points;
  const releasePoint = source.sourcePoint({ x: 90, y: 50 }, displayCanvas, state);
  assert.ok(Math.hypot(committed.at(-1).x - releasePoint.x, committed.at(-1).y - releasePoint.y) < 1e-10, "flush keeps the final endpoint literal");
}));

test("zero smoothing preserves literal display-space freehand input", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100, getRendererState: () => state });
  source.setSmoothing(0);
  source.pointerDown(event(1, 10, 50), displayCanvas);
  source.pointerMove(event(1, 90, 50), displayCanvas);
  assert.deepEqual(source.lastPoint, { x: 90, y: 50 });
}));

test("Shift redraws a freehand brush stroke as one straight pointer-down line", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100, getRendererState: () => state });
  // Keep this test focused on display-space constraint behavior; the real
  // mapping remains covered separately and is nonlinear under symmetry.
  source.sourcePoint = point => ({ ...point });
  source.setSmoothing(1);
  source.pointerDown(event(1, 10, 10), displayCanvas);
  source.pointerMove(event(1, 60, 80, { shiftKey: true }), displayCanvas);
  source.pointerMove(event(1, 90, 20, { shiftKey: true }), displayCanvas);
  source.pointerUp(event(1, 90, 20, { shiftKey: true }));

  const points = source.history[0].gesture.points;
  assert.deepEqual(points[0], { x: 10, y: 10 });
  assert.deepEqual(points.at(-1), { x: 90, y: 20 });
  assert.ok(points.every(point => Math.abs((point.y - 10) * 80 - (point.x - 10) * 10) < 1e-10));
}));

test("Ctrl locks freehand input to a frozen local wedge boundary", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100, getRendererState: () => ({ ...state, symmetryMode: "mirrorRadial", segments: 4, mirror: true }) });
  source.pointerDown(event(1, 80, 57, { ctrlKey: true }), displayCanvas);
  source.pointerMove(event(1, 90, 70, { ctrlKey: true }), displayCanvas);
  assert.ok(Math.abs(source.lastPoint.y - 50) < 1e-10, "the pointer projects to the selected horizontal wedge ray");
  source.pointerUp(event(1, 90, 70, { ctrlKey: true }));
  const points = source.history[0].gesture.points;
  const canonicalAngle = Math.atan2(points[0].y - 50, points[0].x - 50);
  assert.ok(points.every(point => Math.abs(Math.atan2(point.y - 50, point.x - 50) - canonicalAngle) < 1e-10), "stored source samples stay on one exact canonical wedge ray");
}));

test("CPU rotation matches the renderer's column-major GLSL rotation direction", () => withSource(() => {
  const clockwise = rotateForRenderer({ x: 1, y: 0 }, Math.PI / 2);
  assert.ok(Math.abs(clockwise.x) < 1e-12);
  assert.ok(Math.abs(clockwise.y + 1) < 1e-12);

  const source = new DrawingSource({ width: 100, height: 100, getRendererState: () => state });
  const rightOfCenter = { x: 75, y: 50 };
  const plusThirty = source.sourcePoint(rightOfCenter, displayCanvas, { ...state, rotationRad: Math.PI / 6 });
  const minusThirty = source.sourcePoint(rightOfCenter, displayCanvas, { ...state, rotationRad: -Math.PI / 6 });
  assert.ok(Math.abs(plusThirty.x - (50 + 25 * Math.cos(Math.PI / 6))) < 1e-10);
  assert.ok(Math.abs(plusThirty.y - (50 + 25 * Math.sin(Math.PI / 6))) < 1e-10);
  assert.ok(Math.abs(minusThirty.x - (50 + 25 * Math.cos(Math.PI / 6))) < 1e-10);
  assert.ok(Math.abs(minusThirty.y - (50 - 25 * Math.sin(Math.PI / 6))) < 1e-10);
}));

test("local p4 rotation reuses the renderer-parity rotation helper", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100, getRendererState: () => state });
  const mapped = source.sourcePoint({ x: 75, y: 50 }, displayCanvas, {
    ...state, symmetryMode: "p4", segments: 8, mirror: true
  });
  const angle = Math.PI * 3 / 8;
  assert.ok(Math.abs(mapped.x - (50 + 25 * Math.cos(angle))) < 1e-10);
  assert.ok(Math.abs(mapped.y - (50 + 25 * Math.sin(angle))) < 1e-10);
}));
