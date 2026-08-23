import test from "node:test";
import assert from "node:assert/strict";
import { DrawingController } from "../drawing-controller.js";

const canvas = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) };
const event = (type, x, y, extra = {}) => ({ type, pointerId: 1, clientX: x, clientY: y, ...extra });
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
