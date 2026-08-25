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
  assert.equal(commits[0].style.brush, "pen");
});

test("tool and brush settings are independent", () => {
  const source = { width: 100, height: 100, previewDrawable() {}, commitDrawable() { return true; } };
  const controller = new DrawingController({ source });
  controller.setTool("arc"); controller.setBrush("texture");
  assert.equal(controller.settings.tool, "arc");
  assert.equal(controller.settings.brush, "texture");
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
    renderFiberPath(context, commits[0].points, commits[0].style);
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

test("Ctrl snapping constrains both initial and final freehand samples", () => {
  const commits = [];
  const source = { width: 100, height: 100, previewDrawable() {}, commitDrawable: drawable => { commits.push(drawable); return true; } };
  const controller = new DrawingController({ source, getRendererState: () => ({ symmetryMode: "mirrorRadial", segments: 4, mirror: true, zoom: 1 }) });
  controller.begin(event("down", 55, 30, { ctrlKey: true }), canvas);
  controller.end(event("up", 65, 70, { ctrlKey: true }));
  assert.equal(commits.length, 1);
  assert.ok(commits[0].points.length >= 2);
});
