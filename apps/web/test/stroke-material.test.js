import assert from "node:assert/strict";
import test from "node:test";
import { BrushPainter } from "../brush-painter.js";
import { deriveStrokeFrame } from "../stroke-geometry.js";
import { createMaterialSession, measureMaterialBounds, renderMaterial } from "../stroke-material.js";

const geometry = { paths: [{ frame: deriveStrokeFrame([{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 40, y: 10 }]) }] };
const material = { type: "silk", color: "#ffffff", opacity: .8, width: 4, strands: 4, spread: 8, wander: .2, glow: .1, seed: 7 };
const render = seed => { const output = []; renderMaterial(new BrushPainter(item => output.push(item)), geometry, material, { seed }); return output; };

test("Ink emits exactly one plain centerline", () => {
  const output = []; renderMaterial(new BrushPainter(item => output.push(item)), geometry, { type: "ink", color: "#123456", opacity: .5, width: 3 });
  assert.equal(output.length, 1); assert.deepEqual(output[0].points, [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 40, y: 10 }]);
  assert.equal(output[0].composite, "source-over");
});
test("Silk is seeded, has an exact structural spine, and is inside its measured bounds", () => {
  const one = render(7), two = render(7), changed = render(8), bounds = measureMaterialBounds(geometry, material);
  assert.deepEqual(one, two); assert.deepEqual(one[0].points, changed[0].points);
  assert.notDeepEqual(one.slice(1), changed.slice(1));
  const structural = one.filter(item => item.role === "spine");
  assert.deepEqual([structural[0].points[0], ...structural.map(item => item.points[1])], geometry.paths[0].frame.points.map(({ x, y }) => ({ x, y })));
  assert.ok(one[0].width < material.width, "the structural spine is a fine filament rather than an Ink under-stroke");
  assert.equal(one[0].composite, "lighter");
  assert.equal(one[0].cap, "round"); assert.equal(one[0].join, "round");
  assert.ok(one.filter(item => item.role !== "spine").every(item => item.width < material.width && item.opacity < material.opacity && item.composite === "lighter"));
  for (const instruction of one) for (const point of instruction.points) assert.ok(point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.top && point.y <= bounds.bottom);
});
test("Silk glow controls the tethered fibers' luminous contribution", () => {
  const low = [], high = [];
  renderMaterial(new BrushPainter(item => low.push(item)), geometry, { ...material, glow: 0 }, { seed: 7 });
  renderMaterial(new BrushPainter(item => high.push(item)), geometry, { ...material, glow: 1 }, { seed: 7 });
  assert.deepEqual(low[0], high[0], "glow does not alter the structural exact spine");
  assert.equal(low.length, high.length);
  assert.ok(high.every((item, index) => item.role === "spine" ? item.opacity === low[index].opacity : item.opacity > low[index].opacity));
});
test("Silk defaults are finite and use its documented fallback values", () => {
  const output = []; renderMaterial(new BrushPainter(item => output.push(item)), geometry, { type: "silk", color: "#fff", opacity: 1, width: 4 }, { seed: 2 });
  assert.ok(output.length > 1);
  for (const instruction of output) for (const point of instruction.points || []) assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
  const bounds = measureMaterialBounds(geometry, { type: "silk", width: 4, seed: 2 });
  assert.ok(Number.isFinite(bounds.left) && Number.isFinite(bounds.right));
});
test("material sessions emit only the appended stable tail", () => {
  const drawable = points => ({ kind: "pathStroke", gesture: { points, seed: 3 }, geometry: { type: "freehand" }, material: { type: "ink", color: "#fff", opacity: .5, width: 4 } });
  const session = createMaterialSession(drawable([{ x: 0, y: 0 }]));
  session.advance(drawable([{ x: 0, y: 0 }]));
  const second = session.advance(drawable([{ x: 0, y: 0 }, { x: 10, y: 0 }]));
  const third = session.advance(drawable([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }]));
  assert.deepEqual(second[0].instructions[0].points, [{ x: 0, y: 0 }, { x: 10, y: 0 }]);
  assert.deepEqual(third[0].instructions[0].points, [{ x: 10, y: 0 }, { x: 20, y: 0 }]);
  assert.equal(third[0].instructions[0].cap, "round");
});

test("Silk retains its seeded simulation across input chunks and reconstructs only visible tail progress", () => {
  const points = [{ x: 10, y: 20 }, { x: 24, y: 25 }, { x: 36, y: 20 }, { x: 49, y: 28 }];
  const drawable = count => ({ kind: "pathStroke", gesture: { points: points.slice(0, count), seed: 7 }, geometry: { type: "freehand" }, material });
  const session = createMaterialSession(drawable(0)), live = [];
  for (let count = 1; count <= points.length; count += 1) live.push(...session.advance(drawable(count)).flatMap(batch => batch.instructions));
  session.beginFinish();
  assert.equal(session.isFinished, false, "the visible release tail is transient");
  live.push(...session.settle().flatMap(batch => batch.instructions));
  assert.deepEqual(session.reconstruct(drawable(points.length)).flatMap(batch => batch.instructions), live);
  while (!session.isFinished) live.push(...session.settle().flatMap(batch => batch.instructions));
  const replay = [];
  renderMaterial(new BrushPainter(item => replay.push(item)), { paths: [{ frame: deriveStrokeFrame(points) }] }, material, { seed: 7 });
  assert.deepEqual(live, replay, "batching and tail reconstruction preserve the exact paint stream");
});

test("long Silk gestures retain only lifespan-bounded scratch curves", () => {
  const points = [], recipe = { kind: "pathStroke", gesture: { points, seed: 7 }, geometry: { type: "freehand" }, material: { ...material, strands: 2 } };
  const session = createMaterialSession(recipe);
  for (let index = 0; index < 100; index += 1) {
    points.push({ x: index * 4, y: Math.sin(index / 10) * 10 });
    session.advance(recipe);
    assert.ok(session.scratchPointCount <= 62, "expired simulation points are discarded");
  }
});

test("Silk bounds use the gesture seed when the material has no duplicate seed", () => {
  const { seed, ...recipe } = material;
  const instructions = [], context = { seed: 123 };
  renderMaterial(new BrushPainter(item => instructions.push(item)), geometry, recipe, context);
  const bounds = measureMaterialBounds(geometry, recipe, context);
  for (const item of instructions) for (const point of item.points) {
    assert.ok(point.x - item.width / 2 >= bounds.left && point.x + item.width / 2 <= bounds.right);
    assert.ok(point.y - item.width / 2 >= bounds.top && point.y + item.width / 2 <= bounds.bottom);
  }
});

test("Silk wander changes tethered fibers while gradients color the structural spine", () => {
  const output = value => { const instructions = []; renderMaterial(new BrushPainter(item => instructions.push(item)), geometry, { ...material, ...value }, { seed: 7 }); return instructions; };
  const still = output({ wander: 0 }), wandering = output({ wander: 1 });
  assert.deepEqual(still.filter(item => item.role === "spine"), wandering.filter(item => item.role === "spine"));
  assert.notDeepEqual(still.filter(item => item.role !== "spine"), wandering.filter(item => item.role !== "spine"));
  const gradient = output({ options: { colorMode: "gradient", startColor: "#ff0000", endColor: "#0000ff" } }).filter(item => item.role === "spine");
  assert.ok(new Set(gradient.map(item => item.color)).size > 1);
});

test("closed Silk generator contours retain every exact structural edge", () => {
  const points = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }];
  const frame = deriveStrokeFrame(points, { closed: true }), instructions = [];
  renderMaterial(new BrushPainter(item => instructions.push(item)), { paths: [{ frame }] }, material, { seed: 7 });
  const spine = instructions.filter(item => item.role === "spine");
  assert.equal(spine.length, points.length);
  assert.deepEqual(spine.at(-1).points, [points.at(-1), points[0]]);
});
