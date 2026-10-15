import test from "node:test";
import assert from "node:assert/strict";
import { LOCAL_MOTIF_GLSL, localMotifPoint, rotateForRenderer } from "../local-motif.js";

test("local motif has finite CPU mappings for every renderer mode and shares GLSL entry point", () => {
  for (const symmetryMode of ["radial", "mirrorRadial", "spiral", "tunnel", "fractalFold", "tile", "p2", "p4", "pg", "hexagonal", "wallpaper", "unknown"]) {
    const point = localMotifPoint({ x: .37, y: -.21 }, { symmetryMode, segments: 7, mirror: true, twist: .4 });
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y), symmetryMode);
  }
  assert.match(LOCAL_MOTIF_GLSL, /vec2 localMotifPoint\s*\(/);
});

test("renderer-parity rotation is clockwise for positive angles", () => {
  const point = rotateForRenderer({ x: 1, y: 0 }, Math.PI / 2);
  assert.ok(Math.abs(point.x) < 1e-12);
  assert.ok(Math.abs(point.y + 1) < 1e-12);
});
