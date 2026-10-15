import test from "node:test";
import assert from "node:assert/strict";
import { DrawingController } from "../drawing-controller.js";
import { renderFiberPath } from "../fiber-brush.js";

const canvas = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) };
const event = (type, x, y, extra = {}) => ({ type, pointerId: 1, clientX: x, clientY: y, ...extra });
class FiberContext {
  constructor() { this.strokes = []; this.path = []; this.globalAlpha = 1; }
  save() {} restore() {} beginPath() { this.path = []; }
  moveTo(x, y) { this.path.push({ x, y }); } lineTo(x, y) { this.path.push({ x, y }); }
  stroke() { this.strokes.push({ path: this.path }); }
}
test("controller stages preview separately then commits a styled path drawable", () => {
  const previews = [], commits = [];
  const source = { width: 100, height: 100, previewDrawable: value => previews.push(value), commitDrawable: value => { commits.push(value); return true; } };
  const controller = new DrawingController({ source, getRendererState: () => ({ symmetryMode: "radial", segments: 4, zoom: 1 }) });
  controller.begin(event("down", 40, 40), canvas);
  controller.move(event("move", 60, 60));
  controller.end(event("up", 70, 70));
  assert.ok(previews.some(Boolean));
  assert.equal(commits.length, 1);
  assert.equal(commits[0].kind, "pathStroke");
  assert.equal(commits[0].geometry.type, "freehand");
  assert.equal(commits[0].material.type, "ink");
});

test("tool and brush settings are independent", () => {
  const source = { width: 100, height: 100, previewDrawable() {}, commitDrawable() { return true; } };
  const controller = new DrawingController({ source });
  controller.setTool("arc"); controller.setBrush("texture");
  assert.equal(controller.settings.tool, "arc");
  assert.equal(controller.settings.brush, "texture");
});

test("Wisp forces freehand and stores fixed-rate duplicate samples without normal reduction", () => {
  const commits = [];
  const source = { width: 100, height: 100, previewDrawable() {}, commitDrawable: drawable => { commits.push(drawable); return true; } };
  const controller = new DrawingController({ source });
  controller.setTool("arc"); controller.setBrush("wisp");
  assert.equal(controller.settings.tool, "freehand");
  controller.begin(event("down", 40, 40), canvas);
  for (let i = 0; i < 700; i += 1) controller.deposit();
  controller.end(event("up", 40, 40));
  assert.equal(commits[0].material.options.version, 2);
  assert.equal(commits[0].material.options.wispUnitsPerPixel, 1, "the frozen Wisp recipe persists source units per display pixel");
  assert.ok(Number.isFinite(commits[0].material.options.wispCenterX) && Number.isFinite(commits[0].material.options.wispCenterY), "the frozen Wisp recipe persists the mapped display center");
  assert.ok(commits[0].gesture.points.length > 512, "Wisp's simulation samples are never decimated");
  assert.deepEqual(commits[0].gesture.points[0], commits[0].gesture.points[1], "a stationary timer tick is a real sample");
});

test("Wisp style snapshots persist the v2 artist controls", () => {
  const source = { width: 100, height: 100, previewDrawable() {}, commitDrawable() { return true; } };
  const controller = new DrawingController({ source });
  controller.setBrush("wisp");
  controller.set("wispEnergy", .8);
  controller.set("wispMomentum", .42);
  controller.set("wispTurbulence", 1.4);
  controller.set("wispPersistence", 240);
  controller.set("wispDensity", 8);
  const style = controller.styleSnapshot();
  assert.equal(style.version, 2);
  assert.deepEqual({ energy: style.energy, momentum: style.momentum, turbulence: style.turbulence, persistence: style.persistence, density: style.density }, {
    energy: .8, momentum: .42, turbulence: 1.4, persistence: 240, density: 8
  });
});

test("Wisp freezes its logical-pixel scale from the gesture mapping", () => {
  const commits = [], wideCanvas = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 100 }) };
  const source = { width: 800, height: 400, previewDrawable() {}, commitDrawable: drawable => { commits.push(drawable); return true; } };
  const controller = new DrawingController({ source, getRendererState: () => ({ zoom: 2 }) });
  controller.setBrush("wisp");
  controller.begin(event("down", 10, 10), wideCanvas);
  controller.deposit();
  controller.end(event("up", 10, 10));
  assert.equal(commits[0].material.options.wispUnitsPerPixel, 2);
});

test("Wisp pointer moves and pointerup never synthesize off-clock samples", () => {
  const previews = [], commits = [];
  const source = { width: 100, height: 100, previewDrawable: value => previews.push(value), commitDrawable: drawable => { commits.push(drawable); return true; } };
  const controller = new DrawingController({ source });
  controller.setBrush("wisp");
  controller.begin(event("down", 10, 10), canvas);
  assert.equal(controller.current.points.length, 0, "pointer-down only records Wisp's current input position");
  controller.move(event("move", 70, 40));
  assert.equal(previews.length, 0, "raw movement only updates Wisp's latest pointer");
  controller.deposit();
  assert.equal(controller.current.points.length, 1, "the fixed clock appends Wisp's first logical sample");
  assert.deepEqual({ x: controller.current.points[0].inputScreenVx, y: controller.current.points[0].inputScreenVy }, { x: 60, y: 30 }, "the durable Wisp sample retains raw display-axis input velocity");
  const lastClockSample = structuredClone(controller.current.points.at(-1));
  controller.end(event("up", 90, 50));
  assert.equal(commits[0].gesture.points.length, 1, "release does not create an off-clock velocity sample");
  assert.deepEqual(commits[0].gesture.points.at(-1), lastClockSample);
});

test("Wisp retains the available pre-drag logical pointer delta for its first clock sample", () => {
  const commits = [];
  const source = { width: 100, height: 100, previewDrawable() {}, commitDrawable: drawable => { commits.push(drawable); return true; } };
  const controller = new DrawingController({ source });
  controller.setBrush("wisp");
  controller.move(event("move", 4, 8));
  controller.begin(event("down", 10, 10), canvas);
  controller.deposit();
  controller.end(event("up", 10, 10));
  assert.deepEqual({ x: commits[0].gesture.points[0].inputScreenVx, y: commits[0].gesture.points[0].inputScreenVy }, { x: 6, y: 2 });
});

test("solid style snapshots do not retain gradient endpoint colors", () => {
  const source = { width: 100, height: 100, previewDrawable() {}, commitDrawable() { return true; } };
  const controller = new DrawingController({ source });
  controller.set("color", "#00aa44");
  controller.set("gradientStartColor", "#ff0000");
  controller.set("gradientEndColor", "#0000ff");
  const style = controller.styleSnapshot();
  assert.equal(style.color, "#00aa44");
  assert.equal(style.startColor, "#00aa44");
  assert.equal(style.endColor, "#00aa44");
});

test("Fiber style snapshots retain every material control used by V2 replay", () => {
  const source = { width: 100, height: 100, previewDrawable() {}, commitDrawable() { return true; } };
  const controller = new DrawingController({ source });
  controller.setBrush("fiber");
  controller.set("assistLevel", .85);
  controller.set("spread", .7);
  controller.set("wispiness", .4);
  controller.set("gravity", -55);
  const style = controller.styleSnapshot();
  assert.equal(style.version, 2);
  assert.equal(style.assistLevel, .85);
  assert.equal(style.spread, .7);
  assert.equal(style.wispiness, .4);
  assert.equal(style.gravity, -55);
});

test("controller-created Fiber strokes treat negative gravity as zero flow attraction", () => {
  const draw = gravity => {
    const commits = [];
    const source = { width: 800, height: 200, previewDrawable() {}, commitDrawable: drawable => { commits.push(drawable); return true; } };
    const controller = new DrawingController({ source });
    controller.setBrush("fiber"); controller.set("gravity", gravity); controller.set("assistLevel", 0); controller.set("branching", 1); controller.set("curl", 0);
    controller.begin(event("down", 5, 100), canvas);
    controller.current.style.seed = 1234;
    controller.end(event("up", 95, 100));
    const context = new FiberContext();
    renderFiberPath(context, commits[0].gesture.points, commits[0].material.options);
    return context.strokes[0].path.at(-1).y;
  };
  assert.equal(draw(-100), draw(0), "controller snapshots do not reintroduce signed world-Y gravity");
});

test("restoring obsolete constructed pseudo-brushes retains a real brush", () => {
  const source = { width: 100, height: 100, previewDrawable() {}, commitDrawable() { return true; } };
  const controller = new DrawingController({ source });
  controller.restoreState({ tool: "freehand", brush: "arc" });
  assert.equal(controller.settings.brush, "pen");
  controller.restoreState({ brush: "texture" });
  assert.equal(controller.settings.brush, "texture");
});

test("cancel is a no-op without an active drawing interaction and freehand storage is capped", () => {
  const source = { width: 100, height: 100, previewDrawable() {}, commitDrawable() { return true; } };
  const controller = new DrawingController({ source });
  assert.equal(controller.cancel(), false);
  const points = Array.from({ length: 700 }, (_, index) => ({ x: index, y: index, holdCount: index === 699 ? 2 : undefined }));
  controller.pushPoint(points, { x: 700, y: 700 });
  assert.equal(points.length, 512);
  assert.ok(points.some(point => point.holdCount), "hold deposition is retained during reduction");
});

test("freehand reduction does not double-count sampled hold deposition", () => {
  const source = { width: 100, height: 100, previewDrawable() {}, commitDrawable() { return true; } };
  const controller = new DrawingController({ source });
  const points = Array.from({ length: 513 }, (_, index) => ({ x: index, y: index, holdCount: index === 512 ? 3 : undefined }));
  controller.pushPoint(points, { x: 513, y: 513 });
  assert.equal(points.reduce((total, point) => total + (point.holdCount || 0), 0), 3);
});

test("freehand preserves its exact sampled recipe through active completion", () => {
  const updates = [], commits = [];
  const source = {
    width: 1000, height: 100,
    beginPaintSession: () => "active",
    updatePaintSession: (_, drawable) => updates.push(drawable),
    finishPaintSession() {}, previewDrawable() {},
    commitDrawable: drawable => commits.push(drawable)
  };
  const controller = new DrawingController({ source });
  controller.begin(event("down", 0, 50), canvas);
  for (let index = 1; index <= 700; index += 1) controller.capture({ x: index - 1, y: 50 }, { x: index, y: 50 }, controller.current);
  assert.ok(controller.current.points.length > 512, "the active paint session never compacts its input prefix");
  controller.end(event("up", 700, 50));
  assert.ok(updates.at(-1).gesture.points.length > 512, "completion commits the exact samples that produced the visible raster");
  assert.equal(commits.length, 0, "the active-session path uses its normal completion seam");
});

test("Ctrl snapping constrains both initial and final freehand samples", () => {
  const commits = [];
  const source = { width: 100, height: 100, previewDrawable() {}, commitDrawable: drawable => { commits.push(drawable); return true; } };
  const controller = new DrawingController({ source, getRendererState: () => ({ symmetryMode: "mirrorRadial", segments: 4, mirror: true, zoom: 1 }) });
  controller.begin(event("down", 55, 30, { ctrlKey: true }), canvas);
  controller.end(event("up", 65, 70, { ctrlKey: true }));
  assert.equal(commits.length, 1);
  assert.ok(commits[0].gesture.points.length >= 2);
});

test("material selection chooses the same brush for deposition, replay, and restored settings", () => {
  const controller = new DrawingController({ source: { width: 100, height: 100 } });
  for (const material of ["spray", "texture", "silk", "ink"]) {
    controller.setMaterial(material);
    const style = controller.styleSnapshot(), drawable = controller.drawable([{ x: 1, y: 2 }], style);
    const expected = ["spray", "texture"].includes(material) ? material : "pen";
    assert.equal(style.brush, expected);
    assert.equal(drawable.geometry.options.brush, expected);
    assert.equal(drawable.material.options.brush, expected);
    const restored = new DrawingController({ source: {} });
    restored.restoreState(controller.getState());
    assert.deepEqual(restored.getState(), controller.getState());
  }
  controller.setBrush("wisp");
  assert.equal(controller.drawable([], controller.styleSnapshot()).geometry.type, "wisp");
});
