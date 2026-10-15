// Geometry is deliberately pure.  Its frames are prefix stable: adding input
// samples never changes a frame that has already been returned.
const EPSILON = 1e-6;
const finitePoint = point => Number.isFinite(Number(point?.x)) && Number.isFinite(Number(point?.y));
const clonePoint = point => ({ x: Number(point.x), y: Number(point.y) });

function tangent(previous, point, fallback = { x: 1, y: 0 }) {
  const dx = point.x - previous.x, dy = point.y - previous.y;
  const length = Math.hypot(dx, dy);
  return length > EPSILON ? { x: dx / length, y: dy / length } : fallback;
}

/**
 * Derive a causal frame from input points. `sampling: "distance"` is the
 * fixed-distance mode formerly embedded in Fiber V2; `input` preserves each
 * meaningful input point.  The final frame only looks backwards.
 */
export function deriveStrokeFrame(input = [], { sampling = "input", spacing = 1, smoothing = 0, closed = false } = {}) {
  const raw = input.filter(finitePoint).map(clonePoint);
  if (!raw.length) return { points: [], closed: false };
  const samples = [raw[0]];
  if (sampling === "distance") {
    const step = Math.max(EPSILON, Number(spacing) || 1);
    let anchor = raw[0], carry = 0;
    for (let index = 1; index < raw.length; index += 1) {
      const end = raw[index], dx = end.x - anchor.x, dy = end.y - anchor.y, length = Math.hypot(dx, dy);
      if (length <= EPSILON) continue;
      let used = 0;
      while (length - used + carry >= step) {
        const advance = step - carry; used += advance;
        samples.push({ x: anchor.x + dx * used / length, y: anchor.y + dy * used / length });
        carry = 0;
      }
      carry += length - used; anchor = end;
    }
    // Do not append a provisional final endpoint: when more input arrives it
    // would move, violating the frame's prefix-stability contract. Consumers
    // that need an immediate input tip use `sampling: "input"`.
  } else {
    for (const point of raw.slice(1)) {
      const last = samples.at(-1);
      if (Math.hypot(point.x - last.x, point.y - last.y) > EPSILON) samples.push(point);
    }
  }
  if (closed && samples.length > 2 && Math.hypot(samples[0].x - samples.at(-1).x, samples[0].y - samples.at(-1).y) <= EPSILON) samples.pop();
  if (closed && samples.length > 2) {
    let arcLength = 0;
    return {
      closed: true,
      points: samples.map((point, index) => {
        const previous = samples[(index - 1 + samples.length) % samples.length], next = samples[(index + 1) % samples.length];
        const incoming = tangent(previous, point), outgoing = tangent(point, next, incoming);
        const tangentX = incoming.x + outgoing.x, tangentY = incoming.y + outgoing.y, magnitude = Math.hypot(tangentX, tangentY) || 1;
        const segment = index ? Math.hypot(point.x - previous.x, point.y - previous.y) : 0;
        if (index) arcLength += segment;
        const turn = Math.atan2(incoming.x * outgoing.y - incoming.y * outgoing.x, incoming.x * outgoing.x + incoming.y * outgoing.y);
        const localLength = (Math.hypot(point.x - previous.x, point.y - previous.y) + Math.hypot(next.x - point.x, next.y - point.y)) / 2 || 1;
        return { x: point.x, y: point.y, arcLength, tangentX: tangentX / magnitude, tangentY: tangentY / magnitude, normalX: -tangentY / magnitude, normalY: tangentX / magnitude, curvature: turn / localLength };
      })
    };
  }
  const alpha = Math.min(.999, Math.max(0, Number(smoothing) || 0));
  const points = [];
  let arcLength = 0, previousTangent = { x: 1, y: 0 }, previousPoint = samples[0];
  for (let index = 0; index < samples.length; index += 1) {
    const source = samples[index];
    const point = index ? {
      x: previousPoint.x + (source.x - previousPoint.x) * (1 - alpha),
      y: previousPoint.y + (source.y - previousPoint.y) * (1 - alpha)
    } : source;
    const segment = index ? Math.hypot(point.x - previousPoint.x, point.y - previousPoint.y) : 0;
    const nextTangent = index ? tangent(previousPoint, point, previousTangent) : previousTangent;
    const turn = index ? Math.atan2(previousTangent.x * nextTangent.y - previousTangent.y * nextTangent.x, previousTangent.x * nextTangent.x + previousTangent.y * nextTangent.y) : 0;
    arcLength += segment;
    points.push({ x: point.x, y: point.y, arcLength, tangentX: nextTangent.x, tangentY: nextTangent.y, normalX: -nextTangent.y, normalY: nextTangent.x, curvature: segment > EPSILON ? turn / segment : 0 });
    previousPoint = point; previousTangent = nextTangent;
  }
  return { points, closed: false };
}

/** Converts a durable geometry recipe and its input into transient paths. */
export function deriveStrokeGeometry(recipe = {}, context = {}) {
  const type = recipe.type || recipe.geometry || "freehand";
  const points = context.points || context.gesture?.points || [];
  const frame = deriveStrokeFrame(points, { ...(recipe.frame || recipe), closed: Boolean(recipe.closed) });
  // Transitional geometries retain their specialized painter algorithms. The
  // shared frame remains useful to materials and tooling without duplicating
  // their mechanics here.
  return { paths: [{ frame, metadata: { type } }], instances: [{ x: 0, y: 0 }] };
}

/** Fiber V2's established fixed-distance causal flow frame. Kept here so the
 * specialized material and general geometry layer share one implementation. */
export function deriveFiberCompatibleFrame(points = [], { spacing = 6, maxSamples = 384 } = {}) {
  if (!Array.isArray(points) || points.length < 2) return [];
  const distances = [0];
  for (let index = 1; index < points.length; index += 1) distances.push(distances[index - 1] + Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y));
  const length = distances.at(-1); if (length < .01) return [];
  const count = Math.min(maxSamples, Math.max(2, Math.floor(length / spacing) + 1)), raw = [];
  let cursor = 1;
  for (let index = 0; index < count; index += 1) {
    const arcLength = index * spacing;
    while (cursor < distances.length - 1 && distances[cursor] < arcLength) cursor += 1;
    const before = cursor - 1, span = distances[cursor] - distances[before] || 1, ratio = Math.min(1, Math.max(0, (arcLength - distances[before]) / span));
    raw.push({ x: points[before].x + (points[cursor].x - points[before].x) * ratio, y: points[before].y + (points[cursor].y - points[before].y) * ratio, arcLength });
  }
  const path = raw.map((point, index) => { const prior = raw[Math.max(0, index - 1)], prior2 = raw[Math.max(0, index - 2)]; return { x: index < 2 ? point.x : point.x * .58 + prior.x * .30 + prior2.x * .12, y: index < 2 ? point.y : point.y * .58 + prior.y * .30 + prior2.y * .12, arcLength: point.arcLength, t: point.arcLength / Math.max(spacing, raw.at(-1).arcLength) }; });
  const angles = [];
  for (let index = 0; index < path.length; index += 1) { const before = path[Math.max(0, index - 4)], after = path[index], dx = after.x - before.x, dy = after.y - before.y, magnitude = Math.hypot(dx, dy) || 1; path[index].tangentX = dx / magnitude; path[index].tangentY = dy / magnitude; path[index].normalX = -dy / magnitude; path[index].normalY = dx / magnitude; angles.push(Math.atan2(dy, dx)); }
  path[0].tangentX = path[1].tangentX; path[0].tangentY = path[1].tangentY; path[0].normalX = path[1].normalX; path[0].normalY = path[1].normalY;
  const curvature = angles.map((angle, index) => { if (!index) return 0; let delta = angle - angles[Math.max(0, index - 3)]; while (delta > Math.PI) delta -= Math.PI * 2; while (delta < -Math.PI) delta += Math.PI * 2; return Math.min(1, Math.abs(delta) / .85); });
  for (let index = 0; index < path.length; index += 1) { let total = 0, weight = 0; for (let cursorIndex = Math.max(0, index - 4); cursorIndex <= index; cursorIndex += 1) { const w = cursorIndex === index ? 3 : 1; total += curvature[cursorIndex] * w; weight += w; } path[index].curvature = Math.min(1, Math.max(0, total / weight)); }
  return path;
}

/** Incremental counterpart of the open frame derivation. Keeps only sampling
 * carry and the previous frame; material simulations never own geometry math. */
export function createStrokeFrameSession({ sampling = "input", spacing = 1, smoothing = 0 } = {}) {
  const step = Math.max(EPSILON, Number(spacing) || 1), alpha = Math.min(.999, Math.max(0, Number(smoothing) || 0));
  let anchor = null, previousSample = null, previousFrame = null, carry = 0;
  const frame = source => {
    if (previousSample && Math.hypot(source.x - previousSample.x, source.y - previousSample.y) <= EPSILON) return null;
    const point = previousFrame ? { x: previousFrame.x + (source.x - previousFrame.x) * (1 - alpha), y: previousFrame.y + (source.y - previousFrame.y) * (1 - alpha) } : source;
    const fallback = previousFrame ? { x: previousFrame.tangentX, y: previousFrame.tangentY } : { x: 1, y: 0 };
    const direction = previousFrame ? tangent(previousFrame, point, fallback) : fallback;
    const distance = previousFrame ? Math.hypot(point.x - previousFrame.x, point.y - previousFrame.y) : 0;
    const turn = Math.atan2(fallback.x * direction.y - fallback.y * direction.x, fallback.x * direction.x + fallback.y * direction.y);
    previousSample = source;
    previousFrame = { ...point, arcLength: (previousFrame?.arcLength || 0) + distance, tangentX: direction.x, tangentY: direction.y, normalX: -direction.y, normalY: direction.x, curvature: distance > EPSILON ? turn / distance : 0 };
    return previousFrame;
  };
  return { append(input) {
    if (!finitePoint(input)) return [];
    const point = clonePoint(input), result = [];
    if (!anchor) { anchor = point; return [frame(point)]; }
    if (sampling !== "distance") { const next = frame(point); return next ? [next] : []; }
    const dx = point.x - anchor.x, dy = point.y - anchor.y, length = Math.hypot(dx, dy);
    if (length <= EPSILON) return [];
    let used = 0;
    while (length - used + carry >= step) {
      used += step - carry; carry = 0;
      const next = frame({ x: anchor.x + dx * used / length, y: anchor.y + dy * used / length });
      if (next) result.push(next);
    }
    carry += length - used; anchor = point;
    return result;
  } };
}
