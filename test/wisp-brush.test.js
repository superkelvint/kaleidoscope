import test from "node:test";
import assert from "node:assert/strict";
import { BrushPainter } from "../brush-painter.js";
import { WISP_V1, advanceWispSimulation, createWispLivePreview, createWispSimulation, interpolateWispHcl, measureWispPath, prepareWispPath, renderWispPath, renderWispPrepared, simulateWispPath, wispNoise3d } from "../wisp-brush.js";

const style = { brush: "wisp", version: 1, color: "#ff0000", colorMode: "solid", size: 16, opacity: .8 };
const path = [{ x: 10, y: 10 }, { x: 25, y: 16 }, { x: 42, y: 29 }, { x: 58, y: 25 }, { x: 72, y: 40 }];

test("Wisp v1 uses the supplied recipe constants and settles only when its queue is empty", () => {
  const a = prepareWispPath(path, style), b = prepareWispPath(path, style);
  assert.deepEqual(a, b);
  assert.ok(a.emissions.length > 0);
  assert.deepEqual(WISP_V1, {
    startLife: 150, startOpacity: .09, drawsPerFrame: 5, noiseForceScale: 1, noiseSpaceScale: .02, noiseTimeScale: .005, noiseOffset: 0, noiseOctaves: 8, noiseFallout: .65, noiseAngleScale: 5 * Math.PI, noiseAngleOffset: 0, initialVelocityForceScale: .3, initialVelocityDecay: .98, friction: .975, restingDistance: 0, rigidity: .2
  });
  assert.ok(a.bounds && a.bounds.right > a.bounds.left);
  const live = prepareWispPath(path, style, { tail: false });
  assert.equal(live.steps, path.length * 5, "every input sample receives exactly five simulation/draw steps");
  assert.ok(a.emissions.length > live.emissions.length, "completed replay includes its deterministic release tail");
  assert.ok(a.steps > live.steps + 72, "tail duration is governed by the real 150-life queue, not a fixed approximation");
});

test("Wisp's Perlin-style gradient noise is deterministic and continuous", () => {
  const point = [12.34, -5.67, .89], value = wispNoise3d(...point);
  assert.equal(wispNoise3d(...point), value);
  assert.ok(Number.isFinite(value));
  assert.ok(Math.abs(wispNoise3d(point[0] + .001, point[1], point[2]) - value) < .01, "adjacent points stay smooth");
});

test("Wisp uses five simulation attempts per input frame and backend-neutral lighter deposition", () => {
  const samples = [{ x: 0, y: 0 }, { x: 12, y: 9 }, { x: 24, y: 4 }, { x: 36, y: 18 }];
  const prepared = prepareWispPath(samples, style, { tail: false });
  // Curves start once four particles exist. Each eligible simulation step is
  // one connected snapshot, not one painter call per quadratic segment.
  assert.equal(prepared.maxParticles, samples.length);
  assert.equal(prepared.emissions.length, 5);
  const instructions = [];
  renderWispPath(new BrushPainter(item => instructions.push(item)), samples, style);
  assert.ok(instructions.length);
  assert.ok(instructions.every(item => item.type === "polyline" && item.composite === "lighter" && item.opacity > 0 && item.opacity < style.opacity));
  assert.ok(instructions.every(item => item.width === 2));
});

test("Wisp rendered alpha is exactly its legacy simulation formula", () => {
  const samples = [{ x: 0, y: 0 }, { x: 12, y: 9 }, { x: 24, y: 4 }, { x: 36, y: 18 }];
  const prepared = prepareWispPath(samples, style, { tail: false }), instructions = [];
  renderWispPath(new BrushPainter(item => instructions.push(item)), samples, style, { tail: false });
  assert.deepEqual(instructions.map(item => item.opacity), prepared.emissions.map(emission => style.opacity * WISP_V1.startOpacity * emission.newest.life / WISP_V1.startLife));
});

test("Wisp preview is a prefix of the same deterministic simulation without a release tail", () => {
  const preview = prepareWispPath(path, style, { tail: false });
  const committed = prepareWispPath(path, style, { tail: true });
  assert.deepEqual(committed.emissions.slice(0, preview.emissions.length), preview.emissions);
});

test("Wisp streaming preserves retained replay geometry, metadata, and bounds", () => {
  const fixtures = [
    { name: "short", points: path.slice(0, 4), style, tail: false },
    { name: "stationary hold", points: Array.from({ length: 7 }, () => ({ x: 20, y: 20 })), style, tail: true },
    { name: "long", points: Array.from({ length: 24 }, (_, index) => ({ x: index * 3, y: 20 + Math.sin(index / 3) * 11 })), style, tail: false },
    { name: "gradient", points: path, style: { ...style, colorMode: "gradient", startColor: "#ff0000", endColor: "#0044ff" }, tail: true },
    { name: "dense persistent", points: path, style: { ...style, version: 2, density: 10, persistence: 300, energy: .8, momentum: .42, turbulence: 1.4 }, tail: false }
  ];
  for (const fixture of fixtures) {
    const retained = prepareWispPath(fixture.points, fixture.style, { tail: fixture.tail });
    const emitted = [];
    const streamed = simulateWispPath(fixture.points, fixture.style, {
      tail: fixture.tail,
      bounds: true,
      onEmission(emission) { emitted.push({ points: emission.points.map(point => ({ ...point })), newest: { ...emission.newest } }); }
    });
    assert.equal(streamed.steps, retained.steps, `${fixture.name}: step count`);
    assert.equal(streamed.maxParticles, retained.maxParticles, `${fixture.name}: maximum particles`);
    assert.equal(streamed.emissionCount, retained.emissions.length, `${fixture.name}: emission count`);
    assert.equal(streamed.retainedEmissionCount, 0, `${fixture.name}: simulator retains no emissions`);
    assert.deepEqual(emitted, retained.emissions, `${fixture.name}: emission geometry`);
    assert.deepEqual(streamed.bounds, retained.bounds, `${fixture.name}: combined streaming bounds`);
    assert.deepEqual(measureWispPath(fixture.points, fixture.style, { tail: fixture.tail }).bounds, retained.bounds, `${fixture.name}: bounds-only replay`);
    const preparedPaint = [], streamedPaint = [];
    renderWispPrepared(new BrushPainter(item => preparedPaint.push(item)), retained, fixture.style);
    renderWispPath(new BrushPainter(item => streamedPaint.push(item)), fixture.points, fixture.style, { tail: fixture.tail });
    assert.deepEqual(streamedPaint, preparedPaint, `${fixture.name}: painter deposition`);
  }
});

test("Wisp long streamed replay retains only one emission scratch buffer", t => {
  const points = Array.from({ length: 160 }, (_, index) => ({ x: index * 2, y: 80 + Math.sin(index / 7) * 24 }));
  const startedAt = performance.now();
  const result = renderWispPath(new BrushPainter(() => {}), points, { ...style, version: 2, density: 10, persistence: 300 }, { tail: false, bounds: true });
  const elapsedMs = performance.now() - startedAt;
  assert.equal(result.retainedEmissionCount, 0);
  assert.ok(result.emissionCount > 0);
  assert.ok(result.peakEmissionPoints > 0);
  t.diagnostic(`streamed ${result.emissionCount} emissions in ${elapsedMs.toFixed(1)}ms; peak scratch polyline ${result.peakEmissionPoints} points; retained emissions ${result.retainedEmissionCount}`);
});

test("Wisp incremental simulation is exactly the authoritative no-tail replay", () => {
  const authoritative = prepareWispPath(path, style, { tail: false });
  const state = createWispSimulation(style), emissions = [];
  for (const sample of path) advanceWispSimulation(state, sample, emission => emissions.push(emission));
  assert.deepEqual(emissions, authoritative.emissions);
  assert.equal(state.time, authoritative.steps, "the simulation clock advances identically");
  assert.equal(state.maxParticles, authoritative.maxParticles);

  const live = createWispLivePreview({ kind: "pathStroke", points: [], style });
  const painted = [];
  for (let index = 0; index < path.length; index += 1) {
    live.advance([path[index]]);
    live.paintDelta(new BrushPainter(item => painted.push(item)));
    live.finishDelta();
    assert.equal(live.consumedSampleCount, index + 1);
  }
  const replayed = [];
  renderWispPath(new BrushPainter(item => replayed.push(item)), path, style, { tail: false });
  assert.deepEqual(painted, replayed, "incremental delta deposition is identical to one no-tail replay");
  assert.equal(live.activeParticleCount, state.curve.length);
});

test("Wisp live append work is bounded by the newly supplied suffix", () => {
  const live = createWispLivePreview({ kind: "pathStroke", points: [], style });
  const historical = Array.from({ length: 400 }, (_, index) => ({ x: index, y: index % 17 }));
  live.advance(historical);
  const next = { x: 401, y: 9 };
  live.advance([next]);
  assert.equal(live.lastAdvanceSampleCount, 1, "the hot append advances only the new sample");
  assert.equal(live.consumedSampleCount, 401, "the retained prefix exists only for later replay");
});

test("Wisp physics is invariant when source coordinates are scaled with frozen display units", () => {
  const logical = [{ x: 8, y: 9 }, { x: 18, y: 13 }, { x: 33, y: 25 }, { x: 47, y: 18 }, { x: 61, y: 37 }];
  const a = prepareWispPath(logical, { ...style, wispUnitsPerPixel: 1, wispCenterX: 40, wispCenterY: 30 }, { tail: false });
  const b = prepareWispPath(logical.map(point => ({ x: point.x * 4, y: point.y * 4 })), { ...style, wispUnitsPerPixel: 4, wispCenterX: 160, wispCenterY: 120 }, { tail: false });
  assert.equal(b.emissions.length, a.emissions.length);
  for (let index = 0; index < a.emissions.length; index += 1) {
    const left = a.emissions[index], right = b.emissions[index];
    assert.equal(right.points.length, left.points.length);
    for (let point = 0; point < left.points.length; point += 1) {
      assert.ok(Math.abs(right.points[point].x / 4 - left.points[point].x) < 1e-9);
      assert.ok(Math.abs(right.points[point].y / 4 - left.points[point].y) < 1e-9);
    }
  }
});

test("Wisp preserves its input-axis decay quirk independently of transformed source velocity", () => {
  const sourceDiagonal = [
    { x: 0, y: 0, inputScreenVx: 0, inputScreenVy: 0 },
    { x: 12, y: 12, inputScreenVx: 12, inputScreenVy: 0 },
    { x: 24, y: 24, inputScreenVx: 12, inputScreenVy: 0 },
    { x: 36, y: 36, inputScreenVx: 12, inputScreenVy: 0 }
  ];
  const handAxisAligned = prepareWispPath(sourceDiagonal, { ...style, wispUnitsPerPixel: 1 });
  const handDiagonal = prepareWispPath(sourceDiagonal.map(point => ({ ...point, inputScreenVy: point.inputScreenVx })), { ...style, wispUnitsPerPixel: 1 });
  assert.ok(handAxisAligned.bounds.right > handDiagonal.bounds.right + 100,
    "a screen-horizontal input keeps source velocity propulsion alive even when mapping makes it diagonal");
});

test("Wisp applies its frozen center-relative noise-angle field", () => {
  const centered = prepareWispPath(path, { ...style, wispCenterX: 40, wispCenterY: 30 }, { tail: false });
  const uncentered = prepareWispPath(path, style, { tail: false });
  assert.notDeepEqual(centered.emissions, uncentered.emissions,
    "the center rotates coherent noise forces before their source-space acceleration is applied");
});

test("Wisp preserves its cross-wired center atan2 axes", () => {
  const samples = [{ x: 10, y: 10 }, { x: 25, y: 16 }, { x: 42, y: 29 }, { x: 58, y: 25 }];
  const prepared = prepareWispPath(samples, { ...style, wispCenterX: 80, wispCenterY: 30 }, { tail: false });
  const firstCurvePoint = prepared.emissions[0].points[0];
  // This off-center fixture differentiates Wisp's atan2(cx - y, cy - x)
  // from conventional atan2(cy - y, cx - x).
  assert.ok(Math.abs(firstCurvePoint.x - 45.76064013279139) < 1e-12);
  assert.ok(Math.abs(firstCurvePoint.y - 18.681918496913273) < 1e-12);
});

test("Wisp velocity gradients remain finite for stationary holds below the original domain", () => {
  const instructions = [];
  renderWispPath(new BrushPainter(item => instructions.push(item)), Array.from({ length: 5 }, () => ({ x: 20, y: 20 })), {
    ...style, colorMode: "gradient", startColor: "#112233", endColor: "#ddeeff"
  }, { tail: false });
  assert.ok(instructions.length);
  assert.ok(instructions.every(item => !item.color.includes("NaN")));
  assert.ok(instructions.every(item => item.color === "rgb(17,34,51)"), "velocity below 10 clamps to the low endpoint");
});

test("Wisp gradients use perceptual HCL interpolation instead of a dull RGB midpoint", () => {
  assert.equal(interpolateWispHcl("#ff0000", "#0000ff", 0), "rgb(255,0,0)");
  assert.equal(interpolateWispHcl("#ff0000", "#0000ff", 1), "rgb(0,0,255)");
  const midpoint = interpolateWispHcl("#ff0000", "#0000ff", .5);
  assert.notEqual(midpoint, "rgb(128,0,128)", "HCL takes the perceptual hue/chroma path, not a component-wise RGB blend");
  assert.ok(/^rgb\(\d+,\d+,\d+\)$/.test(midpoint));
});

test("Wisp HCL borrows the chromatic hue for an achromatic endpoint", () => {
  const midpoint = interpolateWispHcl("#ffffff", "#ff4da6", .5);
  const channels = midpoint.match(/\d+/g).map(Number);
  assert.ok(channels[0] > channels[2] && channels[2] > channels[1], `white-to-pink remains pink-tinted, got ${midpoint}`);
});
