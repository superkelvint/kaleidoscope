import { brushTextureCatalog } from "./brush-textures.js";
import { measure } from "./perf.js";

const TAU = Math.PI * 2;
const TEXTURE_DEBUG_FLAG = "__KALEIDOSCOPE_DEBUG_TEXTURE_BRUSH__";
const TEXTURE_GRADIENT_STEPS = 32;
const COMPOUND_PEN_EXPERIMENT_FLAG = "__KALEIDOSCOPE_EXPERIMENTAL_COMPOUND_PEN__";

function parseHexColor(color) {
  const value = typeof color === "string" ? color.trim() : "";
  const match = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(value);
  if (!match) return null;
  const hex = match[1];
  const expanded = hex.length === 3 ? [...hex].map(component => component + component).join("") : hex;
  return {
    r: Number.parseInt(expanded.slice(0, 2), 16),
    g: Number.parseInt(expanded.slice(2, 4), 16),
    b: Number.parseInt(expanded.slice(4, 6), 16)
  };
}

function hexComponent(value) {
  return Math.min(255, Math.max(0, Math.round(value))).toString(16).padStart(2, "0");
}

/** Returns the deterministic stroke color at a normalized path position. */
export function colorAtPathPosition(style, position) {
  if (style.colorMode !== "gradient") return style.color;
  const start = parseHexColor(style.startColor || style.color);
  const end = parseHexColor(style.endColor || style.color);
  if (!start || !end) return style.color;
  const amount = Math.min(1, Math.max(0, Number(position) || 0));
  return `#${hexComponent(start.r + (end.r - start.r) * amount)}${hexComponent(start.g + (end.g - start.g) * amount)}${hexComponent(start.b + (end.b - start.b) * amount)}`;
}

function withPaint(ctx, options, paint) {
  ctx.save();
  ctx.globalAlpha = options.opacity;
  ctx.fillStyle = options.color;
  paint();
  ctx.restore();
}

function roundStamp(ctx, point, radius) {
  ctx.beginPath();
  ctx.arc(point.x, point.y, radius, 0, TAU);
  ctx.fill();
}

function ribbonStamp(ctx, point, options) {
  const direction = options.tangent;
  const normal = { x: -direction.y, y: direction.x };
  const lines = Math.max(1, Math.round(options.lines));
  const span = Math.max(0, options.span);
  withPaint(ctx, options, () => {
    for (let index = 0; index < lines; index += 1) {
      const offset = lines === 1 ? 0 : (index / (lines - 1) - 0.5) * span;
      roundStamp(ctx, { x: point.x + normal.x * offset, y: point.y + normal.y * offset }, options.size / 2);
    }
  });
}

function calligraphyStamp(ctx, point, options) {
  const direction = options.tangent;
  withPaint(ctx, options, () => {
    ctx.translate(point.x, point.y);
    ctx.rotate(Math.atan2(direction.y, direction.x));
    ctx.beginPath();
    ctx.ellipse(0, 0, options.size / 2, options.size * options.nibRatio / 2, 0, 0, TAU);
    ctx.fill();
  });
}

function sprayStamp(ctx, point, options) {
  const radius = options.size / 2;
  const random = options.random || Math.random;
  withPaint(ctx, options, () => {
    for (let index = 0; index < options.density; index += 1) {
      const angle = random() * TAU;
      const distance = Math.sqrt(random()) * radius;
      roundStamp(ctx, {
        x: point.x + Math.cos(angle) * distance,
        y: point.y + Math.sin(angle) * distance
      }, options.particleSize / 2);
    }
  });
}

function penStamp(ctx, point, options) {
  withPaint(ctx, options, () => roundStamp(ctx, point, options.size / 2));
}

function textureStamp(ctx, point, options) {
  const tip = brushTextureCatalog.getTintedTip(options.textureId, options.color);
  if (!tip) return false;
  const largest = Math.max(tip.width, tip.height, 1);
  const scale = options.size / largest;
  const angle = options.rotationMode === "followStroke" && options.tangent
    ? Math.atan2(options.tangent.y, options.tangent.x)
    : 0;
  ctx.save();
  ctx.translate(point.x, point.y);
  ctx.rotate(angle);
  ctx.globalAlpha = options.opacity;
  ctx.drawImage(tip, -tip.width * scale / 2, -tip.height * scale / 2, tip.width * scale, tip.height * scale);
  ctx.restore();
  return true;
}

function heldStampCount(point) {
  const count = Math.floor(Number(point?.holdCount) || 0);
  return Math.max(0, count);
}

function immediateBrush(stamp) {
  return {
    begin(ctx, point, options) { stamp(ctx, point, options); },
    move(ctx, from, to, options) { stamp(ctx, to, options); },
    end() {}
  };
}

function directionalBrush(stamp) {
  return {
    begin() {},
    move(ctx, from, to, options) {
      if (options.tangent) stamp(ctx, to, options);
    },
    end() {}
  };
}

export const BRUSHES = {
  pen: immediateBrush(penStamp),
  ribbon: directionalBrush(ribbonStamp),
  calligraphy: directionalBrush(calligraphyStamp),
  spray: immediateBrush(sprayStamp),
  texture: immediateBrush(textureStamp)
};

/** A small deterministic generator for replaying a stored spray gesture. */
export function createSeededRandom(seed) {
  let value = (Number(seed) >>> 0) || 1;
  return () => {
    value += 0x6D2B79F5;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function tangentBetween(from, to, previous, maxDistance) {
  const x = to.x - from.x, y = to.y - from.y;
  const length = Math.hypot(x, y);
  if (Number.isFinite(x) && Number.isFinite(y) && length > 0.0001 && length <= maxDistance) return { x: x / length, y: y / length };
  return previous;
}

/** Whether replay can produce a mark for the stored path and brush style. */
export function canReplayBrushPath(points, style = {}) {
  if (!points?.length) return false;
  if (style.brush !== "ribbon" && style.brush !== "calligraphy") return true;
  const maxTangentDistance = Math.max(Number(style.size) * 6 || 0, 64);
  for (let index = 1; index < points.length; index += 1) {
    if (tangentBetween(points[index - 1], points[index], null, maxTangentDistance)) return true;
  }
  return false;
}

function hasNativePenStyle(options) {
  return options.brush === "pen" && options.taper !== "sine" && options.colorMode !== "gradient";
}

function canUseCompoundPen(options) {
  return hasNativePenStyle(options) && (Number(options.opacity) === 1 || globalThis[COMPOUND_PEN_EXPERIMENT_FLAG] === true);
}

function replayNativePenContours(ctx, contours, options) {
  let pathCount = 0;
  for (const contour of contours) if (contour.points.length > 1 && canReplayBrushPath(contour.points, options)) pathCount += 1;
  if (!pathCount) return false;
  measure("Native Pen replay", () => {
    ctx.save();
    ctx.globalAlpha = options.opacity;
    ctx.strokeStyle = options.color;
    ctx.lineWidth = options.size;
    ctx.lineCap = "round";
    ctx.lineJoin = "miter";
    ctx.miterLimit = 2;
    measure("Compound Pen path build", () => {
      ctx.beginPath();
      for (const contour of contours) {
        if (contour.points.length <= 1 || !canReplayBrushPath(contour.points, options)) continue;
        const first = contour.points[0];
        ctx.moveTo(first.x, first.y);
        for (let index = 1; index < contour.points.length; index += 1) {
          const point = contour.points[index];
          ctx.lineTo(point.x, point.y);
        }
        if (contour.closed) ctx.closePath();
      }
    });
    measure("Compound Pen stroke", () => ctx.stroke());
    ctx.restore();
  });
  return true;
}

/**
 * Replay a drawable's complete contour set. Brushes decide whether contours
 * can share a native Canvas path; callers never need generator-specific rules.
 */
export function replayBrushContours(ctx, contours, options) {
  if (!Array.isArray(contours) || !contours.length) return;
  if (canUseCompoundPen(options)) {
    replayNativePenContours(ctx, contours, options);
    // Canvas strokes do not deposit a visible cap for a one-point subpath.
    // Preserve the prior round-dab behavior for those rare degenerate paths.
    for (const contour of contours) if (contour.points.length === 1 && canReplayBrushPath(contour.points, options)) penStamp(ctx, contour.points[0], options);
    return;
  }
  for (const contour of contours) {
    if (canReplayBrushPath(contour.points, options)) replayBrushPath(ctx, contour.points, options, { closed: contour.closed });
  }
}

/**
 * Replay a stored source-space path. Unlike the immediate brush API above,
 * this contains no pointer timing: pen taper is a function only of path
 * position and Spray draws from the gesture's stored seed.
 */
export function replayBrushPath(ctx, points, options, { closed = false } = {}) {
  if (!points?.length) return;
  // A solid, untapered Pen has the same round-cap deposition as a native
  // Canvas stroke, without one save/path/fill per sampled point.
  if (hasNativePenStyle(options) && points.length > 1) {
    ctx.save();
    ctx.globalAlpha = options.opacity;
    ctx.strokeStyle = options.color;
    ctx.lineWidth = options.size;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index += 1) ctx.lineTo(points[index].x, points[index].y);
    if (closed) ctx.closePath();
    ctx.stroke();
    ctx.restore();
    return;
  }
  if (options.brush === "texture") {
    const startedAt = globalThis.performance?.now?.() ?? 0;
    let stampCount = 0;
    const spacing = Math.max(1, Number(options.size) * Math.min(1, Math.max(0.05, Number(options.spacing) || 0.25)));
    const maxSegmentDistance = Math.max(Number(options.size) * 6 || 0, 64);
    let totalDistance = 0;
    for (let index = 1; index < points.length; index += 1) {
      const distance = Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
      if (distance <= maxSegmentDistance) totalDistance += distance;
    }
    const stampOptions = (position, tangent) => {
      const normalized = totalDistance ? position / totalDistance : 0;
      // Gradient texture strokes use at most 32 tint cache entries per tip.
      const quantized = Math.round(Math.min(1, Math.max(0, normalized)) * TEXTURE_GRADIENT_STEPS) / TEXTURE_GRADIENT_STEPS;
      return { ...options, color: colorAtPathPosition(options, quantized), tangent };
    };
    let firstTangent = null;
    for (let index = 1; index < points.length; index += 1) {
      firstTangent = tangentBetween(points[index - 1], points[index], null, maxSegmentDistance);
      if (firstTangent) break;
    }
    if (textureStamp(ctx, points[0], stampOptions(0, firstTangent))) stampCount += 1;
    let distanceUntilStamp = spacing;
    let travelled = 0;
    for (let index = 1; index < points.length; index += 1) {
      const from = points[index - 1], next = points[index];
      const deltaX = next.x - from.x, deltaY = next.y - from.y;
      const distance = Math.hypot(deltaX, deltaY);
      if (distance < 0.0001) continue;
      if (distance > maxSegmentDistance) {
        // Source mapping can cross a wrap seam. Do not bridge it with stamps.
        distanceUntilStamp = spacing;
        continue;
      }
      const tangent = { x: deltaX / distance, y: deltaY / distance };
      let consumed = 0;
      while (distance - consumed >= distanceUntilStamp) {
        consumed += distanceUntilStamp;
        travelled += distanceUntilStamp;
        const stampPoint = { x: from.x + tangent.x * consumed, y: from.y + tangent.y * consumed };
        if (textureStamp(ctx, stampPoint, stampOptions(travelled, tangent))) stampCount += 1;
        distanceUntilStamp = spacing;
      }
      const remainder = distance - consumed;
      travelled += remainder;
      distanceUntilStamp -= remainder;
    }
    // Timed holds are stored separately from path samples: texture strokes
    // still use their normal distance-relative spacing while a stationary
    // pointer adds deliberate dabs at the point where it was held.
    for (let index = 0; index < points.length; index += 1) {
      const repeats = heldStampCount(points[index]);
      if (!repeats) continue;
      const tangent = index
        ? tangentBetween(points[index - 1], points[index], null, maxSegmentDistance)
        : firstTangent;
      const position = points.length === 1 ? 0 : totalDistance * index / (points.length - 1);
      const optionsAtPoint = stampOptions(position, tangent);
      for (let repeat = 0; repeat < repeats; repeat += 1) {
        if (textureStamp(ctx, points[index], optionsAtPoint)) stampCount += 1;
      }
    }
    if (globalThis[TEXTURE_DEBUG_FLAG]) {
      const elapsed = (globalThis.performance?.now?.() ?? startedAt) - startedAt;
      console.debug("[texture-brush]", { stamps: stampCount, milliseconds: Number(elapsed.toFixed(2)) });
    }
    return;
  }
  const replayOptions = { ...options };
  if (replayOptions.brush === "spray") replayOptions.random = createSeededRandom(replayOptions.seed);
  let previousTangent = null;
  const maxTangentDistance = Math.max(replayOptions.size * 6, 64);
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const t = points.length === 1 ? 0.5 : index / (points.length - 1);
    const tangent = index ? tangentBetween(points[index - 1], point, previousTangent, maxTangentDistance) : null;
    if (tangent) previousTangent = tangent;
    const stampOptions = {
      ...replayOptions,
      color: colorAtPathPosition(replayOptions, points.length === 1 ? 0 : t),
      tangent
    };
    if (replayOptions.brush === "pen") {
      // Geometric pen envelopes are based on normalized path position, never
      // pointer velocity or source-space segment length.
      if (replayOptions.taper === "sine") {
        const taper = Math.sin(Math.PI * t);
        stampOptions.size = replayOptions.size * (taper < 1e-12 ? 0 : taper);
      }
      penStamp(ctx, point, stampOptions);
    } else if (replayOptions.brush === "ribbon") {
      if (tangent) ribbonStamp(ctx, point, stampOptions);
    } else if (replayOptions.brush === "calligraphy") {
      if (tangent) calligraphyStamp(ctx, point, stampOptions);
    } else if (replayOptions.brush === "spray") {
      sprayStamp(ctx, point, stampOptions);
      for (let repeat = 0; repeat < heldStampCount(point); repeat += 1) {
        sprayStamp(ctx, point, stampOptions);
      }
    }
  }
}
