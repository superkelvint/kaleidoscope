import { drawingRecipe } from "./drawing-recipe.js";
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
const drawable = () => (drawingRecipe({ kind: "pathStroke", points: [{ x: 10, y: 10 }, { x: 20, y: 20 }], style: { brush: "pen", color: "#fff", colorMode: "solid", size: 4, opacity: 1, taper: "none", seed: 1 } }));
const fiberDrawable = (offset = 0) => (drawingRecipe({
  kind: "pathStroke", points: [{ x: 20, y: 50 + offset }, { x: 220, y: 50 + offset }],
  style: { ...drawable().material.options, brush: "fiber", version: 2, size: 8, seed: 37, fibers: .5, gravity: 42, branching: 13, curl: 12, spread: .5, wispiness: .5, assistLevel: .55 }
}));
const wispDrawable = () => (drawingRecipe({
  kind: "pathStroke", points: [{ x: 20, y: 50 }, { x: 30, y: 54 }, { x: 42, y: 45 }, { x: 58, y: 60 }, { x: 75, y: 50 }],
  style: { ...drawable().material.options, brush: "wisp", version: 1, size: 16, opacity: .8 }
}));
const generatedDrawable = () => (drawingRecipe({ kind: "generatedStroke", generator: "spirograph", generatorVersion: 2, config: { lobes: 5, penOffset: 1.2, reach: .1, rotation: 0, phase: 0, arms: 1 }, animation: { amount: .5, speed: .15, phase: 0 }, domain: { start: 0, end: Math.PI * 2 }, sampling: { mode: "parameter", step: .01 }, style: drawable().material.options }));
const animatedRosette = () => (drawingRecipe({ kind: "generatedStroke", generator: "guillocheRosette", generatorVersion: 2, config: { petals: 8, secondaryFrequency: 13, primaryAmplitude: .08, secondaryAmplitude: .035, baseRadius: .2, rotation: 0, lineCount: 2, lineSpacing: .006, phaseOffset: 0 }, animation: { amount: .5, speed: .15, targets: { phaseOffset: true, secondaryAmplitude: false, secondaryFrequency: false, rotation: false } }, domain: { start: 0, end: Math.PI * 2 }, sampling: { mode: "parameter", step: .01 }, style: drawable().material.options }));

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

test("paint sessions deposit before completion, persist typed records, and gate generators", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100, createId: (() => { let n = 0; return () => `op-${++n}`; })() });
  const session = source.beginPaintSession(drawable());
  assert.ok(session);
  assert.equal(source.operationCount, 0, "active paint is not history yet");
  assert.equal(source.hasPaintSessions(), true);
  assert.equal(source.commitDrawable(generatedDrawable()), null, "retained operations cannot mutate during paint");
  const id = source.finishPaintSession(session);
  assert.equal(id, "op-1");
  assert.equal(source.hasPaintSessions(), false);
  assert.deepEqual(source.getContentState().operations[0], { id, type: "PaintOperation", gesture: drawable().gesture, geometry: drawable().geometry, material: drawable().material });
  const generator = source.commitDrawable(generatedDrawable());
  assert.equal(source.getContentState().operations[1].type, "GeneratorOperation");
  assert.equal(source.undo(), true, "creation, not a later generator edit, is undoable");
  assert.equal(source.getDrawable(generator), null);
}));

test("additive material paint sessions seed their immediate raster from committed artwork", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100 });
  source.commitDrawable(drawable());
  const additive = drawingRecipe({ ...drawable(), style: { ...drawable().material.options, materialVersion: 1, colorMode: "gradient", startColor: "#ff0000", endColor: "#0000ff" } });
  source.beginPaintSession(additive);
  assert.equal(source.rasterizer.immediateIsComposite, true);
  assert.ok(source.rasterizer.immediateCtx.calls.some(([name]) => name === "drawImage"), "committed material is copied before lighter deposition");
}));

test("a compacted active Pen path reconciles its replacement prefix", () => withSource(() => {
  const source = new DrawingSource({ width: 2048, height: 100 });
  const points = Array.from({ length: 512 }, (_, index) => ({ x: index, y: 30 }));
  const session = source.beginPaintSession(drawingRecipe({ ...drawable(), points }));
  const context = source.rasterizer.immediateCtx;
  context.calls.length = 0;
  const compacted = Array.from({ length: 512 }, (_, index) => ({ x: index * 2, y: 30 }));

  assert.equal(source.updatePaintSession(session, drawingRecipe({ ...drawable(), points: compacted })), true);
  assert.ok(context.calls.some(([name]) => name === "clearRect"), "replacement samples rebuild the active overlay");
  assert.ok(source.rasterizer.immediateCtx.calls.some(([name, x]) => name === "arc" && x === 1022), "the replacement path's new endpoint is painted");
}));

test("a compacted active Spray path remains a spray during reconciliation", () => withSource(() => {
  const source = new DrawingSource({ width: 2048, height: 100 });
  const points = Array.from({ length: 512 }, (_, index) => ({ x: index, y: 30 }));
  const spray = drawingRecipe({ ...drawable(), points, style: { ...drawable().material.options, brush: "spray", density: 3, particleSize: 1 } });
  const session = source.beginPaintSession(spray);
  const context = source.rasterizer.immediateCtx;
  context.calls.length = 0;
  const compacted = drawingRecipe({ ...spray, points: Array.from({ length: 512 }, (_, index) => ({ x: index * 2, y: 30 })) });

  assert.equal(source.updatePaintSession(session, compacted), true);
  const particles = source.rasterizer.immediateCtx.calls.filter(([name]) => name === "arc").length;
  assert.ok(particles >= 3 && particles % 3 === 0, "every spaced Spray burst emits its configured particle population after compaction");
}));

test("a Spray hold update retains earlier completed sprays after pixel promotion", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100 });
  const spray = points => (drawingRecipe({ ...drawable(), points, style: { ...drawable().material.options, brush: "spray", density: 3, particleSize: 1 } }));
  const first = source.beginPaintSession(spray([{ x: 20, y: 20 }]));
  assert.ok(source.finishPaintSession(first));
  assert.equal(source.committedDirty, false, "a completed immediate stroke promotes its visible pixels");

  const second = source.beginPaintSession(spray([{ x: 70, y: 70 }]));
  const cached = source.tile(0, 0);
  assert.ok(cached.ctx.calls.some(([name]) => name === "arc"), "the first spray is present in the committed cache");
  const immediate = source.rasterizer.immediateCtx;
  immediate.calls.length = 0;
  source.updatePaintSession(second, spray([{ x: 70, y: 70, holdCount: 1 }]));
  assert.equal(source.operationCount, 1, "reconciling the active hold does not discard the completed spray");
  assert.equal(immediate.calls.some(([name]) => name === "clearRect"), false, "a timed hold increment stays on Spray's incremental particle stream");
  assert.equal(immediate.calls.filter(([name]) => name === "arc").length, 3, "the timed hold emits Spray's configured particle population");
}));

test("immediate completion promotes pixels without replaying brush or committed history", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100 });
  // Keep a tile resident so eager tile appends would be observable.
  source.tile(0, 0);
  let replays = 0, cachedPaints = 0, compositions = 0;
  const paintOperation = source.paintOperation, paintCachedOperation = source.paintCachedOperation, composeCommittedMaterial = source.composeCommittedMaterial;
  source.paintOperation = (...args) => { replays += 1; return paintOperation(...args); };
  source.paintCachedOperation = (...args) => { cachedPaints += 1; return paintCachedOperation(...args); };
  source.composeCommittedMaterial = (...args) => { compositions += 1; return composeCommittedMaterial(...args); };

  const session = source.beginPaintSession(drawable());
  replays = cachedPaints = compositions = 0;
  assert.ok(source.finishPaintSession(session));
  assert.deepEqual({ replays, cachedPaints, compositions }, { replays: 0, cachedPaints: 0, compositions: 0 });
  assert.equal(source.committedDirty, false);
}));

test("overlapping immediate completions retain their composite without replay", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100 });
  let replays = 0, cachedPaints = 0, compositions = 0;
  const paintOperation = source.paintOperation, paintCachedOperation = source.paintCachedOperation, composeCommittedMaterial = source.composeCommittedMaterial;
  source.paintOperation = (...args) => { replays += 1; return paintOperation(...args); };
  source.paintCachedOperation = (...args) => { cachedPaints += 1; return paintCachedOperation(...args); };
  source.composeCommittedMaterial = (...args) => { compositions += 1; return composeCommittedMaterial(...args); };
  const a = source.beginPaintSession(drawable());
  const b = source.beginPaintSession(drawingRecipe({ ...drawable(), points: [{ x: 60, y: 60 }, { x: 70, y: 70 }] }));
  replays = cachedPaints = compositions = 0;
  source.finishPaintSession(a);
  assert.equal(source.rasterizer.immediateIsComposite, true, "the remaining session keeps the exact visible composite");
  source.finishPaintSession(b);
  assert.equal(source.rasterizer.hasImmediatePixels, false, "the final completion promotes that composite to committed material");
  assert.deepEqual({ replays, cachedPaints, compositions }, { replays: 0, cachedPaints: 0, compositions: 0 });
}));

test("an immediate commit leaves existing sparse tiles stale until requested", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100 });
  const cached = source.tile(0, 0);
  let cachedPaints = 0;
  const paintCachedOperation = source.paintCachedOperation;
  source.paintCachedOperation = (...args) => { cachedPaints += 1; return paintCachedOperation(...args); };
  const session = source.beginPaintSession(drawable());
  source.finishPaintSession(session);
  assert.equal(cachedPaints, 0, "completion does not update a resident tile");
  assert.notEqual(cached.generation, source.rasterizer.committedRasterGeneration, "the resident tile is explicitly stale");
  source.tile(0, 0);
  assert.ok(cachedPaints > 0, "the later tile lookup performs the allowed lazy reconstruction");
  assert.equal(cached.generation, source.rasterizer.committedRasterGeneration);
}));

test("an empty Wisp opens a session and commits only after its async release tail", async () => {
  const previous = globalThis.OffscreenCanvas, queued = [];
  globalThis.OffscreenCanvas = FakeOffscreenCanvas;
  globalThis.requestAnimationFrame = callback => { queued.push(callback); return queued.length; };
  try {
    const source = new DrawingSource({ width: 100, height: 100 });
    const session = source.beginPaintSession(drawingRecipe({ ...wispDrawable(), points: [] }));
    assert.ok(session, "an empty Wisp is valid transient input");
    source.updatePaintSession(session, wispDrawable());
    assert.equal(source.finishPaintSession(session), true);
    assert.equal(source.operationCount, 0, "tail is still live, not durable");
    for (let index = 0; index < 10000 && queued.length; index += 1) queued.shift()(index);
    assert.equal(source.hasPaintSessions(), false);
    assert.equal(source.operationCount, 1);
  } finally { globalThis.OffscreenCanvas = previous; delete globalThis.requestAnimationFrame; }
});

test("Wisp release-tail completion promotes pixels without replay", async () => {
  const previous = globalThis.OffscreenCanvas, queued = [];
  globalThis.OffscreenCanvas = FakeOffscreenCanvas;
  globalThis.requestAnimationFrame = callback => { queued.push(callback); return queued.length; };
  try {
    const source = new DrawingSource({ width: 100, height: 100 });
    let replays = 0, cachedPaints = 0, compositions = 0;
    const paintOperation = source.paintOperation, paintCachedOperation = source.paintCachedOperation, composeCommittedMaterial = source.composeCommittedMaterial;
    source.paintOperation = (...args) => { replays += 1; return paintOperation(...args); };
    source.paintCachedOperation = (...args) => { cachedPaints += 1; return paintCachedOperation(...args); };
    source.composeCommittedMaterial = (...args) => { compositions += 1; return composeCommittedMaterial(...args); };
    const session = source.beginPaintSession(wispDrawable());
    assert.ok(source.finishPaintSession(session));
    for (let index = 0; index < 10000 && queued.length; index += 1) queued.shift()(index);
    assert.deepEqual({ replays, cachedPaints, compositions }, { replays: 0, cachedPaints: 0, compositions: 0 });
  } finally { globalThis.OffscreenCanvas = previous; delete globalThis.requestAnimationFrame; }
});

test("clear destructively resets drawing history and persisted content", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100 });
  const bounds = source.materialBounds;
  const fiber = drawingRecipe({ ...drawable(), points: Array.from({ length: 512 }, (_, index) => ({ x: index, y: index % 80 })), style: { ...drawable().material.options, brush: "fiber", version: 2, fibers: 6, gravity: 42, branching: 13, curl: 12, spread: .5, wispiness: .5, assistLevel: .6 } });
  source.commitDrawable(fiber);
  source.clear();
  assert.equal(source.canUndo(), false);
  assert.deepEqual(source.getContentState().operations, []);
  assert.deepEqual(source.materialBounds, bounds, "clear never changes the repeat period");
}));

test("a static append paints only the new operation into an existing cached tile", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100 });
  const a = drawable(), b = drawingRecipe({ ...drawable(), points: [{ x: 25, y: 25 }, { x: 35, y: 35 }] }), c = drawingRecipe({ ...drawable(), points: [{ x: 40, y: 40 }, { x: 50, y: 50 }] });
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
  source.paintDrawable = (next, ...args) => { if (next.geometry.type === "fiber") rasterized.push(next); return paint(next, ...args); };
  const next = fiberDrawable(140);
  source.commitDrawable(next);
  assert.deepEqual(rasterized, [next], "commit 31 rasterizes only Fiber 31");
}));

test("completed Wisp is static and its exact transient bounds reject distant sparse tiles", () => withSource(() => {
  const source = new DrawingSource({ width: 512, height: 512 });
  source.commitDrawable(wispDrawable());
  const prepared = source.rasterizer.preparedDrawables.values().next().value;
  assert.ok(prepared.bounds);
  assert.equal(prepared.path, null, "Wisp caches bounds rather than its emitted curve history");
  let paints = 0, paint = source.paintDrawable.bind(source);
  source.paintDrawable = (...args) => { paints += 1; return paint(...args); };
  assert.equal(source.setTime(1), false, "Wisp has no timeline dependency");
  source.tile(10, 0);
  assert.equal(paints, 0, "distant tile replay is rejected from Wisp's derived bounds");
}));

test("Wisp preview accumulates one appended sample through the generic live-brush session", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100 });
  const stroke = wispDrawable();
  source.previewDrawable(drawingRecipe({ ...stroke, points: stroke.gesture.points.slice(0, 4) }));
  const first = source.rasterizer.livePreview;
  assert.ok(first, "Wisp opts into the brush-neutral live preview seam");
  assert.equal(first.session.consumedSampleCount, 4);
  source.previewDrawable(stroke);
  assert.equal(source.rasterizer.livePreview, first, "an append retains the accumulating preview canvas/session");
  assert.equal(first.session.consumedSampleCount, 5, "one steady-state preview update consumes one new durable sample");
  source.previewDrawable(null);
  assert.equal(source.rasterizer.livePreview, null, "clearing a preview disposes transient brush state");
}));

test("periodic material keeps cache tiles inside its fixed domain", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100 });
  const crossing = drawingRecipe({ ...drawable(), points: [{ x: 90, y: 20 }, { x: 110, y: 20 }] });
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
  source.paintDrawable = (next, ...args) => { if (next.geometry.type === "fiber") painted.push(next); return paint(next, ...args); };
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
  assert.ok(painted.length >= 1 && painted.every(next => JSON.stringify(next.gesture.points) === JSON.stringify(b.gesture.points)), "only the new drawable reaches cached and magnified paint paths");
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
  source.commitDrawable(drawable()); source.commitDrawable(drawingRecipe({ ...drawable(), points: [{ x: 30, y: 30 }, { x: 40, y: 40 }] }));
  assert.equal(source.canUndo(), true);
  source.undo(); assert.equal(source.canUndo(), false);
  assert.deepEqual(source.materialBounds, bounds, "Undo never changes the repeat period");
  source.commitDrawable(drawable()); assert.equal(source.canUndo(), true);
  const state = source.getContentState();
  const restored = new DrawingSource({ width: 100, height: 100 });
  assert.equal(restored.restoreContentState(state), true);
  assert.deepEqual(restored.getContentState(), state);
  assert.deepEqual(derivePath(drawable()).contours[0].points, drawable().gesture.points);
}));

test("undo rebuilds derived raster state from the document ChangeSet", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100 });
  const fiber = () => (drawingRecipe({
    kind: "pathStroke",
    points: [{ x: 10, y: 10 }, { x: 90, y: 70 }],
    style: { ...drawable().material.options, brush: "fiber", version: 2, fibers: .5, gravity: 42, branching: 13, curl: 12, spread: .5, wispiness: .5, assistLevel: .5 }
  }));
  source.commitDrawable(drawable());
  source.commitDrawable(fiber());
  source.commitDrawable(drawingRecipe({ ...drawable(), points: [{ x: 60, y: 10 }, { x: 80, y: 30 }] }));
  assert.equal(source.staticCheckpoints.at(-1).index, 2);

  let replays = 0;
  const paintOperation = source.paintOperation.bind(source);
  source.paintOperation = (...args) => { replays += 1; return paintOperation(...args); };
  source.undo();
  assert.ok(replays > 0, "cursor changes rebuild derived state from durable truth");
}));

test("content restore rejects drawables with non-finite source coordinates", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100 });
  assert.equal(source.restoreContentState({ version: 2, backgroundColor: "#000", operations: [{ id: "bad", drawable: drawingRecipe({ ...drawable(), points: [{ x: NaN, y: 1 }] }) }] }), false);
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
    assert.deepEqual(painted.map(next => next.gesture.points), [preview.gesture.points], "only the active preview points reach the renderer");
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
  source.commitDrawable(drawingRecipe({ ...drawable(), points: [{ x: 30, y: 30 }, { x: 40, y: 40 }] }));
  const animated = animatedRosette();
  const animatedId = source.commitDrawable(animated);
  source.commitDrawable(drawingRecipe({ ...drawable(), points: [{ x: 60, y: 60 }, { x: 70, y: 70 }] }));
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

  rosette.material.options.opacity = .85;
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

test("finishing shared material reconstruction preserves only the already-visible tail", () => withSource(() => {
  const queued = [], previous = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = callback => { queued.push(callback); return queued.length; };
  try {
    const source = new DrawingSource({ width: 100, height: 100 });
    const drawable = { kind: "pathStroke", gesture: { seed: 3, points: [{ x: 20, y: 20 }, { x: 35, y: 30 }, { x: 50, y: 20 }] }, geometry: { type: "freehand" }, material: { type: "silk", color: "#fff", width: 4, opacity: .5, strands: 2 } };
    const id = source.beginPaintSession(drawable);
    assert.equal(source.finishPaintSession(id), true);
    queued.shift()();
    const renderer = source.rasterizer.paintSessions.get(id).renderer;
    const before = renderer.reconstruct(drawable).flatMap(batch => batch.instructions);
    source.prepareView({ pixelDensity: 2 });
    const afterRenderer = source.rasterizer.paintSessions.get(id).renderer;
    assert.deepEqual(afterRenderer.reconstruct(drawable).flatMap(batch => batch.instructions), before);
    while (queued.length) queued.shift()();
    assert.equal(source.hasPaintSessions(), false);
    assert.equal(source.operationCount, 1);
  } finally { globalThis.requestAnimationFrame = previous; }
}));

test("colored backgrounds reconstruct ordered paint onto the backdrop instead of flattening transparent tiles", () => withSource(() => {
  const source = new DrawingSource({ width: 100, height: 100 });
  source.setBackgroundColor("#241821");
  source.commitDrawable({ kind: "pathStroke", gesture: { points: [{ x: 20, y: 30 }, { x: 40, y: 50 }], seed: 1 }, geometry: { type: "freehand" }, material: { type: "silk", color: "#fff", width: 4, opacity: .5, strands: 2 } });
  const restored = new DrawingSource({ width: 100, height: 100 });
  const destinations = [], paint = restored.paintOperation;
  restored.paintOperation = (operation, context, options) => { destinations.push(context); return paint(operation, context, options); };
  restored.restoreContentState(source.getContentState());
  assert.ok(destinations.includes(restored.rasterizer.committedCtx), "backdrop-dependent blends see the actual background");
}));

test("durable change notifications fire after asynchronous paint completion, never on input", () => withSource(() => {
  const changes = [], queued = [], previous = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = callback => { queued.push(callback); return queued.length; };
  try {
    const source = new DrawingSource({ width: 100, height: 100, onDocumentChange: change => changes.push(change.type) });
    const id = source.beginPaintSession(wispDrawable());
    source.updatePaintSession(id, wispDrawable());
    source.finishPaintSession(id);
    assert.deepEqual(changes, []);
    while (queued.length) queued.shift()();
    assert.deepEqual(changes, ["append"]);
  } finally { globalThis.requestAnimationFrame = previous; }
}));
