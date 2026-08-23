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
