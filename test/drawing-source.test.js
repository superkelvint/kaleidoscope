import test from "node:test";
import assert from "node:assert/strict";
import { DrawingSource } from "../drawing-source.js";
import { derivePath } from "../drawable-path.js";

class FakeContext2D {
  constructor() { this.calls = []; }
  set globalCompositeOperation(value) { this.calls.push(["globalCompositeOperation", value]); }
  save() { this.calls.push(["save"]); } restore() { this.calls.push(["restore"]); }
  fillRect(...args) { this.calls.push(["fillRect", ...args]); } clearRect(...args) { this.calls.push(["clearRect", ...args]); }
  drawImage(...args) { this.calls.push(["drawImage", ...args]); } beginPath() { this.calls.push(["beginPath"]); }
  moveTo(...args) { this.calls.push(["moveTo", ...args]); } lineTo(...args) { this.calls.push(["lineTo", ...args]); }
  closePath() { this.calls.push(["closePath"]); } stroke() { this.calls.push(["stroke"]); }
  arc(...args) { this.calls.push(["arc", ...args]); } fill() { this.calls.push(["fill"]); }
  ellipse(...args) { this.calls.push(["ellipse", ...args]); } translate(...args) { this.calls.push(["translate", ...args]); } rotate(...args) { this.calls.push(["rotate", ...args]); }
}
class FakeOffscreenCanvas { constructor(width, height) { this.width = width; this.height = height; this.context = new FakeContext2D(); } getContext() { return this.context; } }
function withSource(run) { const previous = globalThis.OffscreenCanvas; globalThis.OffscreenCanvas = FakeOffscreenCanvas; try { run(); } finally { globalThis.OffscreenCanvas = previous; } }
const drawable = () => ({ kind: "pathStroke", points: [{ x: 10, y: 10 }, { x: 20, y: 20 }], style: { brush: "pen", color: "#fff", colorMode: "solid", size: 4, opacity: 1, taper: "none", seed: 1 } });
const fiberDrawable = (offset = 0) => ({
  kind: "pathStroke", points: [{ x: 20, y: 50 + offset }, { x: 220, y: 50 + offset }],
  style: { ...drawable().style, brush: "fiber", version: 2, size: 8, seed: 37, fibers: .5, gravity: 42, branching: 13, curl: 12, spread: .5, wispiness: .5, assistLevel: .55 }
});
const generatedDrawable = () => ({ kind: "generatedStroke", generator: "spirograph", generatorVersion: 2, config: { lobes: 5, penOffset: 1.2, reach: .1, rotation: 0, phase: 0, arms: 1 }, animation: { amount: .5, speed: .15, phase: 0 }, domain: { start: 0, end: Math.PI * 2 }, sampling: { mode: "parameter", step: .01 }, style: drawable().style });
const animatedRosette = () => ({ kind: "generatedStroke", generator: "guillocheRosette", generatorVersion: 2, config: { petals: 8, secondaryFrequency: 13, primaryAmplitude: .08, secondaryAmplitude: .035, baseRadius: .2, rotation: 0, lineCount: 2, lineSpacing: .006, phaseOffset: 0 }, animation: { amount: .5, speed: .15, targets: { phaseOffset: true, secondaryAmplitude: false, secondaryFrequency: false, rotation: false } }, domain: { start: 0, end: Math.PI * 2 }, sampling: { mode: "parameter", step: .01 }, style: drawable().style });

test("commits immutable drawables, keeps previews out of history, and exposes source-only content", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100 });
  source.previewDrawable(drawable());
  assert.equal(source.operationCount, 0);
  assert.ok(source.preview);
  const id = source.commitDrawable(drawable());
  assert.equal(typeof id, "string");
  assert.equal(source.operationCount, 1);
  assert.deepEqual(source.getDrawable(id), drawable());
  assert.equal(source.preview, null);
  assert.deepEqual(Object.keys(source.getContentState()).sort(), ["backgroundColor", "operations", "version"]);
  assert.deepEqual(source.getFrame().world, { origin: { x: 0, y: 0 }, extent: { width: 100, height: 100 }, scale: { width: 100, height: 100 }, wrap: "repeat" });
}));

test("clear destructively resets drawing history and persisted content", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100 });
  const bounds = source.materialBounds;
  const fiber = { ...drawable(), points: Array.from({ length: 512 }, (_, index) => ({ x: index, y: index % 80 })), style: { ...drawable().style, brush: "fiber", version: 2, fibers: 6, gravity: 42, branching: 13, curl: 12, spread: .5, wispiness: .5, assistLevel: .6 } };
  source.commitDrawable(fiber);
  source.clear();
  assert.equal(source.canUndo(), false);
  assert.deepEqual(source.getContentState().operations, []);
  assert.deepEqual(source.materialBounds, bounds, "clear never changes the repeat period");
}));

test("a static append paints only the new operation into an existing cached tile", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100 });
  const a = drawable(), b = { ...drawable(), points: [{ x: 25, y: 25 }, { x: 35, y: 35 }] }, c = { ...drawable(), points: [{ x: 40, y: 40 }, { x: 50, y: 50 }] };
  source.commitDrawable(a); source.commitDrawable(b); source.tile(0, 0);
  const painted = [], paint = source.paintCachedOperation.bind(source);
  let rebuilds = 0;
  source.paintCachedOperation = (operation, ...args) => { painted.push(operation); return paint(operation, ...args); };
  const rebuild = source.rebuildTile.bind(source);
  source.rebuildTile = (...args) => { rebuilds += 1; return rebuild(...args); };
  source.commitDrawable(c);
  assert.deepEqual(painted.map(operation => operation.drawable), [c], "only the appended drawable is rasterized");
  assert.equal(rebuilds, 0, "ordinary append never rebuilds an existing tile");
}));

test("a Fiber append does not replay prior Fibers in a cached tile", () => withSource(() => {
  const source = new DrawingSource({ width: 512, height: 512 });
  for (let index = 0; index < 30; index += 1) source.commitDrawable(fiberDrawable(index * 4));
  source.tile(0, 0);
  const rasterized = [], paint = source.paintDrawable.bind(source);
  source.paintDrawable = (next, ...args) => { if (next.style.brush === "fiber") rasterized.push(next); return paint(next, ...args); };
  const next = fiberDrawable(140);
  source.commitDrawable(next);
  assert.deepEqual(rasterized, [next], "commit 31 rasterizes only Fiber 31");
}));

test("periodic material keeps cache tiles inside its fixed domain", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100 });
  const crossing = { ...drawable(), points: [{ x: 90, y: 20 }, { x: 110, y: 20 }] };
  source.tile(0, 0);
  assert.equal(source.tiles.has("1,0"), false);
  source.commitDrawable(crossing);
  assert.equal(source.tiles.has("0,0"), true);
  assert.equal(source.tiles.has("1,0"), false, "a periodic append does not allocate a second-world tile");
  assert.ok(source.tile(0, 0).ctx.calls.some(([name, x]) => name === "translate" && x === -100), "the seam continuation is painted as a translated material copy");
}));

test("an uncached distant tile skips Fiber outside its actual world bounds", () => withSource(() => {
  const source = new DrawingSource({ width: 512, height: 512 });
  for (let index = 0; index < 30; index += 1) source.commitDrawable(fiberDrawable((index % 16) * 14));
  const painted = [], paint = source.paintDrawable.bind(source);
  source.paintDrawable = (next, ...args) => { if (next.style.brush === "fiber") painted.push(next); return paint(next, ...args); };
  source.tile(10, 0);
  assert.deepEqual(painted, [], "a continuous world does not replay a Fiber into unrelated distant tiles");
}));

test("a high-zoom static append preserves the material cache without historical replay", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100 });
  const a = fiberDrawable(), b = fiberDrawable(20);
  source.commitDrawable(a);
  source.prepareView({ pixelDensity: 2 });
  const painted = [], paint = source.paintDrawable.bind(source);
  source.paintDrawable = (next, ...args) => { painted.push(next); return paint(next, ...args); };
  source.commitDrawable(b);
  assert.ok(painted.length >= 1 && painted.every(next => JSON.stringify(next.points) === JSON.stringify(b.points)), "only the new drawable reaches cached and magnified paint paths");
  assert.equal(source.committedDirty, false);
}));

test("a magnified material replays committed paths at material resolution instead of enlarging tile pixels", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100 });
  source.commitDrawable(drawable());
  source.committedCtx.calls.length = 0;
  source.prepareView({ pixelDensity: 2 });
  assert.ok(source.committedCtx.calls.some(([name]) => name === "stroke"), "committed path is rerasterized into the magnified material");
  assert.equal(source.committedCtx.calls.some(([name]) => name === "drawImage"), false, "the low-resolution tile is not enlarged");
}));

test("material bounds are stable through arbitrary source-motion requests", () => withSource(() => {
  const source = new DrawingSource({ width: 512, height: 512 });
  const bounds = source.materialBounds, revision = source.revision;
  let committedCompositions = 0, tileRebuilds = 0;
  const composeCommittedMaterial = source.composeCommittedMaterial.bind(source), rebuildTile = source.rebuildTile.bind(source);
  source.composeCommittedMaterial = (...args) => { committedCompositions += 1; return composeCommittedMaterial(...args); };
  source.rebuildTile = (...args) => { tileRebuilds += 1; return rebuildTile(...args); };
  for (let index = 1; index <= 300; index += 1) assert.equal(source.prepareView({ pixelDensity: 1 }), false, "pure motion has no material request that can recenter storage");
  assert.equal(source.revision, revision);
  assert.deepEqual(source.materialBounds, bounds);
  assert.equal(committedCompositions, 0);
  assert.equal(tileRebuilds, 0);
  assert.equal(source.materialRebuildCount, 0);
}));

test("material resolution is quantized and capped without changing its repeat domain", () => withSource(() => {
  const source = new DrawingSource({ width: 512, height: 512 });
  const bounds = source.materialBounds;
  assert.equal(source.prepareView({ pixelDensity: 8 }), true);
  const revision = source.revision;
  assert.equal(source.canvas.width, 4096, "the material raster is capped independently per axis");
  assert.equal(source.prepareView({ pixelDensity: 9 }), false, "requests above the cap do not churn the raster cache");
  assert.equal(source.revision, revision);
  assert.deepEqual(source.materialBounds, bounds);
}));

test("single Undo removes only the latest operation and restored artwork has no Undo", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100 });
  const bounds = source.materialBounds;
  source.commitDrawable(drawable()); source.commitDrawable({ ...drawable(), points: [{ x: 30, y: 30 }, { x: 40, y: 40 }] });
  assert.equal(source.canUndo(), true);
  source.undo(); assert.equal(source.canUndo(), false);
  assert.deepEqual(source.materialBounds, bounds, "Undo never changes the repeat period");
  source.commitDrawable(drawable()); assert.equal(source.canUndo(), true);
  const state = source.getContentState();
  const restored = new DrawingSource({ width: 100, height: 100 });
  assert.equal(restored.restoreContentState(state), true);
  assert.deepEqual(restored.getContentState(), state);
  assert.deepEqual(derivePath(drawable()).contours[0].points, drawable().points);
}));

test("undo rebuilds derived raster state from the document ChangeSet", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100 });
  const fiber = () => ({
    kind: "pathStroke",
    points: [{ x: 10, y: 10 }, { x: 90, y: 70 }],
    style: { ...drawable().style, brush: "fiber", version: 2, fibers: .5, gravity: 42, branching: 13, curl: 12, spread: .5, wispiness: .5, assistLevel: .5 }
  });
  source.commitDrawable(drawable());
  source.commitDrawable(fiber());
  source.commitDrawable({ ...drawable(), points: [{ x: 60, y: 10 }, { x: 80, y: 30 }] });
  assert.equal(source.staticCheckpoints.at(-1).index, 2);

  let replays = 0;
  const paintOperation = source.paintOperation.bind(source);
  source.paintOperation = (...args) => { replays += 1; return paintOperation(...args); };
  source.undo();
  assert.ok(replays > 0, "cursor changes rebuild derived state from durable truth");
}));

test("content restore rejects drawables with non-finite source coordinates", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100 });
  assert.equal(source.restoreContentState({ version: 2, backgroundColor: "#000", operations: [{ id: "bad", drawable: { ...drawable(), points: [{ x: NaN, y: 1 }] } }] }), false);
  assert.equal(source.operationCount, 0);
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

test("animated previews rerender without rebuilding static committed artwork", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100 });
  source.commitDrawable(drawable());
  source.previewDrawable(animatedRosette());
  let rebuilds = 0;
  const rebuildBase = source.rebuildBase.bind(source);
  source.rebuildBase = () => { rebuilds += 1; rebuildBase(); };
  assert.equal(source.setTime(1), true);
  assert.equal(rebuilds, 0);
}));

test("a fixed-view live Fiber preview never replays committed artwork", () => withSource(() => {
  const preview = fiberDrawable();
  const run = committedCount => {
    const source = new DrawingSource({ width: 512, height: 512 });
    for (let index = 0; index < committedCount; index += 1) source.commitDrawable(fiberDrawable((index % 20) * 12));
    source.prepareView({ pixelDensity: 1 });
    assert.equal(source.prepareView({ pixelDensity: 1 }), false, "the paused renderer material density is unchanged");
    source.ctx.calls.length = 0;
    let committedCompositions = 0, tileRebuilds = 0, cachedReplays = 0;
    const painted = [];
    const composeCommittedMaterial = source.composeCommittedMaterial.bind(source), rebuildTile = source.rebuildTile.bind(source), paintCachedOperation = source.paintCachedOperation.bind(source), paintDrawable = source.paintDrawable.bind(source);
    source.composeCommittedMaterial = (...args) => { committedCompositions += 1; return composeCommittedMaterial(...args); };
    source.rebuildTile = (...args) => { tileRebuilds += 1; return rebuildTile(...args); };
    source.paintCachedOperation = (...args) => { cachedReplays += 1; return paintCachedOperation(...args); };
    source.paintDrawable = (next, ...args) => { painted.push(next); return paintDrawable(next, ...args); };
    source.previewDrawable(preview);
    assert.equal(committedCompositions, 0);
    assert.equal(tileRebuilds, 0);
    assert.equal(cachedReplays, 0);
    assert.equal(source.committedDirty, false);
    assert.deepEqual(painted.map(next => next.points), [preview.points], "only the active preview points reach the renderer");
    return source.ctx.calls.filter(([name]) => name === "drawImage").length;
  };
  assert.equal(run(0), 1, "empty artwork composites one cached committed canvas");
  assert.equal(run(32), 1, "committed history count does not add preview compositing blits");
}));

test("source motion requests do not rebuild a fixed periodic Fiber material", () => withSource(() => {
  const source = new DrawingSource({ width: 512, height: 512 });
  for (let index = 0; index < 8; index += 1) source.commitDrawable(fiberDrawable(index * 14));
  let committedCompositions = 0;
  const composeCommittedMaterial = source.composeCommittedMaterial.bind(source);
  source.composeCommittedMaterial = (...args) => { committedCompositions += 1; return composeCommittedMaterial(...args); };
  assert.equal(source.prepareView({ pixelDensity: 1 }), false);
  assert.equal(committedCompositions, 0, "source position is not an input to material reconstruction");
}));

test("committed animation composes only the dynamic history tail", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100 });
  source.commitDrawable(drawable());
  source.commitDrawable({ ...drawable(), points: [{ x: 30, y: 30 }, { x: 40, y: 40 }] });
  const animated = animatedRosette();
  const animatedId = source.commitDrawable(animated);
  source.commitDrawable({ ...drawable(), points: [{ x: 60, y: 60 }, { x: 70, y: 70 }] });
  assert.equal(source.staticPrefixEnd, 2, "only the leading static operations are baked");
  const staticCacheCallCount = source.baseStaticCtx.calls.length;
  const baseCallCount = source.baseCtx.calls.length;
  assert.equal(source.setTime(1), true);
  assert.equal(source.baseStaticCtx.calls.length, staticCacheCallCount, "static prefix is not replayed per frame");
  const frameCalls = source.baseCtx.calls.slice(baseCallCount);
  assert.equal(frameCalls.filter(([name]) => name === "drawImage").length, 1, "frame starts from the static raster");
  assert.equal(frameCalls.filter(([name]) => name === "stroke").length, 2, "animated drawable and later static drawable retain ordered tail replay");
  assert.equal(source.setTime(2), true);
  assert.equal(source.baseStaticCtx.calls.length, staticCacheCallCount);
}));

test("replacement and single Undo move the static-prefix boundary around animation", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100 });
  source.commitDrawable(drawable());
  const animated = animatedRosette();
  const animatedId = source.commitDrawable(animated);
  source.commitDrawable(drawable());
  assert.equal(source.staticPrefixEnd, 1, "the first animated operation starts the dynamic tail");
  source.undo();
  assert.equal(source.staticPrefixEnd, 1, "single Undo removes only the latest static operation");
  const staticReplacement = generatedDrawable();
  staticReplacement.animation.amount = 0;
  assert.equal(source.replaceDrawable(animatedId, staticReplacement), true);
  assert.equal(source.staticPrefixEnd, source.operationCount, "replacing animation with static content rebakes the prefix");
  assert.equal(source.replaceDrawable(animatedId, animated), true);
  assert.equal(source.staticPrefixEnd, 1, "replacing static content with animation moves the boundary back");
}));

test("replaces an applied drawable without adding a history operation", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100 });
  const id = source.commitDrawable(generatedDrawable());
  const changed = generatedDrawable();
  changed.config.lobes = 7;
  assert.equal(source.replaceDrawable(id, changed), true);
  assert.equal(source.operationCount, 1);
  assert.equal(source.getDrawable(id).config.lobes, 7);
  assert.equal(source.replaceDrawable("missing", changed), false);
}));

test("content restore rejects pre-v2 drawing content", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100 });
  source.commitDrawable(drawable()); source.tile(0, 0);
  const restored = new DrawingSource({ width: 100, height: 100 });
  const legacy = generatedDrawable(); legacy.generatorVersion = 1;
  assert.equal(restored.restoreContentState({ history: [{ type: "drawable", drawable: legacy }], historyIndex: 1 }), false);
  assert.equal(restored.operationCount, 0);
}));

test("canonical manual, Fiber, and generated strokes stay out of distant sparse tiles", () => withSource(() => {
  const source = new DrawingSource({ width: 256, height: 256 });
  source.commitDrawable(drawable()); source.commitDrawable(fiberDrawable()); source.commitDrawable(generatedDrawable()); source.commitDrawable(animatedRosette());
  const painted = [], paint = source.paintDrawable.bind(source);
  source.paintDrawable = (next, ...args) => { painted.push(next); return paint(next, ...args); };
  source.tile(20, -17);
  assert.deepEqual(painted, [], "a distant tile does not replay canonical drawables outside their world bounds");
}));

test("compound Pen batching is exact at opacity one and debug-gated below it", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100 });
  const rosette = animatedRosette();
  rosette.config.lineCount = 18;
  const target = new FakeContext2D();
  source.paintDrawable(rosette, target);
  assert.equal(target.calls.filter(([name]) => name === "beginPath").length, 1);
  assert.equal(target.calls.filter(([name]) => name === "stroke").length, 1);
  assert.equal(target.calls.filter(([name]) => name === "moveTo").length, 18);
  assert.equal(target.calls.filter(([name]) => name === "arc" || name === "fill").length, 0);

  rosette.style.opacity = .85;
  const exactTarget = new FakeContext2D();
  source.paintDrawable(rosette, exactTarget);
  assert.equal(exactTarget.calls.filter(([name]) => name === "stroke").length, 18, "transparent contours retain per-contour compositing by default");

  const previous = globalThis.__KALEIDOSCOPE_EXPERIMENTAL_COMPOUND_PEN__;
  globalThis.__KALEIDOSCOPE_EXPERIMENTAL_COMPOUND_PEN__ = true;
  try {
    const experimentTarget = new FakeContext2D();
    source.paintDrawable(rosette, experimentTarget);
    assert.equal(experimentTarget.calls.filter(([name]) => name === "stroke").length, 1);
  } finally {
    globalThis.__KALEIDOSCOPE_EXPERIMENTAL_COMPOUND_PEN__ = previous;
  }
}));
