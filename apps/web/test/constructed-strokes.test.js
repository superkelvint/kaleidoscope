import test from "node:test";
import assert from "node:assert/strict";
import { sampleCircularArc, sampleCubicBezier } from "../constructed-strokes.js";

test("circular arc keeps a shared radius and chooses the sweep through its bend", () => {
  const arc = sampleCircularArc({ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { sampleCount: 17 });
  assert.deepEqual(arc.points[0], { x: 1, y: 0 });
  assert.deepEqual(arc.points.at(-1), { x: -1, y: 0 });
  assert.ok(Math.abs(arc.guides.radius - 1) < 1e-12);
  assert.ok(arc.points.every(point => Math.abs(Math.hypot(point.x, point.y) - 1) < 1e-12));
  assert.ok(arc.points.some(point => point.y > .99), "the chosen sweep passes through the upper bend");
});

test("collinear arc construction safely falls back to a line", () => {
  const arc = sampleCircularArc({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 }, { sampleCount: 5 });
  assert.equal(arc.guides.fallback, "line");
  assert.deepEqual(arc.points, [{ x: 0, y: 0 }, { x: 2.5, y: 0 }, { x: 5, y: 0 }, { x: 7.5, y: 0 }, { x: 10, y: 0 }]);
});

test("cubic sampler preserves endpoints and follows its handles", () => {
  const cubic = sampleCubicBezier({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }, { sampleCount: 3 });
  assert.deepEqual(cubic.points[0], { x: 0, y: 0 });
  assert.deepEqual(cubic.points.at(-1), { x: 10, y: 0 });
  assert.deepEqual(cubic.points[1], { x: 5, y: 7.5 });
});
