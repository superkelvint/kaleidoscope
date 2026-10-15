import test from "node:test";
import assert from "node:assert/strict";
import { DrawingController } from "../drawing-controller.js";
import { DrawingDocument } from "../drawing-document.js";
import { normalizeStrokeRecipe, strokeStyle, validStrokeRecipe } from "../stroke-recipe.js";

const points = [{ x: 1, y: 2 }, { x: 10, y: 8 }];
const recipe = brush => { const controller = new DrawingController({ source: {} }); controller.setBrush(brush); return controller.drawable(structuredClone(points), controller.styleSnapshot()); };

test("new recipes give palette, geometry controls, brush controls, seed, and mapping one durable owner", () => {
  for (const brush of ["pen", "ribbon", "calligraphy", "spray", "texture", "fiber", "hair", "wisp"]) {
    const input = recipe(brush);
    assert.equal(validStrokeRecipe(input), true, brush);
    assert.equal(input.geometry.options?.color, undefined);
    assert.equal(input.material.options?.color, undefined);
    assert.equal(input.material.options?.size, undefined);
    assert.equal(input.material.seed, undefined);
    assert.equal(input.material.options?.seed, undefined);
    assert.equal(typeof input.gesture.seed, "number");
    assert.equal(strokeStyle(input).brush, brush);
    assert.deepEqual(normalizeStrokeRecipe(input), input, "canonicalization is idempotent");
  }
});

test("the previous v4 overloaded options restore to the same effective style and clean recipes", () => {
  const style = { brush: "wisp", version: 2, size: 12, opacity: .7, color: "#fff", colorMode: "solid", seed: 17,
    energy: .8, momentum: .3, turbulence: 1, persistence: 120, density: 3, wispUnitsPerPixel: 2, wispCenterX: 50, wispCenterY: 60 };
  const old = { kind: "pathStroke", gesture: { points, seed: 17 }, geometry: { type: "wisp", options: { ...style } }, material: { type: "adapter", width: 12, opacity: .7, color: "#fff", options: { ...style } } };
  const normalized = normalizeStrokeRecipe(old);
  for (const [key, value] of Object.entries(style)) assert.equal(strokeStyle(normalized)[key], value);
  assert.deepEqual(normalized.gesture.mapping, { wispUnitsPerPixel: 2, wispCenterX: 50, wispCenterY: 60 });
  const document = new DrawingDocument();
  assert.ok(document.restoreContentState({ version: 4, backgroundColor: "#000", operations: [{ id: "existing", type: "PaintOperation", gesture: old.gesture, geometry: old.geometry, material: old.material }] }));
  assert.deepEqual(document.getDrawable("existing"), normalized);
});

test("invalid recipes are rejected atomically at both commit and restore boundaries", () => {
  const document = new DrawingDocument(); document.commit(recipe("pen"));
  const before = document.getContentState();
  const invalid = [
    value => { value.geometry.type = "unknown"; },
    value => { value.material.type = "unknown"; },
    value => { value.material.width = Infinity; },
    value => { value.material.width = -1; },
    value => { value.material.opacity = 2; },
    value => { value.material.composite = "xor"; },
    value => { value.material.colorMode = "unknown"; },
    value => { value.gesture.seed = NaN; },
    value => { value.gesture.points[0].holdCount = -1; },
    value => { value.geometry.frame = { sampling: "distance", spacing: 0 }; },
    value => { value.material.options = { callback() {} }; },
    value => { value.material.options = value; }
  ];
  for (const mutate of invalid) {
    const value = recipe("pen"); mutate(value);
    assert.equal(document.commit(value), null);
    assert.equal(document.restoreContentState({ version: 4, backgroundColor: "#123456", operations: [{ id: "invalid", type: "PaintOperation", gesture: value.gesture, geometry: value.geometry, material: value.material }] }), null);
    assert.deepEqual(document.getContentState(), before);
    assert.equal(document.canUndo(), true);
  }
});

test("replacement keeps operation types stable and preserves the existing Undo slot on rejection", async () => {
  const { GENERATORS } = await import("../generators.js"), generator = GENERATORS.spirograph;
  const generated = { kind: "generatedStroke", generator: generator.id, generatorVersion: generator.version,
    config: structuredClone(generator.defaults), animation: { amount: .5, speed: .15, phase: 0 }, domain: { start: 0, end: generator.period() },
    sampling: { mode: "parameter", step: .02 }, material: { type: "ink", color: "#fff", width: 2, opacity: .5 } };
  assert.equal(validStrokeRecipe(generated), true);
  const document = new DrawingDocument(), paint = document.commit(recipe("pen")), retained = document.commit(generated), before = document.getContentState();
  assert.equal(document.replace(paint.id, generated), null);
  assert.equal(document.replace(retained.id, recipe("pen")), null);
  assert.deepEqual(document.getContentState(), before);
  assert.equal(document.undo().undo.id, retained.id);
});
