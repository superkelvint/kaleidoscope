import { brushTextureCatalog } from "./brush-textures.js";
import { measure } from "./perf.js";
import { renderFiberPath } from "./fiber-brush.js";
import { createWispLivePreview, measureWispPath, renderWispPath } from "./wisp-brush.js";
import { BrushPainter, toBrushPainter } from "./brush-painter.js";

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

function roundStamp(target, point, radius, options) { toBrushPainter(target).circle(point.x, point.y, radius, { color: options.color, opacity: options.opacity }); }

function ribbonStamp(target, point, options) {
  const direction = options.tangent;
  const normal = { x: -direction.y, y: direction.x };
  const lines = Math.max(1, Math.round(options.lines));
  const span = Math.max(0, options.span);
  for (let index = 0; index < lines; index += 1) {
    const offset = lines === 1 ? 0 : (index / (lines - 1) - 0.5) * span;
    roundStamp(target, { x: point.x + normal.x * offset, y: point.y + normal.y * offset }, options.size / 2, options);
  }
}

function calligraphyStamp(target, point, options) {
  const direction = options.tangent;
  toBrushPainter(target).ellipse(point.x, point.y, options.size / 2, options.size * options.nibRatio / 2, Math.atan2(direction.y, direction.x), { color: options.color, opacity: options.opacity });
}

function sprayStamp(target, point, options) {
  const radius = options.size / 2;
  const random = options.random || Math.random;
  for (let index = 0; index < options.density; index += 1) {
    const angle = random() * TAU, distance = Math.sqrt(random()) * radius;
    roundStamp(target, { x: point.x + Math.cos(angle) * distance, y: point.y + Math.sin(angle) * distance }, options.particleSize / 2, options);
  }
}

function penStamp(target, point, options) { roundStamp(target, point, options.size / 2, options); }

function textureStamp(target, point, options) {
  const tip = brushTextureCatalog.getTintedTip(options.textureId, options.color);
  if (!tip) return false;
  const largest = Math.max(tip.width, tip.height, 1);
  const scale = options.size / largest;
  const angle = options.rotationMode === "followStroke" && options.tangent
    ? Math.atan2(options.tangent.y, options.tangent.x)
    : 0;
  toBrushPainter(target).image(tip, point.x, point.y, tip.width * scale, tip.height * scale, angle, { opacity: options.opacity });
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
  texture: immediateBrush(textureStamp),
  fiber: { begin() {}, move() {}, end() {} },
  hair: { begin() {}, move() {}, end() {} },
  wisp: { begin() {}, move() {}, end() {} }
};

/** Stateful immediate-mode seam. Durable replay remains path based; this is
 * intentionally transient and preserves RNG/tangent continuity per session. */
export function createImmediateBrushSession(style = {}) {
  const brush = BRUSHES[style.brush];
  if (!brush || ["fiber", "hair", "wisp"].includes(style.brush)) return null;
  let previous = null, previousTangent = null, sampleCount = 0, travelled = 0, textureUntilStamp = 0;
  const random = style.brush === "spray" ? createSeededRandom(style.seed) : null;
  const maxTangentDistance = Math.max(Number(style.size) * 6 || 0, 64);
  const spacing = Math.max(1, Number(style.size) * Math.min(1, Math.max(.05, Number(style.spacing) || .25)));
  const livePosition = () => Math.min(1, travelled / Math.max(Number(style.size) * 24, 1));
  const optionsFor = tangent => ({ ...style, color: colorAtPathPosition(style, livePosition()), tangent, random });
  let delta = [];
  const target = new BrushPainter(instruction => delta.push(instruction));
  const paint = point => {
    const tangent = previous ? tangentBetween(previous, point, previousTangent, maxTangentDistance) : null;
    if (tangent) previousTangent = tangent;
    if (style.brush === "texture") {
      if (!previous) { textureStamp(target, point, optionsFor(tangent)); textureUntilStamp = spacing; }
      else {
        const dx = point.x - previous.x, dy = point.y - previous.y, distance = Math.hypot(dx, dy);
        if (tangent && distance <= maxTangentDistance) {
          let consumed = 0;
          while (distance - consumed >= textureUntilStamp) {
            consumed += textureUntilStamp; travelled += textureUntilStamp;
            textureStamp(target, { x: previous.x + tangent.x * consumed, y: previous.y + tangent.y * consumed }, optionsFor(tangent)); textureUntilStamp = spacing;
          }
          const remainder = distance - consumed; travelled += remainder; textureUntilStamp -= remainder;
        } else textureUntilStamp = spacing;
      }
    } else {
      const options = optionsFor(tangent);
      if (!previous) brush.begin(target, point, options);
      else { travelled += Math.hypot(point.x - previous.x, point.y - previous.y); brush.move(target, previous, point, optionsFor(tangent)); }
    }
    previous = { x: point.x, y: point.y }; sampleCount += 1;
  };
  const hold = (point, count) => {
    if (!previous || count <= 0) return;
    const options = optionsFor(previousTangent);
    for (let index = 0; index < count; index += 1) {
      if (style.brush === "texture") textureStamp(target, point, options);
      else brush.move(target, point, point, options);
    }
  };
  return {
    append: paint, hold,
    takeDelta() { const result = delta; delta = []; return result; },
    end() { brush.end(target, previous, style); },
    get previous() { return previous; }
  };
}

export function brushFootprint(style = {}) {
  const size = Math.max(0, Number(style.size) || 0);
  if (style.brush === "ribbon") return Math.max(0, Number(style.span) || 0) / 2 + size / 2;
  if (style.brush === "calligraphy") return Math.max(size, size * Math.max(0, Number(style.nibRatio) || 0)) / 2;
  if (style.brush === "spray") return size / 2 + Math.max(0, Number(style.particleSize) || 0) / 2;
  if (style.brush === "texture") return size * Math.SQRT2 / 2;
  if (style.brush === "fiber" || style.brush === "hair") return size * 5;
  return size / 2;
}

export function brushTextureId(style = {}) {
  return style.brush === "texture" && typeof style.textureId === "string" ? style.textureId : null;
}

export function needsStaticBrushCheckpoint(style = {}) {
  return style.brush === "fiber" || style.brush === "hair";
}

function transientBounds(point, style) {
  const pad = brushFootprint(style) + 2;
  return { left: point.x - pad, top: point.y - pad, right: point.x + pad, bottom: point.y + pad };
}

/**
 * Brush-neutral transient PaintSession renderer. It owns incremental brush
 * state and emits portable paint instructions; consumers only composite those
 * instructions into their destination material. `requiresBackdrop` describes
 * compositing needs without exposing a brush identity.
 */
export function createPaintSessionRenderer(drawable) {
  const styleFingerprint = JSON.stringify(drawable?.style || {});
  const acceptsStyle = style => JSON.stringify(style || {}) === styleFingerprint;
  const live = createLiveBrushPreview(drawable);
  if (live) return {
    acceptsStyle: style => live.acceptsStyle(style),
    advance(next, consumed = 0) {
      if (!live.advance(next.points.slice(consumed))) return [];
      const bounds = live.deltaBounds();
      if (!bounds) { live.finishDelta?.(); return []; }
      const instructions = [];
      live.paintDelta(new BrushPainter(instruction => instructions.push(instruction)));
      live.finishDelta?.();
      return instructions.length ? [{ instructions, bounds, requiresBackdrop: Boolean(live.requiresBackdrop) }] : [];
    },
    beginFinish: () => live.beginFinish?.(),
    settle() {
      if (!live.settle?.()) return [];
      const bounds = live.deltaBounds();
      if (!bounds) { live.finishDelta?.(); return []; }
      const instructions = [];
      live.paintDelta(new BrushPainter(instruction => instructions.push(instruction)));
      live.finishDelta?.();
      return instructions.length ? [{ instructions, bounds, requiresBackdrop: Boolean(live.requiresBackdrop) }] : [];
    },
    get isFinished() { return Boolean(live.isFinished); },
    get bounds() { return live.bounds; },
    reconstruct() {
      const bounds = live.bounds;
      if (!bounds) return [];
      const instructions = [];
      live.replay(new BrushPainter(instruction => instructions.push(instruction)));
      return instructions.length ? [{ instructions, bounds, requiresBackdrop: Boolean(live.requiresBackdrop) }] : [];
    },
    dispose: () => live.dispose?.()
  };

  const immediate = createImmediateBrushSession(drawable?.style);
  if (immediate) {
    let samples = 0, holds = [];
    const emit = (point, holdCount = 0) => {
      if (holdCount) immediate.hold(point, holdCount); else immediate.append(point);
      const instructions = immediate.takeDelta();
      return instructions.length ? [{ instructions, bounds: transientBounds(point, drawable.style), requiresBackdrop: false }] : [];
    };
    return {
      acceptsStyle,
      advance(next) {
        const batches = [];
        for (let index = samples; index < next.points.length; index += 1) batches.push(...emit(next.points[index]));
        for (let index = 0; index < next.points.length; index += 1) {
          const count = Math.max(0, Math.floor(Number(next.points[index].holdCount) || 0));
          if (count > (holds[index] || 0)) batches.push(...emit(next.points[index], count - (holds[index] || 0)));
          holds[index] = count;
        }
        samples = next.points.length;
        return batches;
      },
      beginFinish() {}, settle: () => [], get isFinished() { return true; }, get bounds() { return null; },
      reconstruct(current = drawable) {
        const rebuilt = createPaintSessionRenderer({ ...current, points: [] });
        return rebuilt.advance({ ...current, points: current.points.slice(0, samples).map((point, index) => ({ ...point, holdCount: holds[index] || 0 })) });
      },
      dispose() { immediate.end(); holds = []; }
    };
  }
  let consumed = 0;
  const emitReplay = next => {
    const points = next.points.slice(Math.max(0, consumed - 1));
    consumed = next.points.length;
    if (!points.length) return [];
    const instructions = [];
    replayBrushPath(new BrushPainter(instruction => instructions.push(instruction)), points, next.style);
    if (!instructions.length) return [];
    const pad = brushFootprint(next.style) + 2;
    const left = Math.min(...points.map(point => point.x)) - pad, right = Math.max(...points.map(point => point.x)) + pad;
    const top = Math.min(...points.map(point => point.y)) - pad, bottom = Math.max(...points.map(point => point.y)) + pad;
    return [{ instructions, bounds: { left, top, right, bottom }, requiresBackdrop: false }];
  };
  return {
    acceptsStyle,
    advance: emitReplay,
    beginFinish() {}, settle: () => [], get isFinished() { return true; }, get bounds() { return null; },
    reconstruct(current = drawable) {
      const rebuilt = createPaintSessionRenderer({ ...current, points: [] });
      return rebuilt.advance({ ...current, points: current.points.slice(0, consumed) });
    },
    dispose() {}
  };
}

/** Optional brush-neutral incremental preview seam. */
export function createLiveBrushPreview(drawable) {
  return drawable?.kind === "pathStroke" && drawable?.style?.brush === "wisp" ? createWispLivePreview(drawable) : null;
}

/** Compact brush replay metadata used by the rasterizer for culling/tiling. */
export function measureBrushReplay(drawable, { tail = true } = {}) {
  if (drawable?.kind === "pathStroke" && drawable?.style?.brush === "wisp") return measureWispPath(drawable.points, drawable.style, { tail });
  return null;
}

/** Stream a brush whose durable drawable does not first derive a contour path. */
export function renderBrushReplay(target, drawable, { tail = true } = {}) {
  if (drawable?.kind === "pathStroke" && drawable?.style?.brush === "wisp") return renderWispPath(target, drawable.points, drawable.style, { tail });
  return null;
}

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
  if (style.brush === "fiber" || style.brush === "hair") return points.length > 1;
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
  if (!(ctx instanceof BrushPainter) && canUseCompoundPen(options)) {
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
  if (options.brush === "fiber" || options.brush === "hair") {
    renderFiberPath(ctx, points, options, { preview: options.preview === true });
    return;
  }
  if (options.brush === "wisp") {
    renderWispPath(ctx, points, options, { tail: options.preview !== true });
    return;
  }
  // A solid, untapered Pen has the same round-cap deposition as a native
  // Canvas stroke, without one save/path/fill per sampled point.
  if (hasNativePenStyle(options) && points.length > 1 && ctx instanceof BrushPainter) {
    ctx.polyline(points, { color: options.color, opacity: options.opacity, width: options.size, cap: "round", join: "round", closed });
    return;
  }
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
