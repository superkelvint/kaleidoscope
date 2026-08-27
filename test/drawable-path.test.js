import test from "node:test";
import assert from "node:assert/strict";
import { derivePath, drawableDependsOnTime, isDrawable } from "../drawable-path.js";
import { prepareGuillocheFrame } from "../generators.js";
import { replayBrushContours } from "../brushes.js";
import { BrushPainter } from "../brush-painter.js";
import { contourEnergy } from "../brush-material.js";

function spirograph(overrides = {}) {
  return {
    kind: "generatedStroke", generator: "spirograph", generatorVersion: 2,
    config: { lobes: 5, penOffset: 1.2, reach: .1, rotation: 0, phase: 0, arms: 3 },
    animation: { amount: .5, speed: .15, phase: 0 },
    domain: { start: 0, end: Math.PI * 2 }, sampling: { mode: "parameter", step: .01 },
    style: { brush: "pen", color: "#fff", colorMode: "solid", size: 4, opacity: 1, seed: 9 }, ...overrides
  };
}
function guillocheRosette(overrides = {}) {
  return {
    kind: "generatedStroke", generator: "guillocheRosette", generatorVersion: 2,
    config: { petals: 8, secondaryFrequency: 13, primaryAmplitude: .08, secondaryAmplitude: .035, baseRadius: .2, rotation: 0, lineCount: 6, lineSpacing: .006, phaseOffset: 0 },
    animation: { amount: .5, speed: .15, targets: { phaseOffset: false, secondaryAmplitude: false, secondaryFrequency: false, rotation: false } },
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

test("generated closed contours resolve v1 material from local curvature", () => {
  const drawable = spirograph({ style: { brush: "pen", taper: "none", materialVersion: 1, colorMode: "gradient", startColor: "#ff0000", endColor: "#0000ff", size: 4, opacity: .85, seed: 9 } });
  const contours = derivePath(drawable, { width: 200, height: 200, time: 0 }).contours, instructions = [];
  replayBrushContours(new BrushPainter(item => instructions.push(item)), contours, drawable.style);
  const energies = contours[0].points.map((_, index) => contourEnergy(contours[0].points, index, drawable.style.size, { closed: true }));
  const low = energies.indexOf(Math.min(...energies)), high = energies.indexOf(Math.max(...energies));
  assert.ok(energies[high] > energies[low]);
  assert.notEqual(instructions[low].color, instructions[high].color, "tighter generator turns receive a distinct material tint");
});

test("static and malformed generator recipes are handled safely", () => {
  const staticDrawable = spirograph({ animation: { amount: 0, speed: .15, phase: 0 } });
  assert.equal(drawableDependsOnTime(staticDrawable), false);
  assert.deepEqual(derivePath(staticDrawable, { width: 100, height: 100, time: 0 }), derivePath(staticDrawable, { width: 100, height: 100, time: 20 }));
  assert.equal(isDrawable(spirograph({ config: { ...staticDrawable.config, lobes: 99 } })), false);
  assert.deepEqual(derivePath(spirograph({ sampling: { mode: "parameter", step: 0 } }), { width: 100, height: 100 }).contours, []);
});

test("generated recipes derive one canonical contour family without placement", () => {
  for (const drawable of [spirograph(), guillocheRosette()]) {
    const path = derivePath(drawable, { width: 100, height: 100, time: 0 });
    assert.ok(path.contours.length > 0);
    assert.deepEqual(path.instances, [{ x: 0, y: 0 }]);
    assert.equal("placement" in drawable, false);
    assert.equal(isDrawable({ ...drawable, placement: { mode: "tile", spacing: .4 } }), false);
  }
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
