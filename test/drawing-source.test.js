import test from "node:test";
import assert from "node:assert/strict";
import { DrawingSource } from "../drawing-source.js";
import { derivePath } from "../drawable-path.js";

class FakeContext2D {
  constructor() { this.calls = []; }
  save() {} restore() {} fillRect() {} clearRect() {} drawImage() {} beginPath() {} arc() {} fill() {} ellipse() {} translate() {} rotate() {}
}
class FakeOffscreenCanvas { constructor(width, height) { this.width = width; this.height = height; this.context = new FakeContext2D(); } getContext() { return this.context; } }
function withSource(run) { const previous = globalThis.OffscreenCanvas; globalThis.OffscreenCanvas = FakeOffscreenCanvas; try { run(); } finally { globalThis.OffscreenCanvas = previous; } }
const drawable = () => ({ kind: "pathStroke", points: [{ x: 10, y: 10 }, { x: 20, y: 20 }], style: { brush: "pen", color: "#fff", colorMode: "solid", size: 4, opacity: 1, taper: "none", seed: 1 } });
const generatedDrawable = () => ({ kind: "generatedStroke", generator: "spirograph", generatorVersion: 1, config: { lobes: 5, penOffset: 1.2, reach: .1, rotation: 0, phase: 0, arms: 1 }, animation: { amount: .5, speed: .15, phase: 0 }, domain: { start: 0, end: Math.PI * 2 }, sampling: { mode: "parameter", step: .01 }, style: drawable().style });

test("commits immutable drawables, keeps previews out of history, and exposes source-only content", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100 });
  source.previewDrawable(drawable());
  assert.equal(source.history.length, 0);
  assert.ok(source.preview);
  assert.equal(source.commitDrawable(drawable()), true);
  assert.equal(source.history.length, 1);
  assert.equal(source.history[0].type, "drawable");
  assert.equal(source.preview, null);
  assert.deepEqual(Object.keys(source.getContentState()).sort(), ["backgroundColor", "history", "historyIndex"]);
}));

test("linear undo/redo, branch, clear, and content restore replay drawable operations", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100 });
  source.commitDrawable(drawable()); source.clear();
  assert.equal(source.canUndo(), true);
  source.undo(); assert.equal(source.canRedo(), true);
  source.commitDrawable(drawable()); assert.equal(source.canRedo(), false);
  const state = source.getContentState();
  const restored = new DrawingSource({ width: 100, height: 100 });
  assert.equal(restored.restoreContentState(state), true);
  assert.deepEqual(restored.getContentState(), state);
  assert.deepEqual(derivePath(drawable()).contours[0].points, drawable().points);
}));

test("content restore rejects drawables with non-finite source coordinates", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100 });
  source.restoreContentState({ history: [{ type: "drawable", drawable: { ...drawable(), points: [{ x: NaN, y: 1 }] } }], historyIndex: 1 });
  assert.equal(source.history.length, 0);
}));

test("time only rerasterizes content with animated drawables", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100 });
  source.commitDrawable(drawable());
  const staticRevision = source.revision;
  assert.equal(source.setTime(1), false);
  assert.equal(source.revision, staticRevision);
  source.commitDrawable(generatedDrawable());
  const animatedRevision = source.revision;
  assert.equal(source.setTime(2), true);
  assert.ok(source.revision > animatedRevision);
}));

test("replaces an applied drawable without adding a history operation", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100 });
  source.commitDrawable(generatedDrawable());
  const changed = generatedDrawable();
  changed.config.lobes = 7;
  assert.equal(source.replaceDrawable(0, changed), true);
  assert.equal(source.history.length, 1);
  assert.equal(source.history[0].drawable.config.lobes, 7);
  assert.equal(source.replaceDrawable(2, changed), false);
}));
