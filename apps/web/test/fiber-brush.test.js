import test from "node:test";
import assert from "node:assert/strict";
import { deriveFiberMasterPath, renderFiberPath } from "../fiber-brush.js";
import { BrushPainter } from "../brush-painter.js";

class Context {
  constructor() { this.strokes = []; this.path = []; this.globalAlpha = 1; this.globalCompositeOperation = "source-over"; }
  save() {} restore() {} beginPath() { this.path = []; }
  moveTo(x, y) { this.path.push({ x, y }); }
  lineTo(x, y) { this.path.push({ x, y }); }
  stroke() { this.strokes.push({ alpha: this.globalAlpha, width: this.lineWidth, color: this.strokeStyle, lineCap: this.lineCap, path: this.path }); }
}
const path = Array.from({ length: 36 }, (_, index) => ({ x: index * 5, y: 60 + Math.sin(index / 7) * 20 }));
const style = { brush: "fiber", version: 1, seed: 1234, size: 12, opacity: .85, colorMode: "gradient", startColor: "#ff0000", endColor: "#0044ff", assistLevel: .9, fibers: .5, spread: .5, wispiness: .5 };

test("Fiber derives a bounded master path with a stable flow field", () => {
  const master = deriveFiberMasterPath(path);
  assert.ok(master.length >= 12 && master.length <= 192);
  assert.ok(master.every(point => Number.isFinite(point.tangentX) && point.curvature >= 0 && point.curvature <= 1));
});

test("Fiber rendering is deterministic and preview retains the primary material", () => {
  const fullA = new Context(), fullB = new Context(), preview = new Context();
  renderFiberPath(fullA, path, style);
  renderFiberPath(fullB, path, style);
  renderFiberPath(preview, path, style, { preview: true });
  assert.deepEqual(fullA.strokes, fullB.strokes);
  assert.ok(fullA.strokes.length > preview.strokes.length);
  assert.ok(fullA.strokes.some(stroke => stroke.color.includes("rgb")));
});

test("Fiber emits backend-neutral polyline material instructions", () => {
  const instructions = [], painter = new BrushPainter(instruction => instructions.push(instruction));
  renderFiberPath(painter, path, { ...style, version: 2, fibers: .4 });
  assert.ok(instructions.length);
  assert.ok(instructions.every(instruction => instruction.type === "polyline"));
  assert.ok(instructions.every(instruction => instruction.points.length > 1 && instruction.width > 0 && instruction.opacity > 0));
  assert.ok(instructions.some(instruction => instruction.cap === "butt"), "taper chunks retain butt caps");
  assert.ok(instructions.some(instruction => instruction.composite === "lighter"), "hot cores retain additive compositing");
});

test("Fiber adapter material is independent of the removed materialVersion switch", () => {
  const legacy = [], shared = [];
  const v2 = { ...style, version: 2, fibers: .4, gravity: 20, branching: 0, curl: 0 };
  renderFiberPath(new BrushPainter(item => legacy.push(item)), path, v2);
  renderFiberPath(new BrushPainter(item => shared.push(item)), path, { ...v2, materialVersion: 1 });
  assert.deepEqual(shared.map(({ points, width, cap, composite }) => ({ points, width, cap, composite })), legacy.map(({ points, width, cap, composite }) => ({ points, width, cap, composite })));
  assert.deepEqual(shared, legacy);
});

test("Fiber solid mode honors the selected solid color over retained gradient swatches", () => {
  const context = new Context();
  renderFiberPath(context, path, { ...style, colorMode: "solid", color: "#ff0000", startColor: "#ffffff", endColor: "#0044ff" });
  assert.ok(context.strokes.length);
  for (const stroke of context.strokes) {
    if (stroke.color === "#ff0000") continue;
    const [red, green, blue] = stroke.color.match(/\d+/g).map(Number);
    assert.ok(red >= green && red >= blue, `expected selected red, got ${stroke.color}`);
  }
});

test("Fiber v2 keeps completed flow samples stable as a live gesture extends", () => {
  const short = path.slice(0, 24), extended = [...short, ...path.slice(24)];
  const before = deriveFiberMasterPath(short), after = deriveFiberMasterPath(extended);
  assert.ok(after.length > before.length);
  for (let i = 0; i < before.length; i += 1) {
    assert.equal(after[i].arcLength, before[i].arcLength);
    assert.equal(after[i].x, before[i].x);
    assert.equal(after[i].y, before[i].y);
    assert.equal(after[i].tangentX, before[i].tangentX);
    assert.equal(after[i].tangentY, before[i].tangentY);
  }
});

test("Fiber v2 renders a deterministic root network and preview omits only detail", () => {
  const v2 = { ...style, version: 2, assistLevel: 1, fibers: 1, wispiness: .8 };
  const longPath = Array.from({ length: 140 }, (_, index) => ({ x: index * 5, y: 60 + Math.sin(index / 7) * 20 }));
  const fullA = new Context(), fullB = new Context(), preview = new Context();
  renderFiberPath(fullA, longPath, v2);
  renderFiberPath(fullB, longPath, v2);
  renderFiberPath(preview, longPath, v2, { preview: true });
  assert.deepEqual(fullA.strokes, fullB.strokes);
  assert.ok(fullA.strokes.length > preview.strokes.length);
  assert.ok(fullA.strokes.every(stroke => stroke.width > 0 && stroke.alpha > 0));
});

test("Fiber flow attraction keeps a horizontal gesture close to its local direction", () => {
  const horizontal = Array.from({ length: 140 }, (_, index) => ({ x: index * 5, y: 100 }));
  const base = { ...style, version: 2, assistLevel: 0, fibers: 2, branching: 1, curl: 0, color: "#ffffff", colorMode: "solid" };
  const loose = new Context(), attracted = new Context();
  renderFiberPath(loose, horizontal, { ...base, gravity: 0 });
  renderFiberPath(attracted, horizontal, { ...base, gravity: 100 });
  const endDistance = context => Math.abs(context.strokes.at(-1).path.at(-1).y - 100);
  assert.ok(endDistance(attracted) < endDistance(loose), "stronger flow attraction follows the local stroke direction");
});

test("Fiber flow attraction does not impose a signed screen-Y bend", () => {
  const horizontal = Array.from({ length: 141 }, (_, index) => ({ x: index * 5, y: 100 }));
  const meanEndpointY = gravity => {
    const context = new Context();
    renderFiberPath(context, horizontal, { ...style, version: 2, seed: 1234, assistLevel: 0, fibers: 2, branching: 1, curl: .0001, gravity, color: "#ffffff", colorMode: "solid" });
    return context.strokes.reduce((total, stroke) => total + stroke.path.at(-1).y, 0) / context.strokes.length;
  };
  assert.equal(meanEndpointY(-100), meanEndpointY(0), "negative values clamp to zero flow attraction instead of reversing a world-Y force");
});

test("Fiber taper chunks use butt caps so shared endpoints do not accumulate alpha", () => {
  const context = new Context();
  renderFiberPath(context, Array.from({ length: 140 }, (_, index) => ({ x: index * 5, y: 100 })), { ...style, version: 2, assistLevel: 1, fibers: 8, branching: 80 });
  assert.ok(context.strokes.length > 1);
  assert.ok(context.strokes.every(stroke => stroke.lineCap === "butt"));
});

test("Fiber v2 material combines progress and energy across taper chunks", () => {
  const context = new Context();
  renderFiberPath(context, Array.from({ length: 141 }, (_, index) => ({ x: index * 5, y: 100 })), {
    ...style, version: 2, assistLevel: 0, fibers: 2, branching: 1, curl: 0, gravity: 0,
    colorMode: "gradient", startColor: "#000000", endColor: "#ffffff"
  });
  const shades = context.strokes.map(stroke => Number(stroke.color.match(/\d+/)?.[0]));
  assert.ok(Math.min(...shades) < 100, `expected a darker early chunk, got ${Math.min(...shades)}`);
  assert.ok(Math.max(...shades) > 180, `expected a lighter late chunk, got ${Math.max(...shades)}`);
  assert.ok(Math.max(...shades) - Math.min(...shades) > 100, "the gradient retains a broad longitudinal range");
  assert.ok(shades.filter(shade => shade < 180).length >= Math.floor(shades.length * .2), "gradient should not be overwhelmingly end colour");
});

test("migrated v3 Fiber retains its original material-version choice without changing geometry", () => {
  const legacy = [], shared = [], recipe = { ...style, version: 2, fibers: .4, gravity: 20, branching: 0, curl: 0, schemaVersion: 3 };
  renderFiberPath(new BrushPainter(item => legacy.push(item)), path, recipe);
  renderFiberPath(new BrushPainter(item => shared.push(item)), path, { ...recipe, materialVersion: 1 });
  assert.deepEqual(legacy.map(({ points, width }) => ({ points, width })), shared.map(({ points, width }) => ({ points, width })));
  assert.notDeepEqual(legacy.map(item => item.color), shared.map(item => item.color));
});
