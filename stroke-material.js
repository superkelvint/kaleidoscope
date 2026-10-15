import { BrushPainter, toBrushPainter } from "./brush-painter.js";
import { interpolateHcl } from "./brush-material.js";
import { createStrokeFrameSession } from "./stroke-geometry.js";

const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));
const bound = (points, pad) => {
  if (!points?.length) return null;
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const point of points) { left = Math.min(left, point.x); top = Math.min(top, point.y); right = Math.max(right, point.x); bottom = Math.max(bottom, point.y); }
  return { left: left - pad, top: top - pad, right: right + pad, bottom: bottom + pad };
};
const materialStyle = material => ({ color: material.color || "#ffffff", opacity: clamp(material.opacity ?? 1), width: Math.max(.1, Number(material.width ?? material.size) || 1), composite: material.composite || "source-over" });
const spine = frame => frame.points.map(({ x, y }) => ({ x, y }));
const finiteOr = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const mulberry32 = seed => () => {
  let value = seed += 0x6D2B79F5;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
};
const rgb = color => {
  const match = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(String(color || ""));
  if (!match) {
    const channels = /^rgb\(\s*(\d+)[, ]+\s*(\d+)[, ]+\s*(\d+)\s*\)$/.exec(String(color));
    return channels ? { r: Number(channels[1]), g: Number(channels[2]), b: Number(channels[3]) } : { r: 255, g: 255, b: 255 };
  }
  const value = match[1].length === 3 ? [...match[1]].map(channel => channel + channel).join("") : match[1];
  return { r: Number.parseInt(value.slice(0, 2), 16), g: Number.parseInt(value.slice(2, 4), 16), b: Number.parseInt(value.slice(4, 6), 16) };
};
const mixRgb = (from, to, amount) => ({ r: Math.round(from.r + (to.r - from.r) * amount), g: Math.round(from.g + (to.g - from.g) * amount), b: Math.round(from.b + (to.b - from.b) * amount) });
const cssRgb = color => `rgb(${color.r} ${color.g} ${color.b})`;
const silkParameters = (material, style) => ({
  strands: Math.max(0, Math.round(finiteOr(material.strands, 8))),
  spread: Math.max(0, finiteOr(material.spread, style.width * 1.5)),
  wander: Math.max(0, finiteOr(material.wander, .25)),
  glow: clamp(finiteOr(material.glow, .18)),
  pull: Math.max(.001, finiteOr(material.pull, .06)),
  drag: Math.min(.995, Math.max(.85, finiteOr(material.drag, .95)))
});

function ink(painter, geometry, material) {
  const style = materialStyle(material);
  for (const path of geometry.paths || []) {
    const points = spine(path.frame);
    if (points.length > 1) painter.polyline(points, { ...style, cap: "round", join: "round", closed: path.frame.closed, incremental: !path.frame.closed });
    else if (points.length === 1) painter.circle(points[0].x, points[0].y, style.width / 2, style);
  }
}
function createSilkPath(painter, material, context, pathIndex = 0, closed = false) {
  const style = materialStyle(material), recipe = silkParameters(material, style), seed = Number(context.seed ?? material.seed) >>> 0;
  const palette = material.options || material, hot = { r: 220, g: 246, b: 255 };
  let base = rgb(style.color), spineColor = style.color;
  const random = mulberry32(seed + pathIndex * 0x9e3779b9);
  const fibers = Array.from({ length: Math.max(1, recipe.strands) }, (_, index) => {
    const t = recipe.strands <= 1 ? 0 : index / (recipe.strands - 1), centered = (t - .5) * 2;
    const highlight = index === 0 || index === Math.floor(recipe.strands * .45) || index === Math.floor(recipe.strands * .52) || index === Math.floor(recipe.strands * .58);
    return { offset: index === 0 ? 0 : Math.sign(centered) * Math.abs(centered) ** 1.15 * recipe.spread * .55 + (random() * 2 - 1) * recipe.spread * .08, pull: recipe.pull * (.85 + random() * .5), drag: recipe.drag * (.985 + random() * .012), rigidity: .10 + random() * .18, alpha: highlight ? .028 + random() * .028 : .004 + random() ** 2.7 * .018, width: highlight ? .75 + random() * .65 : .28 + random() * .5, glow: highlight || random() < .10, points: [] };
  });
  const emit = fiber => {
    if (fiber.points.length < 2) return;
    const tail = fiber.points.at(-1), velocity = Math.hypot(tail.inputVx || 0, tail.inputVy || 0), energy = clamp((velocity - 2) / 18);
    const color = mixRgb(base, hot, fiber.glow ? .30 + energy * .5 : .12 + energy * .22);
    painter.polyline(fiber.points, { color: cssRgb(color), opacity: style.opacity * fiber.alpha * (.25 + recipe.glow * .75), width: fiber.width, composite: "lighter", cap: "round", join: "round", closed });
  };
  const step = () => {
    let alive = false;
    for (const fiber of fibers) {
      const curve = fiber.points;
      while (curve.length && curve[0].life <= 0) curve.shift();
      if (curve.length) alive = true;
      for (let index = 0; index < curve.length; index += 1) {
        const point = curve[index];
        let ax = (point.homeX - point.x) * fiber.pull + point.inputVx * .18, ay = (point.homeY - point.y) * fiber.pull + point.inputVy * .18;
        if (point.inputVx && point.inputVy) { point.inputVx *= .985; point.inputVy *= .985; }
        const oldX = point.x, oldY = point.y;
        point.x += (point.x - point.px) * fiber.drag + ax; point.y += (point.y - point.py) * fiber.drag + ay;
        point.px = oldX; point.py = oldY; point.life -= 1;
        if (index) {
          const prior = curve[index - 1], dx = prior.x - point.x, dy = prior.y - point.y, length = Math.hypot(dx, dy);
          if (length > .0001) { const force = fiber.rigidity * (.01 - length) / length, fx = force * dx, fy = force * dy; point.x -= fx; prior.x += fx; point.y -= fy; prior.y += fy; }
        }
      }
      emit(fiber);
    }
    return alive;
  };
  let previous = null;
  return {
    append(point) {
      if (palette.colorMode === "gradient") {
        const progress = clamp(point.arcLength / (style.width * 24)), energy = clamp(Math.abs(point.curvature) * style.width);
        spineColor = interpolateHcl(palette.startColor || style.color, palette.endColor || style.color, .84 * energy + .16 * progress);
        base = rgb(spineColor);
      }
      if (previous) painter.polyline([{ x: previous.x, y: previous.y }, { x: point.x, y: point.y }], {
        color: spineColor, opacity: style.opacity * .04, width: .7, composite: "lighter", cap: "round", join: "round", role: "spine"
      });
      const vx = previous ? point.x - previous.x : 0, vy = previous ? point.y - previous.y : 0;
      for (const fiber of fibers) {
        const wander = Math.sin(point.arcLength / Math.max(style.width * 8, 1) + fiber.offset) * recipe.wander * recipe.spread * .2;
        const homeX = point.x + point.normalX * (fiber.offset + wander), homeY = point.y + point.normalY * (fiber.offset + wander);
        fiber.points.push({ x: homeX, y: homeY, px: homeX - vx * .35, py: homeY - vy * .35, homeX, homeY, inputVx: vx, inputVy: vy, life: 120 });
      }
      previous = point;
      for (let pass = 0; pass < 4; pass += 1) step();
    },
    settle: step,
    get isFinished() { return fibers.every(fiber => fiber.points.every(point => point.life <= 0)); },
    get scratchPointCount() { return fibers.reduce((count, fiber) => count + fiber.points.length, 0); }
  };
}
function silk(painter, geometry, material, context) {
  for (let index = 0; index < (geometry.paths || []).length; index += 1) {
    const frame = geometry.paths[index].frame;
    const simulation = createSilkPath(painter, material, context, index, frame.closed);
    for (const point of frame.points) simulation.append(point);
    while (!simulation.isFinished) simulation.settle();
  }
}

export const STROKE_MATERIALS = Object.freeze({ ink, silk });
export function renderMaterial(target, strokeGeometry, material = {}, context = {}) {
  const renderer = STROKE_MATERIALS[material.type || material.material || "ink"];
  if (!renderer) return false;
  renderer(toBrushPainter(target), strokeGeometry, material, context); return true;
}
export function measureMaterialBounds(strokeGeometry, material = {}, context = {}) {
  const style = materialStyle(material);
  if ((material.type || material.material) === "silk") {
    // Tethered fibers can briefly overshoot their homes. Measure the same
    // deterministic recipe rather than guessing a spread-only envelope.
    let bounds = null;
    silk(new BrushPainter(instruction => { bounds = mergeBounds(bounds, instructionBounds(instruction)); }), strokeGeometry, material, { seed: context.seed ?? material.seed });
    return bounds;
  }
  const points = (strokeGeometry.paths || []).flatMap(path => path.frame?.points || []);
  return bound(points, style.width / 2 + 2);
}
// `adapter` is a deliberately narrow bridge for established specialized
// materials (Spray, Texture, Fiber/Hair, Wisp); it is never rendered here.
export function isStrokeMaterial(material) { return (material?.type || material?.material) === "adapter" || Boolean(STROKE_MATERIALS[material?.type || material?.material]); }

function mergeBounds(a, b) {
  if (!a) return b;
  if (!b) return a;
  return { left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) };
}
function instructionBounds(instruction) {
  const points = instruction.points || [{ x: instruction.x, y: instruction.y }];
  return bound(points, (instruction.radius ?? instruction.width / 2) + 2);
}

/** Session-owned simulation. Both replay and live Silk consume the same causal
 * frames and physics; reconstruction consumes only the already-visible tail.
 * Scratch fiber curves are lifespan-bounded, and emitted batches are drained. */
export function createMaterialSession(drawable) {
  const fingerprint = JSON.stringify({ geometry: drawable?.geometry, material: drawable?.material });
  const material = drawable.material, isSilk = material.type === "silk", style = materialStyle(material);
  let inputCount, previous, sampler, simulation, delta, bounds, deltaBounds, finishing = false, tailSteps = 0;
  const painter = new BrushPainter(instruction => {
    delta.push(instruction);
    const footprint = instructionBounds(instruction);
    bounds = mergeBounds(bounds, footprint); deltaBounds = mergeBounds(deltaBounds, footprint);
  });
  const reset = () => {
    inputCount = 0; previous = null; delta = []; bounds = deltaBounds = null;
    sampler = createStrokeFrameSession(drawable.geometry.frame || drawable.geometry);
    simulation = isSilk ? createSilkPath(painter, material, { seed: drawable.gesture?.seed ?? material.seed }) : null;
  };
  const drain = () => {
    const instructions = delta, batchBounds = deltaBounds; delta = []; deltaBounds = null;
    return instructions.length ? [{ instructions, bounds: batchBounds, requiresBackdrop: instructions.some(item => item.composite === "lighter") }] : [];
  };
  const advance = next => {
    const input = next.gesture.points;
    for (let index = inputCount; index < input.length; index += 1) for (const frame of sampler.append(input[index])) {
      if (simulation) simulation.append(frame);
      else if (previous) painter.polyline([{ x: previous.x, y: previous.y }, { x: frame.x, y: frame.y }], { ...style, cap: "round", join: "round" });
      else painter.circle(frame.x, frame.y, style.width / 2, style);
      previous = frame;
    }
    inputCount = input.length;
    return drain();
  };
  reset();
  return {
    acceptsStyle: value => JSON.stringify({ geometry: value?.geometry, material: value?.material }) === fingerprint,
    advance,
    beginFinish() { finishing = true; },
    settle() {
      if (finishing && simulation) for (let count = 0; count < 4 && !simulation.isFinished; count += 1) { simulation.settle(); tailSteps += 1; }
      return drain();
    },
    get isFinished() { return !simulation || simulation.isFinished; },
    get bounds() { return bounds; },
    get scratchPointCount() { return simulation?.scratchPointCount || 0; },
    reconstruct(current) {
      const visibleTailSteps = tailSteps;
      reset();
      // Collect this one reconstruction batch; normal appends drain immediately.
      const batches = advance(current);
      for (let count = 0; count < visibleTailSteps; count += 1) simulation?.settle();
      return [...batches, ...drain()];
    },
    dispose() { delta = []; simulation = null; previous = null; }
  };
}
