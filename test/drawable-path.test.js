import test from "node:test";
import assert from "node:assert/strict";
import { derivePath, drawableDependsOnTime, isDrawable } from "../drawable-path.js";

function spirograph(overrides = {}) {
  return {
    kind: "generatedStroke", generator: "spirograph", generatorVersion: 1,
    config: { lobes: 5, penOffset: 1.2, reach: .1, rotation: 0, phase: 0, arms: 3 },
    animation: { amount: .5, speed: .15, phase: 0 },
    domain: { start: 0, end: Math.PI * 2 }, sampling: { mode: "parameter", step: .01 },
    style: { brush: "pen", color: "#fff", colorMode: "solid", size: 4, opacity: 1, seed: 9 }, ...overrides
  };
}

test("spirograph derives independent arm contours and morphs deterministically with time", () => {
  const drawable = spirograph();
  const atZero = derivePath(drawable, { width: 200, height: 100, time: 0 });
  const later = derivePath(drawable, { width: 200, height: 100, time: 1 });
  assert.equal(atZero.contours.length, 3);
  assert.ok(atZero.contours.every(contour => contour.closed && contour.points.length > 600));
  assert.notDeepEqual(atZero.contours[0].points, later.contours[0].points);
  assert.deepEqual(atZero, derivePath(drawable, { width: 200, height: 100, time: 0 }));
  assert.equal(drawableDependsOnTime(drawable), true);
});

test("static and malformed generator recipes are handled safely", () => {
  const staticDrawable = spirograph({ animation: { amount: 0, speed: .15, phase: 0 } });
  assert.equal(drawableDependsOnTime(staticDrawable), false);
  assert.deepEqual(derivePath(staticDrawable, { width: 100, height: 100, time: 0 }), derivePath(staticDrawable, { width: 100, height: 100, time: 20 }));
  assert.equal(isDrawable(spirograph({ config: { ...staticDrawable.config, lobes: 99 } })), false);
  assert.deepEqual(derivePath(spirograph({ sampling: { mode: "parameter", step: 0 } }), { width: 100, height: 100 }).contours, []);
});

test("tile placement repeats one normalized Spirograph in bounded, separate contours", () => {
  const single = spirograph({ config: { lobes: 5, penOffset: 1.2, reach: .1, rotation: 0, phase: 0, arms: 2 }, placement: { mode: "single", spacing: .9 } });
  const tiled = { ...single, placement: { mode: "tile", spacing: .4 } };
  const singlePath = derivePath(single, { width: 100, height: 100, time: 2 });
  const tiledPath = derivePath(tiled, { width: 100, height: 100, time: 2 });
  assert.equal(singlePath.contours.length, 2);
  assert.equal(tiledPath.contours.length, 50, "two arms across a bounded 5×5 grid");
  assert.deepEqual(tiledPath.contours[24].points, singlePath.contours[0].points, "the center tile preserves the base contour exactly");
  const center = tiledPath.contours[24].points[100];
  const rightNeighbor = tiledPath.contours[26].points[100];
  assert.ok(Math.abs(rightNeighbor.x - center.x - 40) < 1e-10 && Math.abs(rightNeighbor.y - center.y) < 1e-10, "neighboring tiles are translated copies of the same animated contour");
  assert.equal(isDrawable({ ...tiled, placement: { mode: "tile", spacing: .01 } }), false);
});
