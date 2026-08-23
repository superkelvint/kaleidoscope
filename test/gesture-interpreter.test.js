import test from "node:test";
import assert from "node:assert/strict";
import {
  ARC_SAMPLE_COUNT,
  BOUNDARY_SNAP_DISTANCE,
  PETAL_SAMPLE_COUNT,
  interpretGesture,
  nearestMirrorBoundary,
  projectOntoRay,
  preprocessGesture,
  sampleCanonicalGesture
} from "../gesture-interpreter.js";

test("preprocesses noisy samples into a bounded deterministic path", () => {
  const raw = Array.from({ length: 200 }, (_, index) => ({ x: index / 2, y: index % 2 ? .1 : 0 }));
  const result = preprocessGesture(raw);
  assert.equal(result.length, 64);
  assert.ok(result.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)));
  assert.deepEqual(result, preprocessGesture(raw));
});

test("classifies open strokes as snapped arcs and closed strokes as petals", () => {
  const arc = interpretGesture([{ x: 0, y: 0 }, { x: 30, y: 8 }, { x: 70, y: 12 }, { x: 100, y: 0 }], { segments: 4 });
  assert.equal(arc.primitive, "arc");
  assert.equal(arc.points.length, ARC_SAMPLE_COUNT);
  assert.equal(arc.orientation, 0, "orientation snaps to TAU / segments / 4");

  const petal = interpretGesture([{ x: 0, y: 0 }, { x: 30, y: 25 }, { x: 65, y: 20 }, { x: 90, y: 0 }, { x: 40, y: -20 }, { x: 0, y: 0 }], { segments: 8 });
  assert.equal(petal.primitive, "petal");
  assert.equal(petal.points.length, PETAL_SAMPLE_COUNT);
  assert.deepEqual(petal.points[0], petal.points.at(-1));
});

test("rejects gestures shorter than six display pixels", () => {
  assert.equal(interpretGesture([{ x: 4, y: 3 }, { x: 7, y: 6 }]), null);
});

test("mirror boundaries occur at every half wedge", () => {
  for (const segments of [6, 8, 12]) {
    const step = Math.PI / segments;
    for (let index = 0; index < segments * 2; index += 1) {
      const angle = index * step + step * 0.1;
      const boundary = nearestMirrorBoundary({ x: Math.cos(angle), y: Math.sin(angle) }, { x: 0, y: 0 }, segments);
      assert.ok(Math.abs(boundary.angle - index * step) < 1e-10 || Math.abs(boundary.angle - ((index + 1) * step) % (Math.PI * 2)) < 1e-10);
    }
  }
});

test("non-square display canvases preserve display-pixel wedge geometry", () => {
  const rect = { width: 200, height: 100 };
  const center = { x: 100, y: 50 };
  // For a 200×100 display, shader normalization followed by x *= 2 yields
  // (dx / 100, dy / 100): exactly the same angle as display pixels.
  const point = { x: 150, y: 100 };
  const shaderPoint = {
    x: (point.x - center.x) / rect.width * (rect.width / rect.height),
    y: (point.y - center.y) / rect.height
  };
  assert.ok(Math.abs(Math.atan2(shaderPoint.y, shaderPoint.x) - Math.atan2(point.y - center.y, point.x - center.x)) < 1e-10);
  const boundary = nearestMirrorBoundary(point, center, 8);
  assert.ok(Math.abs(boundary.angle - Math.PI / 4) < 1e-10);
  const projection = projectOntoRay(point, center, boundary.ray);
  assert.ok(Math.hypot(projection.point.x - point.x, projection.point.y - point.y) < 1e-10);

  const gesture = interpretGesture([{ x: 125, y: 75 }, { x: 150, y: 100 }, { x: 175, y: 125 }], {
    segments: 8, center, symmetryMode: "mirrorRadial", mirror: true
  });
  const frame = gesture.endpointAttachments.start;
  assert.equal(frame.attached, true);
  assert.ok(Math.abs(frame.ray.y / frame.ray.x - 1) < 1e-10);
  const curve = gesture.curves[0];
  const derivative = { x: curve.b.x - curve.a.x, y: curve.b.y - curve.a.y };
  assert.ok(Math.abs(derivative.x * frame.ray.x + derivative.y * frame.ray.y) < 1e-8, "the endpoint handle is visually perpendicular to the ray");
});

test("arc endpoints snap to eligible mirror rays with normal endpoint derivatives", () => {
  const context = { segments: 4, center: { x: 0, y: 100 }, symmetryMode: "radial", mirror: true };
  const gesture = interpretGesture([{ x: 30, y: 102 }, { x: 65, y: 105 }, { x: 110, y: 101 }], context);
  assert.equal(gesture.primitive, "arc");
  assert.equal(gesture.endpointAttachments.start.attached, true);
  assert.equal(gesture.endpointAttachments.end.attached, true);
  const curve = gesture.curves[0];
  assert.ok(Math.abs(curve.a.y - 100) < 1e-10);
  assert.ok(Math.abs(curve.d.y - 100) < 1e-10);
  assert.ok(Math.abs(curve.b.x - curve.a.x) < 1e-10);
  assert.ok(Math.abs(curve.d.x - curve.c.x) < 1e-10);

  const far = interpretGesture(
    [{ x: 30, y: 100 + BOUNDARY_SNAP_DISTANCE + 1 }, { x: 65, y: 100 + BOUNDARY_SNAP_DISTANCE + 2 }, { x: 110, y: 100 + BOUNDARY_SNAP_DISTANCE + 1 }],
    { ...context, center: { x: -1000, y: 100 } }
  );
  assert.equal(far.endpointAttachments.start.attached, false);
  assert.equal(far.endpointAttachments.end.attached, false);

  const oneEnd = interpretGesture(
    [{ x: 30, y: 100 }, { x: 70, y: 115 }, { x: 110, y: 140 }],
    { ...context, center: { x: -1000, y: 100 } }
  );
  assert.equal(oneEnd.endpointAttachments.start.attached, true);
  assert.equal(oneEnd.endpointAttachments.end.attached, false);
});

test("arc chord orientation is independent from the petal PCA axis", () => {
  const arc = interpretGesture([{ x: 0, y: 0 }, { x: 100, y: 400 }, { x: 200, y: 0 }], { segments: 4 });
  assert.equal(arc.primitive, "arc");
  assert.equal(arc.orientation, 0, "the start-to-end chord is horizontal");
});

test("petal boundary attachments keep both cubic halves smooth", () => {
  const gesture = interpretGesture([
    { x: 60, y: 100 }, { x: 90, y: 115 }, { x: 120, y: 100 },
    { x: 90, y: 85 }, { x: 60, y: 100 }
  ], { segments: 4, center: { x: 0, y: 100 }, symmetryMode: "mirrorRadial", mirror: false });
  assert.equal(gesture.primitive, "petal");
  assert.equal(gesture.endpointAttachments.start.attached, true);
  assert.equal(gesture.endpointAttachments.end.attached, true);
  const [first, second] = gesture.curves;
  assert.deepEqual(first.a, second.d);
  assert.deepEqual(first.d, second.a);
  assert.deepEqual(
    { x: first.b.x - first.a.x, y: first.b.y - first.a.y },
    { x: second.d.x - second.c.x, y: second.d.y - second.c.y }
  );
  assert.deepEqual(
    { x: first.d.x - first.c.x, y: first.d.y - first.c.y },
    { x: second.b.x - second.a.x, y: second.b.y - second.a.y }
  );
});

test("turning distinguishes nearly closed petals from open C-shaped arcs", () => {
  const nearlyClosed = interpretGesture([
    { x: 100, y: 0 }, { x: 170, y: 30 }, { x: 190, y: 100 }, { x: 170, y: 170 },
    { x: 100, y: 190 }, { x: 30, y: 170 }, { x: 0, y: 100 }
  ]);
  assert.equal(nearlyClosed.primitive, "petal");
  assert.ok(nearlyClosed.accumulatedTurning > Math.PI);

  const cShape = interpretGesture([
    { x: 100, y: 0 }, { x: 35, y: 20 }, { x: 0, y: 100 }, { x: 35, y: 180 }, { x: 100, y: 200 }
  ]);
  assert.equal(cShape.primitive, "arc");
});

test("two-cubic petal sampling has one join and preserves the requested count", () => {
  const petal = interpretGesture([{ x: 0, y: 0 }, { x: 30, y: 25 }, { x: 65, y: 20 }, { x: 90, y: 0 }, { x: 40, y: -20 }, { x: 0, y: 0 }], { segments: 8 });
  const points = sampleCanonicalGesture(petal, 33);
  const join = petal.curves[0].d;
  assert.equal(points.length, 33);
  assert.deepEqual(points[0], petal.curves[0].a);
  assert.deepEqual(points.at(-1), petal.curves[1].d);
  assert.equal(points.filter(point => point.x === join.x && point.y === join.y).length, 1);
});
