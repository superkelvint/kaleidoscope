import test from "node:test";
import assert from "node:assert/strict";
import { screenToSourcePoint } from "../drawing-mapping.js";

const canvas = { getBoundingClientRect: () => ({ left: 10, top: 20, width: 200, height: 100 }) };
const state = { centerX: .5, centerY: .5, wallpaperMode: "single", symmetryMode: "radial", segments: 4, zoom: 1, panX: 0, panY: 0, rotationRad: 0 };
test("drawing mapping freezes display coordinates and returns Canvas-origin source pixels", () => {
  const point = screenToSourcePoint({ clientX: 110, clientY: 70 }, canvas, state, 100, 100);
  assert.deepEqual(point, { x: 50, y: 50 });
  const top = screenToSourcePoint({ clientX: 110, clientY: 20 }, canvas, state, 100, 100);
  assert.ok(Number.isFinite(top.y) && top.y >= 0 && top.y <= 100, "Canvas coordinate conversion remains bounded after Y inversion");
});

test("radial symmetry maps a square source circle to a circle at every display aspect", () => {
  const radialState = { ...state, symmetryMode: "radial", mirror: false, zoom: 1 };
  for (const [width, height] of [[200, 100], [100, 100], [100, 200]]) for (const segments of [2, 7, 16]) {
    const display = { getBoundingClientRect: () => ({ left: 0, top: 0, width, height }) };
    const aspect = width / height, distances = [];
    for (let index = 0; index < 8; index += 1) {
      const angle = index * Math.PI / 4, radius = .1;
      const point = screenToSourcePoint({ clientX: width * (.5 + radius * Math.cos(angle) / aspect), clientY: height * (.5 - radius * Math.sin(angle)) }, display, { ...radialState, segments }, 100, 100);
      distances.push(Math.hypot(point.x - 50, point.y - 50));
    }
    for (const distance of distances) assert.ok(Math.abs(distance - 10) < 1e-9, `${width}×${height}, ${segments} segments preserves source-circle radius`);
  }
});

test("source aspect fitting preserves bitmap pixel geometry at its matching viewport aspect", () => {
  const display = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 100 }) };
  const horizontal = screenToSourcePoint({ clientX: 120, clientY: 50 }, display, state, 200, 100);
  const vertical = screenToSourcePoint({ clientX: 100, clientY: 30 }, display, state, 200, 100);
  assert.ok(Math.abs(Math.hypot(horizontal.x - 100, horizontal.y - 50) - 20) < 1e-9);
  assert.ok(Math.abs(Math.hypot(vertical.x - 100, vertical.y - 50) - 20) < 1e-9);
});
