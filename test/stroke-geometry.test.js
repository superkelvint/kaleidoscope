import assert from "node:assert/strict";
import test from "node:test";
import { deriveStrokeFrame, deriveStrokeGeometry } from "../stroke-geometry.js";
import { derivePath } from "../drawable-path.js";

test("stroke frames are finite, causal, and prefix stable", () => {
  const prefix = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
  const first = deriveStrokeFrame(prefix, { sampling: "distance", spacing: 3 });
  const extended = deriveStrokeFrame([...prefix, { x: 20, y: 10 }], { sampling: "distance", spacing: 3 });
  assert.deepEqual(extended.points.slice(0, first.points.length), first.points);
  for (const point of extended.points) for (const value of Object.values(point)) assert.ok(Number.isFinite(value));
  assert.equal(deriveStrokeGeometry({ type: "freehand" }, { points: [{ x: 1, y: 1 }] }).paths.length, 1);
});

test("closed frames use cyclic normals and v4 path derivation reads gesture points", () => {
  const frame = deriveStrokeFrame([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 0, y: 0 }], { closed: true });
  assert.equal(frame.closed, true); assert.equal(frame.points.length, 4);
  assert.notDeepEqual([frame.points[0].tangentX, frame.points[0].tangentY], [1, 0]);
  const drawable = { kind: "pathStroke", gesture: { points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }, geometry: { type: "freehand" }, material: { type: "ink" } };
  assert.deepEqual(derivePath(drawable).contours[0].points, drawable.gesture.points);
});

test("incremental frames match reconstruction across duplicates, smoothing, and distance carry", async () => {
  const { createStrokeFrameSession } = await import("../stroke-geometry.js");
  const points = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 2 }, { x: 12, y: 20 }, { x: 23, y: 22 }];
  for (const sampling of ["input", "distance"]) for (const smoothing of [0, .4]) {
    const options = { sampling, spacing: 3, smoothing }, session = createStrokeFrameSession(options);
    assert.deepEqual(points.flatMap(point => session.append(point)), deriveStrokeFrame(points, options).points);
  }
});
