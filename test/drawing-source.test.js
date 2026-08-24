import test from "node:test";
import assert from "node:assert/strict";
import { DrawingSource } from "../drawing-source.js";
import { derivePath } from "../drawable-path.js";
import { brushTextureCatalog } from "../brush-textures.js";

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
const generatedDrawable = () => ({ kind: "generatedStroke", generator: "spirograph", generatorVersion: 1, config: { lobes: 5, penOffset: 1.2, reach: .1, rotation: 0, phase: 0, arms: 1 }, animation: { amount: .5, speed: .15, phase: 0 }, domain: { start: 0, end: Math.PI * 2 }, sampling: { mode: "parameter", step: .01 }, style: drawable().style });
const animatedRosette = () => ({ kind: "generatedStroke", generator: "guillocheRosette", generatorVersion: 1, config: { petals: 8, secondaryFrequency: 13, primaryAmplitude: .08, secondaryAmplitude: .035, baseRadius: .2, rotation: 0, lineCount: 2, lineSpacing: .006, phaseOffset: 0 }, animation: { amount: .5, speed: .15, targets: { phaseOffset: true, secondaryAmplitude: false, secondaryFrequency: false, rotation: false } }, domain: { start: 0, end: Math.PI * 2 }, sampling: { mode: "parameter", step: .01 }, style: drawable().style });

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

test("committed animation composes only the dynamic history tail", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100 });
  source.commitDrawable(drawable());
  source.commitDrawable({ ...drawable(), points: [{ x: 30, y: 30 }, { x: 40, y: 40 }] });
  const animated = animatedRosette();
  source.commitDrawable(animated);
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

test("history mutations move the static-prefix boundary around animation and clears", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100 });
  source.commitDrawable(drawable());
  const animated = animatedRosette();
  source.commitDrawable(animated);
  source.clear();
  source.commitDrawable(drawable());
  assert.equal(source.staticPrefixEnd, 1);
  source.undo(); source.undo();
  assert.equal(source.staticPrefixEnd, 1, "undo keeps the first animated operation in the tail");
  source.undo();
  assert.equal(source.staticPrefixEnd, 1, "undoing the animated operation restores an all-static prefix");
  source.redo();
  assert.equal(source.staticPrefixEnd, 1);
  const staticReplacement = generatedDrawable();
  staticReplacement.animation.amount = 0;
  assert.equal(source.replaceDrawable(1, staticReplacement), true);
  assert.equal(source.staticPrefixEnd, source.historyIndex, "replacing animation with static content rebakes the prefix");
  assert.equal(source.replaceDrawable(1, animated), true);
  assert.equal(source.staticPrefixEnd, 1, "replacing static content with animation moves the boundary back");
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

test("tiled generated recipes preview, persist, replay, and animate as durable placement state", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100 });
  const tiled = generatedDrawable();
  tiled.placement = { mode: "tile", spacing: .4 };
  source.previewDrawable(tiled);
  assert.equal(source.preview.placement.mode, "tile");
  assert.equal(source.commitDrawable(tiled), true);
  source.undo(); source.redo();
  const restored = new DrawingSource({ width: 100, height: 100 });
  assert.equal(restored.restoreContentState(source.getContentState()), true);
  assert.deepEqual(restored.history[0].drawable.placement, { mode: "tile", spacing: .4 });
  const before = restored.revision;
  assert.equal(restored.setTime(2), true);
  assert.ok(restored.revision > before);
}));

test("tiled generated paths rasterize contours once and blit every retained instance", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100 });
  const tiled = generatedDrawable();
  tiled.placement = { mode: "tile", spacing: .4 };
  const path = derivePath(tiled, { width: 100, height: 100 });
  const target = new FakeContext2D();
  source.paintDrawable(tiled, target);
  assert.equal(source.motifCtx.calls.filter(([name]) => name === "stroke").length, path.contours.length, "base contours replay once");
  const blits = target.calls.filter(([name]) => name === "drawImage");
  assert.equal(blits.length, path.instances.length, "one transparent motif composite per instance");
  assert.ok(blits.every(([, canvas]) => canvas === source.motifCanvas));
  assert.deepEqual(target.calls.filter(([name]) => name === "globalCompositeOperation"), path.instances.map(() => ["globalCompositeOperation", "source-over"]));

  const single = generatedDrawable();
  const direct = new DrawingSource({ width: 100, height: 100 });
  const directTarget = new FakeContext2D();
  direct.paintDrawable(single, directTarget);
  assert.equal(direct.motifCanvas, null, "single placement keeps direct contour replay");
  assert.equal(directTarget.calls.filter(([name]) => name === "stroke").length, 1);
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

test("motif bounds include every brush footprint and antialias padding", () => withSource(() => {
  const cases = [
    ["pen", { size: 10, taper: "sine", colorMode: "gradient" }, 5],
    ["ribbon", { size: 10, span: 30 }, 20],
    ["calligraphy", { size: 10, nibRatio: 3 }, 15],
    ["spray", { size: 10, particleSize: 6, density: 2 }, 8],
    ["texture", { size: 10, textureId: "motif-tip", spacing: 1, rotationMode: "followStroke" }, 10 * Math.SQRT2 / 2]
  ];
  brushTextureCatalog.loaded.set("motif-tip", { width: 10, height: 10, tints: new Map([["#fff", { width: 10, height: 10 }]]) });
  try {
    for (const [brush, style, footprint] of cases) {
      const source = new DrawingSource({ width: 100, height: 100 });
      const tiled = generatedDrawable();
      tiled.placement = { mode: "tile", spacing: .4 };
      Object.assign(tiled.style, style, { brush });
      const path = derivePath(tiled, { width: 100, height: 100 });
      const points = path.contours.flatMap(contour => contour.points);
      const minX = Math.min(...points.map(point => point.x)), maxX = Math.max(...points.map(point => point.x));
      const minY = Math.min(...points.map(point => point.y)), maxY = Math.max(...points.map(point => point.y));
      const expectedWidth = Math.ceil(maxX + footprint + 2) - Math.floor(minX - footprint - 2);
      const expectedHeight = Math.ceil(maxY + footprint + 2) - Math.floor(minY - footprint - 2);
      source.paintDrawable(tiled, new FakeContext2D());
      assert.equal(source.motifCanvas.width, expectedWidth, `${tiled.style.brush} width preserves its footprint`);
      assert.equal(source.motifCanvas.height, expectedHeight, `${tiled.style.brush} height preserves its footprint`);
    }
  } finally {
    brushTextureCatalog.loaded.delete("motif-tip");
  }
}));

test("animated tiled Guilloche remains deterministic and exposes aggregate motif timings", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100 });
  const tiled = animatedRosette();
  tiled.placement = { mode: "tile", spacing: .4 };
  const path = derivePath(tiled, { width: 100, height: 100, time: 0 });
  const previousFlag = globalThis.__KALEIDOSCOPE_DEBUG_PERF__;
  const previousTimings = globalThis.__KALEIDOSCOPE_PERF_TIMINGS__;
  globalThis.__KALEIDOSCOPE_DEBUG_PERF__ = true;
  globalThis.__KALEIDOSCOPE_PERF_TIMINGS__ = {};
  try {
    const first = new FakeContext2D(), second = new FakeContext2D();
    source.paintDrawable(tiled, first); source.paintDrawable(tiled, second);
    assert.deepEqual(first.calls.filter(([name]) => name === "drawImage").map(call => call.slice(2)), second.calls.filter(([name]) => name === "drawImage").map(call => call.slice(2)));
    assert.deepEqual(first.calls.filter(([name]) => name === "drawImage").map(call => call.slice(2)), path.instances.map(instance => {
      const bounds = first.calls.filter(([name]) => name === "drawImage")[0];
      return [bounds[2] - path.instances[0].x + instance.x, bounds[3] - path.instances[0].y + instance.y];
    }));
    for (const label of ["Generated motif rasterization", "Generated tile instance blits", "Canvas brush replay", "Native Pen replay", "Compound Pen path build", "Compound Pen stroke"]) {
      const timing = globalThis.__KALEIDOSCOPE_PERF_TIMINGS__[label];
      assert.ok(timing);
      assert.equal(timing.samples.length, timing.count);
      assert.ok(timing.max >= timing.p95 && timing.p95 >= timing.average);
    }
  } finally {
    globalThis.__KALEIDOSCOPE_DEBUG_PERF__ = previousFlag;
    globalThis.__KALEIDOSCOPE_PERF_TIMINGS__ = previousTimings;
  }
  source.commitDrawable(tiled);
  const before = source.revision;
  assert.equal(source.setTime(1), true);
  assert.ok(source.revision > before);
}));
