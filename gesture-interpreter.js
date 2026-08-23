// Deterministic, display-space gesture interpretation. This module deliberately
// has no knowledge of Canvas, renderer state, or source pixels.
export const TAU = Math.PI * 2;

export const ARC_SAMPLE_COUNT = 24;
export const PETAL_SAMPLE_COUNT = 32;
export const BOUNDARY_SNAP_DISTANCE = 20;
export const STRONG_CLOSE_DISTANCE_RATIO = 0.35;
export const MODERATE_CLOSE_DISTANCE_RATIO = 0.65;
export const PETAL_MIN_ABSOLUTE_TURNING = Math.PI;

function pointOf(point) {
  return { x: Number(point.x ?? point.clientX), y: Number(point.y ?? point.clientY) };
}

function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function lerp(a, b, amount) {
  return { x: a.x + (b.x - a.x) * amount, y: a.y + (b.y - a.y) * amount };
}

function cubic(a, b, c, d, amount) {
  const inverse = 1 - amount;
  return {
    x: inverse ** 3 * a.x + 3 * inverse ** 2 * amount * b.x + 3 * inverse * amount ** 2 * c.x + amount ** 3 * d.x,
    y: inverse ** 3 * a.y + 3 * inverse ** 2 * amount * b.y + 3 * inverse * amount ** 2 * c.y + amount ** 3 * d.y
  };
}

function resample(points, count) {
  if (points.length <= count) return points.map(point => ({ ...point }));
  const lengths = [0];
  for (let index = 1; index < points.length; index += 1) lengths.push(lengths[index - 1] + distance(points[index - 1], points[index]));
  const total = lengths.at(-1);
  if (total <= 0.0001) return [points[0]];
  const result = [];
  let segment = 1;
  for (let index = 0; index < count; index += 1) {
    const target = total * index / (count - 1);
    while (segment < lengths.length - 1 && lengths[segment] < target) segment += 1;
    const startLength = lengths[segment - 1];
    const span = lengths[segment] - startLength;
    result.push(lerp(points[segment - 1], points[segment], span > 0 ? (target - startLength) / span : 0));
  }
  return result;
}

/** Remove tiny pointer noise, reduce to a fixed budget, then lightly smooth. */
export function preprocessGesture(samples, maxSamples = 64) {
  const distinct = [];
  for (const sample of samples || []) {
    const point = pointOf(sample);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    if (!distinct.length || distance(distinct.at(-1), point) >= 0.75) distinct.push(point);
  }
  const bounded = resample(distinct, Math.max(2, maxSamples));
  if (bounded.length < 3) return bounded;
  return bounded.map((point, index) => {
    if (index === 0 || index === bounded.length - 1) return point;
    return {
      x: (bounded[index - 1].x + point.x * 2 + bounded[index + 1].x) / 4,
      y: (bounded[index - 1].y + point.y * 2 + bounded[index + 1].y) / 4
    };
  });
}

export function normalizeAngle(angle) {
  return ((angle % TAU) + TAU) % TAU;
}

function signedAngleDelta(from, to) {
  return ((to - from + Math.PI) % TAU + TAU) % TAU - Math.PI;
}

export function accumulatedAbsoluteTurning(points) {
  let total = 0;
  let previousAngle = null;
  for (let index = 1; index < points.length; index += 1) {
    const dx = points[index].x - points[index - 1].x;
    const dy = points[index].y - points[index - 1].y;
    if (Math.hypot(dx, dy) <= 0.0001) continue;
    const angle = Math.atan2(dy, dx);
    if (previousAngle !== null) total += Math.abs(signedAngleDelta(previousAngle, angle));
    previousAngle = angle;
  }
  return total;
}

function snapOrientation(angle, segments) {
  const step = TAU / Math.max(2, Number(segments) || 2) / 4;
  return Math.round(angle / step) * step;
}

function pcaOrientation(points) {
  const center = points.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 });
  center.x /= points.length;
  center.y /= points.length;
  let xx = 0, yy = 0, xy = 0;
  for (const point of points) {
    const x = point.x - center.x, y = point.y - center.y;
    xx += x * x; yy += y * y; xy += x * y;
  }
  return 0.5 * Math.atan2(2 * xy, xx - yy);
}

function gestureMetrics(points, segments, rawOrientation) {
  const center = points.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 });
  center.x /= points.length;
  center.y /= points.length;
  const orientation = snapOrientation(rawOrientation, segments);
  const axis = { x: Math.cos(orientation), y: Math.sin(orientation) };
  const normal = { x: -axis.y, y: axis.x };
  let minAxis = Infinity, maxAxis = -Infinity, minNormal = Infinity, maxNormal = -Infinity;
  for (const point of points) {
    const x = point.x - center.x, y = point.y - center.y;
    const along = x * axis.x + y * axis.y;
    const across = x * normal.x + y * normal.y;
    minAxis = Math.min(minAxis, along); maxAxis = Math.max(maxAxis, along);
    minNormal = Math.min(minNormal, across); maxNormal = Math.max(maxNormal, across);
  }
  const first = points[0], last = points.at(-1);
  const midpoint = points[Math.floor(points.length / 2)];
  const signedCurve = (last.x - first.x) * (midpoint.y - first.y) - (last.y - first.y) * (midpoint.x - first.x);
  return {
    center, orientation, axis, normal,
    length: Math.max(1, maxAxis - minAxis),
    width: Math.max(1, maxNormal - minNormal),
    handedness: signedCurve < 0 ? -1 : 1
  };
}

export function mirrorWedgeEligible({ symmetryMode, mirror } = {}) {
  return (symmetryMode === "radial" && Boolean(mirror)) || symmetryMode === "mirrorRadial" || symmetryMode === "spiral";
}

export function nearestMirrorBoundary(point, center, segments) {
  const step = TAU / Math.max(2, Number(segments) || 2) / 2;
  const angle = Math.atan2(point.y - center.y, point.x - center.x);
  const boundaryAngle = normalizeAngle(Math.round(angle / step) * step);
  return {
    angle: boundaryAngle,
    ray: { x: Math.cos(boundaryAngle), y: Math.sin(boundaryAngle) }
  };
}

export function projectOntoRay(point, center, ray) {
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const forward = dx * ray.x + dy * ray.y;
  const projected = { x: center.x + ray.x * forward, y: center.y + ray.y * forward };
  return {
    forward,
    perpendicularDistance: distance(point, projected),
    point: projected
  };
}

export function mirrorBoundaryFrame(point, context) {
  const center = context?.center;
  if (!mirrorWedgeEligible(context) || !center || !Number.isFinite(center.x) || !Number.isFinite(center.y)) return { attached: false, boundaryAngle: null };
  const boundary = nearestMirrorBoundary(point, center, context.segments);
  const projection = projectOntoRay(point, center, boundary.ray);
  return {
    attached: projection.forward > 0 && projection.perpendicularDistance <= BOUNDARY_SNAP_DISTANCE,
    boundaryAngle: boundary.angle,
    ray: boundary.ray,
    normal: { x: -boundary.ray.y, y: boundary.ray.x },
    ...projection
  };
}

function handleLength(metrics) {
  return Math.min(80, Math.max(8, metrics.length * 0.28));
}

function signedNormalHandle(normal, preferred, length) {
  const sign = preferred.x * normal.x + preferred.y * normal.y < 0 ? -1 : 1;
  return { x: normal.x * length * sign, y: normal.y * length * sign };
}

function makeArc(metrics, context) {
  const { center, axis, normal, length, width, handedness } = metrics;
  const start = { x: center.x - axis.x * length / 2, y: center.y - axis.y * length / 2 };
  const end = { x: center.x + axis.x * length / 2, y: center.y + axis.y * length / 2 };
  const bend = Math.max(width, length * 0.2) * handedness;
  const controlA = { x: start.x + normal.x * bend, y: start.y + normal.y * bend };
  const controlB = { x: end.x + normal.x * bend, y: end.y + normal.y * bend };
  const startBoundary = mirrorBoundaryFrame(start, context);
  const endBoundary = mirrorBoundaryFrame(end, context);
  const handle = handleLength(metrics);
  if (startBoundary.attached) {
    const original = { x: controlA.x - start.x, y: controlA.y - start.y };
    Object.assign(start, startBoundary.point);
    const offset = signedNormalHandle(startBoundary.normal, original, handle);
    Object.assign(controlA, { x: start.x + offset.x, y: start.y + offset.y });
  }
  if (endBoundary.attached) {
    const original = { x: end.x - controlB.x, y: end.y - controlB.y };
    Object.assign(end, endBoundary.point);
    const offset = signedNormalHandle(endBoundary.normal, original, handle);
    Object.assign(controlB, { x: end.x - offset.x, y: end.y - offset.y });
  }
  const curves = [{ a: start, b: controlA, c: controlB, d: end }];
  return { curves, points: sampleCurves(curves, ARC_SAMPLE_COUNT), boundary: { start: startBoundary, end: endBoundary } };
}

function makePetal(metrics, context) {
  const { center, axis, normal, length, width, handedness } = metrics;
  const left = { x: center.x - axis.x * length / 2, y: center.y - axis.y * length / 2 };
  const right = { x: center.x + axis.x * length / 2, y: center.y + axis.y * length / 2 };
  const bend = Math.max(width, length * 0.12) * handedness;
  const upperA = { x: left.x + normal.x * bend, y: left.y + normal.y * bend };
  const upperB = { x: right.x + normal.x * bend, y: right.y + normal.y * bend };
  const lowerA = { x: right.x - normal.x * bend, y: right.y - normal.y * bend };
  const lowerB = { x: left.x - normal.x * bend, y: left.y - normal.y * bend };
  const leftBoundary = mirrorBoundaryFrame(left, context);
  const rightBoundary = mirrorBoundaryFrame(right, context);
  const handle = handleLength(metrics);
  if (leftBoundary.attached) {
    const preferred = { x: upperA.x - left.x, y: upperA.y - left.y };
    Object.assign(left, leftBoundary.point);
    const offset = signedNormalHandle(leftBoundary.normal, preferred, handle);
    Object.assign(upperA, { x: left.x + offset.x, y: left.y + offset.y });
    Object.assign(lowerB, { x: left.x - offset.x, y: left.y - offset.y });
  }
  if (rightBoundary.attached) {
    const preferred = { x: right.x - upperB.x, y: right.y - upperB.y };
    Object.assign(right, rightBoundary.point);
    const offset = signedNormalHandle(rightBoundary.normal, preferred, handle);
    Object.assign(upperB, { x: right.x - offset.x, y: right.y - offset.y });
    Object.assign(lowerA, { x: right.x + offset.x, y: right.y + offset.y });
  }
  const curves = [
    { a: left, b: upperA, c: upperB, d: right },
    { a: right, b: lowerA, c: lowerB, d: left }
  ];
  return { curves, points: sampleCurves(curves, PETAL_SAMPLE_COUNT), boundary: { start: leftBoundary, end: rightBoundary } };
}

function sampleCurves(curves, count) {
  if (curves.length === 1) {
    const [curve] = curves;
    return Array.from({ length: count }, (_, index) => cubic(curve.a, curve.b, curve.c, curve.d, index / (count - 1)));
  }
  if (count <= 2) return [curves[0].a, curves.at(-1).d].slice(0, count).map(point => ({ ...point }));
  const firstCount = Math.floor((count + 1) / 2);
  const secondCount = count - firstCount + 1;
  const first = Array.from({ length: firstCount }, (_, index) => {
    const curve = curves[0];
    return cubic(curve.a, curve.b, curve.c, curve.d, index / (firstCount - 1));
  });
  const second = Array.from({ length: secondCount - 1 }, (_, index) => {
    const curve = curves[1];
    return cubic(curve.a, curve.b, curve.c, curve.d, (index + 1) / (secondCount - 1));
  });
  return [...first, ...second];
}

/** Sample the same canonical Béziers more densely without changing their shape. */
export function sampleCanonicalGesture(gesture, sampleCount) {
  const count = Math.max(2, Math.floor(sampleCount));
  const curves = gesture.curves || [];
  if (!curves.length) return gesture.points?.map(point => ({ ...point })) || [];
  return sampleCurves(curves, count);
}

/** Produce compact, canonical display-space geometry, or null for a click/tap. */
export function interpretGesture(samples, context = {}) {
  const { segments = 12 } = context;
  const points = preprocessGesture(samples);
  if (points.length < 2) return null;
  const minX = Math.min(...points.map(point => point.x)), maxX = Math.max(...points.map(point => point.x));
  const minY = Math.min(...points.map(point => point.y)), maxY = Math.max(...points.map(point => point.y));
  const diagonal = Math.hypot(maxX - minX, maxY - minY);
  if (diagonal < 6) return null;
  const endpointDistance = distance(points[0], points.at(-1));
  const turning = accumulatedAbsoluteTurning(points);
  const closed = endpointDistance <= diagonal * STRONG_CLOSE_DISTANCE_RATIO || (
    endpointDistance <= diagonal * MODERATE_CLOSE_DISTANCE_RATIO && turning >= PETAL_MIN_ABSOLUTE_TURNING
  );
  const chord = { x: points.at(-1).x - points[0].x, y: points.at(-1).y - points[0].y };
  const rawOrientation = closed ? pcaOrientation(points) : Math.atan2(chord.y, chord.x);
  const metrics = gestureMetrics(points, segments, rawOrientation);
  const geometry = closed ? makePetal(metrics, context) : makeArc(metrics, context);
  return {
    primitive: closed ? "petal" : "arc",
    ...geometry,
    ...metrics,
    endpointAttachments: geometry.boundary,
    accumulatedTurning: turning
  };
}
