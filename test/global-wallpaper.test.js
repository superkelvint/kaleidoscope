import test from "node:test";
import assert from "node:assert/strict";
import { globalWallpaperPoint } from "../global-wallpaper.js";

function assertPointClose(actual, expected, message) {
  assert.ok(Math.abs(actual.x - expected.x) < 1e-9 && Math.abs(actual.y - expected.y) < 1e-9, message);
}

test("CPU wallpaper quotient preserves each group's translation lattice", () => {
  const point = { x: .173, y: -.219 }, spacing = .45;
  const hexTranslation = { x: spacing, y: 0 };
  for (const mode of ["p6m", "p6", "p3m1", "p3", "p31m"]) {
    assertPointClose(
      globalWallpaperPoint({ x: point.x + hexTranslation.x, y: point.y + hexTranslation.y }, mode, spacing),
      globalWallpaperPoint(point, mode, spacing),
      `${mode} identifies hexagonal lattice translations`
    );
  }
  const squareTranslation = { x: 0, y: spacing };
  for (const mode of ["p4m", "p4g"]) {
    assertPointClose(
      globalWallpaperPoint({ x: point.x + squareTranslation.x, y: point.y + squareTranslation.y }, mode, spacing),
      globalWallpaperPoint(point, mode, spacing),
      `${mode} identifies square lattice translations`
    );
  }
});

test("CPU wallpaper quotient identifies p4m rotation and leaves single unchanged", () => {
  const point = { x: .17, y: -.09 }, spacing = .45;
  assertPointClose(globalWallpaperPoint({ x: -point.y, y: point.x }, "p4m", spacing), globalWallpaperPoint(point, "p4m", spacing));
  assert.deepEqual(globalWallpaperPoint(point, "single", spacing), point);
});
