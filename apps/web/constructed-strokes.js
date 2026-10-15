const TAU = Math.PI * 2;

function point(x, y) { return { x, y }; }
function lerp(a, b, amount) { return a + (b - a) * amount; }
function distance(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }
function positiveAngle(angle) { return ((angle % TAU) + TAU) % TAU; }

/**
 * Samples the circle through start, end, and bend. Collinear points have no
 * finite circumcircle, so they deliberately degrade to a straight segment.
 */
export function sampleCircularArc(start, end, bend, { sampleCount = 64 } = {}) {
  const cross = 2 * (start.x * (end.y - bend.y) + end.x * (bend.y - start.y) + bend.x * (start.y - end.y));
  const count = Math.max(2, Math.floor(sampleCount));
  if (Math.abs(cross) < 1e-8) {
    return {
      points: Array.from({ length: count }, (_, index) => point(lerp(start.x, end.x, index / (count - 1)), lerp(start.y, end.y, index / (count - 1)))),
      guides: { center: null, radius: null, fallback: "line" }
    };
  }
  const startSquared = start.x ** 2 + start.y ** 2;
  const endSquared = end.x ** 2 + end.y ** 2;
  const bendSquared = bend.x ** 2 + bend.y ** 2;
  const center = point(
    (startSquared * (end.y - bend.y) + endSquared * (bend.y - start.y) + bendSquared * (start.y - end.y)) / cross,
    (startSquared * (bend.x - end.x) + endSquared * (start.x - bend.x) + bendSquared * (end.x - start.x)) / cross
  );
  const radius = distance(center, start);
  const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
  const endAngle = Math.atan2(end.y - center.y, end.x - center.x);
  const bendAngle = Math.atan2(bend.y - center.y, bend.x - center.x);
  const counterclockwiseSweep = positiveAngle(endAngle - startAngle);
  const bendCounterclockwise = positiveAngle(bendAngle - startAngle);
  const sweep = bendCounterclockwise <= counterclockwiseSweep + 1e-8
    ? counterclockwiseSweep
    : -(TAU - counterclockwiseSweep);
  return {
    points: Array.from({ length: count }, (_, index) => {
      if (index === 0) return point(start.x, start.y);
      if (index === count - 1) return point(end.x, end.y);
      const angle = startAngle + sweep * index / (count - 1);
      return point(center.x + Math.cos(angle) * radius, center.y + Math.sin(angle) * radius);
    }),
    guides: { center, radius, sweep, fallback: null }
  };
}

/** Samples a cubic Bézier in display space for future constructed tools. */
export function sampleCubicBezier(start, end, handleStart, handleEnd, { sampleCount = 64 } = {}) {
  const count = Math.max(2, Math.floor(sampleCount));
  return {
    points: Array.from({ length: count }, (_, index) => {
      const t = index / (count - 1);
      const inverse = 1 - t;
      return point(
        inverse ** 3 * start.x + 3 * inverse ** 2 * t * handleStart.x + 3 * inverse * t ** 2 * handleEnd.x + t ** 3 * end.x,
        inverse ** 3 * start.y + 3 * inverse ** 2 * t * handleStart.y + 3 * inverse * t ** 2 * handleEnd.y + t ** 3 * end.y
      );
    }),
    guides: { center: null, radius: null, fallback: null }
  };
}
