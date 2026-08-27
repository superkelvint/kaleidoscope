import test from "node:test";
import assert from "node:assert/strict";
import { contourEnergy, contourProgress, interpolateHcl, resolveBrushMaterial, wispVelocityEnergy } from "../brush-material.js";

test("shared HCL interpolation preserves Wisp endpoint, hue, neutral, and clamp behavior", () => {
  assert.equal(interpolateHcl("#ff0000", "#0000ff", 0), "rgb(255,0,0)");
  assert.equal(interpolateHcl("#ff0000", "#0000ff", 1), "rgb(0,0,255)");
  assert.equal(interpolateHcl("#ff0000", "#0000ff", -2), "rgb(255,0,0)");
  assert.equal(interpolateHcl("#ff0000", "#0000ff", 3), "rgb(0,0,255)");
  assert.equal(interpolateHcl("#12ab34", "#12ab34", .37), "rgb(18,171,52)");
  const neutral = interpolateHcl("#ffffff", "#ff4da6", .5).match(/\d+/g).map(Number);
  assert.ok(neutral[0] > neutral[2] && neutral[2] > neutral[1]);
});

test("shared material has deterministic replay-safe contour energy and bounded fields", () => {
  const points = [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 24, y: 0 }];
  assert.equal(contourEnergy(points, 1, 8), contourEnergy(structuredClone(points), 1, 8));
  assert.equal(wispVelocityEnergy({ inputVx: 0, inputVy: 0 }), 0);
  assert.equal(wispVelocityEnergy({ inputVx: 1000, inputVy: 0 }), 1);
  const material = resolveBrushMaterial({ colorMode: "gradient", startColor: "#ff0000", endColor: "#0000ff", opacity: 1 }, { energy: 1, progress: 1, opacityScale: 2, profile: "additive" });
  assert.match(material.color, /^rgb\(/);
  assert.equal(material.opacity, .18 * 1.06, "additive deposition is capped before its low-alpha profile scale");
  assert.equal(material.composite, "lighter");
});

test("additive ordinary material deposits low alpha while Wisp retains its supplied alpha", () => {
  const additive = resolveBrushMaterial({ colorMode: "solid", color: "#ffffff" }, { opacityScale: .85, profile: "additive" });
  assert.equal(additive.opacity, .85 * .18);
  assert.equal(additive.composite, "lighter");
  const wisp = resolveBrushMaterial({ colorMode: "solid", color: "#ffffff" }, { opacityScale: .85, profile: "wisp" });
  assert.equal(wisp.opacity, .85);
});

test("texture quantizes the final HCL material coordinate to its tint-cache budget", () => {
  const style = { colorMode: "gradient", startColor: "#ff0000", endColor: "#0000ff" };
  const tints = new Set();
  for (let index = 0; index < 400; index += 1) {
    tints.add(resolveBrushMaterial(style, { profile: "texture", energy: index / 399, progress: (399 - index) / 399, colorSteps: 32 }).color);
  }
  assert.ok(tints.size <= 32, `expected at most 32 texture tints, got ${tints.size}`);
});

test("closed contour energy derives from local tangent turns rather than path progress", () => {
  const gentle = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 1 }, { x: 0, y: 0 }];
  const tight = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 0 }];
  assert.ok(contourEnergy(tight, 1, 8, { closed: true }) > contourEnergy(gentle, 1, 8, { closed: true }));
  const low = resolveBrushMaterial({ colorMode: "gradient", startColor: "#ff0000", endColor: "#0000ff" }, { energy: 0, progress: 1 });
  const high = resolveBrushMaterial({ colorMode: "gradient", startColor: "#ff0000", endColor: "#0000ff" }, { energy: 1, progress: 0 });
  assert.notEqual(low.color, high.color, "energy outweighs opposing progress bias");
});

test("open contour material signals are causal and match live physical progress", () => {
  const points = [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 36, y: 0 }];
  assert.equal(contourEnergy(points, 0, 8), 0, "the first live stamp has no future-derived energy");
  assert.equal(contourEnergy(points, 1, 8), contourEnergy([points[0], points[1]], 1, 8));
  assert.equal(contourProgress(points, 1, 8), 0, "the second live stamp is painted before its segment is added to travelled distance");
  assert.equal(contourProgress(points, 2, 8), 12 / (8 * 24));
});

test("Wisp material leaves the simulation's supplied alpha exactly unchanged", () => {
  const opacityScale = .8 * .09 * 73 / 150;
  const material = resolveBrushMaterial({ colorMode: "gradient", startColor: "#ff0000", endColor: "#0000ff" }, {
    energy: .93, opacityScale, profile: "wisp"
  });
  assert.equal(material.opacity, opacityScale);
  assert.equal(material.composite, "lighter");
});
