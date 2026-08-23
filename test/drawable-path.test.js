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
