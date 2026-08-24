import test from "node:test";
import assert from "node:assert/strict";
import { derivePath, drawableDependsOnTime, isDrawable } from "../drawable-path.js";
import { prepareGuillocheFrame } from "../generators.js";

function spirograph(overrides = {}) {
  return {
    kind: "generatedStroke", generator: "spirograph", generatorVersion: 1,
    config: { lobes: 5, penOffset: 1.2, reach: .1, rotation: 0, phase: 0, arms: 3 },
    animation: { amount: .5, speed: .15, phase: 0 },
    domain: { start: 0, end: Math.PI * 2 }, sampling: { mode: "parameter", step: .01 },
    style: { brush: "pen", color: "#fff", colorMode: "solid", size: 4, opacity: 1, seed: 9 }, ...overrides
  };
}
function guillocheRosette(overrides = {}) {
  return {
    kind: "generatedStroke", generator: "guillocheRosette", generatorVersion: 1,
    config: { petals: 8, secondaryFrequency: 13, primaryAmplitude: .08, secondaryAmplitude: .035, baseRadius: .2, rotation: 0, lineCount: 6, lineSpacing: .006, phaseOffset: 0 },
    animation: { amount: .5, speed: .15, targets: { phaseOffset: false, secondaryAmplitude: false, secondaryFrequency: false, rotation: false } },
    placement: { mode: "single", spacing: .9 }, domain: { start: 0, end: Math.PI * 2 }, sampling: { mode: "parameter", step: .01 },
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
  assert.equal(tiledPath.contours.length, 2, "tile placement reuses the two base contours");
  assert.equal(tiledPath.instances.length, 25, "Spirograph retains the bounded 5×5 grid");
  assert.deepEqual(tiledPath.contours[0].points, singlePath.contours[0].points, "the base contour is unchanged");
  const center = tiledPath.instances.find(instance => instance.x === 0 && instance.y === 0);
  const rightNeighbor = tiledPath.instances.find(instance => instance.x === 40 && instance.y === 0);
  assert.deepEqual(center, { x: 0, y: 0 });
  assert.deepEqual(rightNeighbor, { x: 40, y: 0 });
  assert.equal(isDrawable({ ...tiled, placement: { mode: "tile", spacing: .01 } }), false);
});

test("guilloche rosette creates a radial engraved bundle and tiles it independently", () => {
  const single = guillocheRosette();
  const tiled = { ...single, placement: { mode: "tile", spacing: .9 } };
  const singlePath = derivePath(single, { width: 100, height: 100, time: 0 });
  const tiledPath = derivePath(tiled, { width: 100, height: 100, time: 0 });
  assert.equal(singlePath.contours.length, 6);
  assert.ok(singlePath.contours.every(contour => contour.closed && contour.points.length > 600));
  assert.notDeepEqual(singlePath.contours[0].points, singlePath.contours[1].points);
  assert.equal(tiledPath.contours.length, 6);
  assert.ok(tiledPath.instances.length < 25, "off-canvas rosette copies are culled");
  assert.deepEqual(tiledPath.contours[0].points, singlePath.contours[0].points);
});

test("guilloche rosette animation is checkbox-controlled, deterministic, and validated", () => {
  const staticDrawable = guillocheRosette();
  assert.equal(drawableDependsOnTime(staticDrawable), false);
  assert.deepEqual(derivePath(staticDrawable, { width: 100, height: 100, time: 0 }), derivePath(staticDrawable, { width: 100, height: 100, time: 10 }));
  const animated = guillocheRosette({ animation: { amount: .5, speed: .15, targets: { phaseOffset: true, secondaryAmplitude: true, secondaryFrequency: true, rotation: true } } });
  assert.equal(drawableDependsOnTime(animated), true);
  assert.notDeepEqual(derivePath(animated, { width: 100, height: 100, time: 0 }), derivePath(animated, { width: 100, height: 100, time: 1 }));
  assert.deepEqual(derivePath(animated, { width: 100, height: 100, time: 1 }), derivePath(animated, { width: 100, height: 100, time: 1 }));
  assert.equal(isDrawable(guillocheRosette({ config: { ...staticDrawable.config, lineCount: 41 } })), false);
  assert.equal(isDrawable(guillocheRosette({ animation: { ...staticDrawable.animation, targets: { phaseOffset: true } } })), false);
});

test("guilloche roundness and angular flow broaden the durable polar vocabulary", () => {
  const base = guillocheRosette({ config: { ...guillocheRosette().config, petals: 1, roundness: 1, angularModulation: 0, angularFrequency: 3 } });
  const rounded = { ...base, config: { ...base.config, roundness: .35 } };
  const flowing = { ...base, config: { ...base.config, angularModulation: .4, angularFrequency: 5 } };
  const basePath = derivePath(base, { width: 100, height: 100 });
  assert.equal(isDrawable(base), true, "one petal is a valid rosette setting");
  assert.notDeepEqual(derivePath(rounded, { width: 100, height: 100 }).contours[0].points, basePath.contours[0].points);
  assert.notDeepEqual(derivePath(flowing, { width: 100, height: 100 }).contours[0].points, basePath.contours[0].points);
});

test("guilloche roundness shapes the secondary harmonic when the primary amplitude is zero", () => {
  const base = guillocheRosette({ config: { ...guillocheRosette().config, primaryAmplitude: 0, secondaryAmplitude: .022, roundness: 1, angularModulation: 0, angularFrequency: 3 } });
  const softer = { ...base, config: { ...base.config, roundness: .35 } };
  assert.notDeepEqual(derivePath(base, { width: 100, height: 100 }).contours[0].points, derivePath(softer, { width: 100, height: 100 }).contours[0].points);
});

test("guilloche motion targets use bounded shared-clock excursions and retain closed frequency morphs", () => {
  const base = guillocheRosette({ config: { ...guillocheRosette().config, primaryAmplitude: 0, secondaryAmplitude: 0, angularModulation: .25, angularFrequency: 3, roundness: 1 } });
  const target = key => ({ amount: 1, speed: .5, targets: { phaseOffset: false, secondaryAmplitude: false, secondaryFrequency: false, rotation: false, [key]: true } });
  const phase = { ...base, animation: target("phaseOffset") };
  assert.notDeepEqual(derivePath(phase, { width: 100, height: 100, time: 0 }).contours[0].points, derivePath(phase, { width: 100, height: 100, time: .25 }).contours[0].points, "phase drives angular flow as well as the radial component");
  const amplitude = { ...base, config: { ...base.config, angularModulation: 0 }, animation: target("secondaryAmplitude") };
  assert.notDeepEqual(derivePath(amplitude, { width: 100, height: 100, time: 0 }).contours[0].points, derivePath(amplitude, { width: 100, height: 100, time: .5 }).contours[0].points, "zero durable secondary amplitude is not motion-locked");
  const frequency = { ...base, config: { ...base.config, secondaryAmplitude: .05, angularModulation: 0 }, animation: target("secondaryFrequency") };
  const contour = derivePath(frequency, { width: 100, height: 100, time: .25 }).contours[0];
  assert.ok(Math.hypot(contour.points[0].x - contour.points.at(-1).x, contour.points[0].y - contour.points.at(-1).y) < 1e-9, "integer-frequency morph remains closed");
  const frame = prepareGuillocheFrame(base.config, target("rotation"), 100);
  assert.ok(Math.abs(frame.rotation - base.config.rotation) <= Math.PI * .2 + 1e-12, "rotation amount is a bounded excursion, not a speed multiplier");
});
