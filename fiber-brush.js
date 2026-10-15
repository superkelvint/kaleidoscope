import { measure } from "./perf.js";
import { toBrushPainter } from "./brush-painter.js";
import { resolveBrushMaterial } from "./brush-material.js";
import { deriveFiberCompatibleFrame } from "./stroke-geometry.js";

// Deterministic Canvas2D material brush.  This module deliberately knows
// nothing about pointers, sources, WebGL, or symmetry.
const TAU = Math.PI * 2;
export const FIBER_CONFIG = {
  primary: { min: 3, max: 9, opacity: .72, width: .16 },
  secondary: { min: 1, max: 36, opacity: .34, width: .09 },
  ghost: { min: 0, max: 68, opacity: .09, width: .035 },
  gradient: { alongRate: .8, acrossAmount: .15 },
  preview: { secondaryAtMax: .7, ghostAtMax: .4 },
  branching: { maximumProbability: .35 }
};

const clamp = (value, low = 0, high = 1) => Math.min(high, Math.max(low, Number(value) || 0));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const fract = value => value - Math.floor(value);
const easeOut = value => 1 - (1 - value) * (1 - value);

function hash(value) {
  let x = Number(value) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  return (x ^ (x >>> 16)) >>> 0;
}
function random(seed, channel) { return hash((seed >>> 0) + Math.imul(channel + 1, 0x9e3779b9)) / 4294967296; }
function hex(color) {
  const match = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(typeof color === "string" ? color.trim() : "");
  if (!match) return null;
  const value = match[1].length === 3 ? [...match[1]].map(c => c + c).join("") : match[1];
  return [0, 2, 4].map(i => Number.parseInt(value.slice(i, i + 2), 16));
}
function gradient(style, u) {
  // Controller snapshots retain the gradient endpoints even while Solid is
  // selected. Solid Fiber/Hair must therefore start from `color`, not the
  // stale gradient-start swatch.
  const solid = hex(style.color) || [255, 255, 255];
  const start = style.colorMode === "gradient" ? (hex(style.startColor) || solid) : solid;
  const end = style.colorMode === "gradient" ? (hex(style.endColor) || start) : start;
  const t = clamp(u);
  return start.map((value, index) => value + (end[index] - value) * t);
}
function colorString(rgb, light = 0) {
  return `rgb(${rgb.map(value => Math.round(lerp(value, 255, light))).join(",")})`;
}
function usesSharedMaterial(style) { return style.schemaVersion !== 3 || Number(style.materialVersion) === 1; }
function fiberMaterial(style, { progress = 0, phase = 0, generation = 0, core = false } = {}) {
  if (!usesSharedMaterial(style)) return null;
  return resolveBrushMaterial(style, {
    progress, variation: Math.sin(phase * TAU), energy: clamp(.3 + generation * .15 + (core ? .55 : 0)),
    opacityScale: 1, profile: "fiber"
  });
}
function resample(points, limit = 192) {
  if (points.length < 2) return points.map(point => ({ x: point.x, y: point.y }));
  const distances = [0];
  for (let i = 1; i < points.length; i += 1) distances.push(distances[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  const length = distances.at(-1);
  if (length < .01) return [{ x: points[0].x, y: points[0].y }];
  const count = Math.min(limit, Math.max(12, Math.ceil(length / 5) + 1));
  const output = [];
  let cursor = 1;
  for (let i = 0; i < count; i += 1) {
    const target = length * i / (count - 1);
    while (cursor < distances.length - 1 && distances[cursor] < target) cursor += 1;
    const previous = cursor - 1, span = distances[cursor] - distances[previous] || 1;
    const ratio = (target - distances[previous]) / span;
    output.push({ x: lerp(points[previous].x, points[cursor].x, ratio), y: lerp(points[previous].y, points[cursor].y, ratio), arcLength: target, t: i / (count - 1) });
  }
  return output;
}
function deriveFiberMasterPathV1(points) {
  const path = resample(points);
  if (path.length < 2) return [];
  let previousAngle = 0;
  for (let i = 0; i < path.length; i += 1) {
    const before = path[Math.max(0, i - 1)], after = path[Math.min(path.length - 1, i + 1)];
    const dx = after.x - before.x, dy = after.y - before.y, length = Math.hypot(dx, dy) || 1;
    path[i].tangentX = dx / length; path[i].tangentY = dy / length;
    path[i].normalX = -dy / length; path[i].normalY = dx / length;
    const angle = Math.atan2(dy, dx);
    let delta = angle - previousAngle;
    while (delta > Math.PI) delta -= TAU;
    while (delta < -Math.PI) delta += TAU;
    path[i].curvature = i ? Math.min(1, Math.abs(delta) * 3) : 0;
    previousAngle = angle;
  }
  // A tiny spatial filter keeps input sampling noise from exploding wisps.
  for (let i = 1; i < path.length - 1; i += 1) path[i].curvature = clamp((path[i - 1].curvature + path[i].curvature * 2 + path[i + 1].curvature) / 4);
  return path;
}
function counts(style, preview) {
  const assist = clamp(style.assistLevel, 0, 1), density = lerp(.5, 1.5, clamp(style.fibers, 0, 1));
  const primary = lerp(3, 6, assist);
  const secondary = lerp(3, 24, easeOut(assist));
  const ghost = lerp(0, 45, assist * assist);
  const secondaryPreview = preview ? lerp(1, FIBER_CONFIG.preview.secondaryAtMax, assist) : 1;
  const ghostPreview = preview ? (assist <= .5 ? 1 : assist <= .7 ? .8 : FIBER_CONFIG.preview.ghostAtMax) : 1;
  return {
    primary: Math.round(clamp(Math.round(primary * density), FIBER_CONFIG.primary.min, FIBER_CONFIG.primary.max)),
    secondary: Math.round(clamp(Math.round(secondary * density * secondaryPreview), FIBER_CONFIG.secondary.min, FIBER_CONFIG.secondary.max)),
    ghost: Math.round(clamp(Math.round(ghost * density * ghostPreview), FIBER_CONFIG.ghost.min, FIBER_CONFIG.ghost.max))
  };
}
function fiber(seed, population, index, style, branch = false) {
  const assist = clamp(style.assistLevel), wispiness = clamp(style.wispiness), spread = lerp(.55, 1.55, clamp(style.spread));
  const kind = population === "primary" ? 0 : population === "secondary" ? 1 : 2;
  const base = hash((Number(style.seed) >>> 0) ^ hash(kind * 4096 + index + (branch ? 8192 : 0)));
  const r = channel => random(base, channel);
  const lifespan = population === "primary" ? [0, 1] : (() => {
    const variation = lerp(.05, .55, assist) * lerp(.65, 1.25, wispiness);
    const birth = r(1) * variation * .65;
    return [birth, Math.max(birth + .18, 1 - r(2) * variation)];
  })();
  const hierarchy = population === "primary" ? lerp(.3, .6, assist) : population === "secondary" ? lerp(.5, 1.5, assist) : lerp(.8, 2.5, assist);
  const wander = population === "primary" ? lerp(.15, .4, assist) : population === "secondary" ? lerp(.4, 1.5, assist) : lerp(.8, 2.5, assist);
  return { population, baseOffset: (r(3) * 2 - 1) * Number(style.size) * hierarchy * spread * (branch ? 1.3 : 1), wander: Number(style.size) * wander * lerp(.35, 1.3, wispiness) * (.45 + r(4)), frequency: lerp(1.2, 4.5, r(5)), phase: r(6) * TAU, phase2: r(7) * TAU, birth: lifespan[0], death: lifespan[1], peelDirection: r(8) < .5 ? -1 : 1, peelStrength: Number(style.size) * hierarchy * spread * (population === "primary" ? .08 : lerp(.25, 1.25, assist)) * (.35 + r(9)), width: (population === "primary" ? FIBER_CONFIG.primary.width : population === "secondary" ? FIBER_CONFIG.secondary.width : FIBER_CONFIG.ghost.width) * (.65 + r(10) * .7) * (branch ? .65 : 1), opacity: (population === "primary" ? FIBER_CONFIG.primary.opacity : population === "secondary" ? FIBER_CONFIG.secondary.opacity : FIBER_CONFIG.ghost.opacity) * (.55 + r(11) * .6) * (branch ? .55 : 1), colorPhase: (r(12) * 2 - 1) * lerp(population === "primary" ? .01 : population === "secondary" ? .02 : .04, population === "primary" ? .04 : population === "secondary" ? .12 : .22, assist), hotCore: population === "primary" && r(13) < lerp(.1, .7, assist * assist), branch: false };
}
function pointAt(master, params, sample) {
  const t = sample.t;
  const u = clamp((t - params.birth) / Math.max(.001, params.death - params.birth));
  const life = t < params.birth || t > params.death ? 0 : smoothstep(0, .15, u) * (1 - smoothstep(.45, 1, u));
  const envelope = .45 + .55 * Math.sin(Math.PI * t);
  const curvatureBoost = lerp(.25, 2.5, clamp(params.assist) ** 2);
  const wander = (Math.sin(t * params.frequency * TAU + params.phase) + .45 * Math.sin(t * params.frequency * 2.13 * TAU + params.phase2)) * params.wander;
  const peel = params.peelDirection * params.peelStrength * smoothstep(0, 1, u);
  const offset = (params.baseOffset + wander + peel) * envelope * (1 + sample.curvature * curvatureBoost);
  return { x: sample.x + sample.normalX * offset, y: sample.y + sample.normalY * offset, life, t, u };
}
function drawFiber(painter, master, params, style, core = false, composite) {
  params.assist = clamp(style.assistLevel);
  const size = Math.max(.25, Number(style.size) || 1);
  let previous = pointAt(master, params, master[0]);
  for (let i = 1; i < master.length; i += 1) {
    const next = pointAt(master, params, master[i]), middleT = (previous.t + next.t) / 2;
    const life = (previous.life + next.life) / 2;
    if (life > .001) {
      // Gradients are anchored to gesture direction. Strand phase may affect
      // material shape and brightness, but never swap the chosen endpoints.
      const material = fiberMaterial(style, { progress: middleT, phase: params.colorPhase, core });
      const rgb = gradient(style, style.colorMode === "gradient" ? middleT : 0);
      painter.polyline([previous, next], { opacity: clamp((Number(style.opacity) || 0) * params.opacity * life * (core ? .7 : 1)) * (material?.opacity ?? 1), color: material?.color || colorString(rgb, core ? lerp(.15, .5, clamp(style.assistLevel)) : 0), width: Math.max(.18, size * params.width * life * (core ? .42 : 1)), cap: "round", join: "round", composite });
    }
    previous = next;
  }
}
/** Renders a complete deterministic Fiber stroke. */
function renderFiberPathV1(painter, points, style, { preview = false } = {}) {
  const master = deriveFiberMasterPathV1(points);
  if (master.length < 2) return;
  const populationCounts = counts(style, preview), fibers = { primary: [], secondary: [], ghost: [] };
  for (const population of Object.keys(fibers)) for (let i = 0; i < populationCounts[population]; i += 1) fibers[population].push(fiber(style.seed, population, i, style));
  const branches = [];
  const probability = smoothstep(.45, 1, clamp(style.assistLevel)) * FIBER_CONFIG.branching.maximumProbability;
  for (let i = 0; i < fibers.secondary.length; i += 1) if (!preview || i % 2 === 0) {
    const parent = fibers.secondary[i], branchSeed = hash((Number(style.seed) >>> 0) ^ (i + 0x5bd1e995));
    if (random(branchSeed, 0) < probability) {
      const child = fiber(branchSeed, "secondary", i, style, true);
      // Begin from the parent's strand, then peel farther out. This makes a
      // branch read as a child rather than an unrelated short fiber.
      child.baseOffset = parent.baseOffset;
      child.peelDirection = parent.peelDirection;
      child.peelStrength = parent.peelStrength * lerp(1.25, 2.1, random(branchSeed, 3));
      child.birth = lerp(.2, .65, random(branchSeed, 1));
      child.death = Math.min(1, child.birth + lerp(.18, .42, random(branchSeed, 2)));
      branches.push(child);
    }
  }
  for (const params of fibers.ghost) drawFiber(painter, master, params, style);
  for (const params of branches) drawFiber(painter, master, params, style);
  for (const params of fibers.secondary) drawFiber(painter, master, params, style);
  for (const params of fibers.primary) drawFiber(painter, master, params, style);
  for (const params of fibers.primary) if (params.hotCore) drawFiber(painter, master, params, style, true, "lighter");
  if (globalThis.__KALEIDOSCOPE_DEBUG_FIBER__) console.debug("[fiber-brush]", { masterSamples: master.length, ...populationCounts, branches: branches.length, preview });
}

// Version 2 is deliberately arc-length based.  In contrast to the original
// normalized recipe, a point at 120px along the gesture has the same material
// coordinates when the user later extends the gesture.
const V2 = {
  sampleSpacing: 6,
  maxMasterSamples: 384,
  maxRoots: 160,
  // Fixed master/population caps bound base material below 44k segments at
  // their maximum. Leave a deterministic, finite allowance for the canopy.
  maxSegments: 48000,
  branchStartAssist: .42
};

function rotate(x, y, angle) {
  const cosine = Math.cos(angle), sine = Math.sin(angle);
  return { x: x * cosine - y * sine, y: x * sine + y * cosine };
}
/** A causal, fixed-distance flow field used by Fiber recipe version 2. */
export function deriveFiberMasterPath(points) {
  return deriveFiberCompatibleFrame(points, { spacing: V2.sampleSpacing, maxSamples: V2.maxMasterSamples });

}

function sampleMaster(master, arcLength) {
  if (!master.length) return null;
  const position = clamp(arcLength / V2.sampleSpacing, 0, master.length - 1);
  const low = Math.floor(position), high = Math.min(master.length - 1, low + 1), ratio = position - low;
  const a = master[low], b = master[high];
  const tangentX = lerp(a.tangentX, b.tangentX, ratio), tangentY = lerp(a.tangentY, b.tangentY, ratio);
  const magnitude = Math.hypot(tangentX, tangentY) || 1;
  return { x: lerp(a.x, b.x, ratio), y: lerp(a.y, b.y, ratio), tangentX: tangentX / magnitude, tangentY: tangentY / magnitude, curvature: lerp(a.curvature, b.curvature, ratio) };
}
function v2Fiber(seed, population, index, style) {
  const kind = population === "primary" ? 0 : population === "secondary" ? 1 : 2;
  const base = hash((Number(seed) >>> 0) ^ hash(kind * 4096 + index));
  const r = channel => random(base, channel);
  const assist = clamp(style.assistLevel), size = Math.max(.25, Number(style.size) || 1);
  const spread = lerp(.55, 1.55, clamp(style.spread)), wisps = clamp(style.wispiness);
  const scale = population === "primary" ? .34 : population === "secondary" ? 1 : 1.55;
  return {
    base, population, offset: (r(1) * 2 - 1) * size * spread * scale * lerp(.25, 1.15, assist),
    wander: size * scale * lerp(.08, 1.4, wisps) * (.3 + r(2)), frequency: lerp(.012, .055, r(3)), phase: r(4) * TAU,
    peel: (r(5) < .5 ? -1 : 1) * size * spread * scale * lerp(.04, .72, assist) * (.35 + r(6)),
    width: (population === "primary" ? .16 : population === "secondary" ? .105 : .032) * (.65 + r(7) * .7),
    opacity: (population === "primary" ? .72 : population === "secondary" ? .42 : .09) * (.55 + r(8) * .6),
    colorPhase: r(9), hotCore: population === "primary" && r(10) < lerp(.12, .72, assist * assist)
  };
}
function v2Point(master, params, arcLength) {
  const sample = sampleMaster(master, arcLength);
  if (!sample) return null;
  const progress = arcLength / Math.max(V2.sampleSpacing, master.at(-1).arcLength);
  const normalX = -sample.tangentY, normalY = sample.tangentX;
  const organic = Math.sin(arcLength * params.frequency + params.phase) + .38 * Math.sin(arcLength * params.frequency * 2.17 + params.phase * 1.7);
  const offset = (params.offset + organic * params.wander + params.peel * progress) * (1 + Math.min(.7, sample.curvature) * .55);
  return { x: sample.x + normalX * offset, y: sample.y + normalY * offset, tangentX: sample.tangentX, tangentY: sample.tangentY, arcLength };
}
function v2Color(style, phase, progress, generation = 0) {
  const rgb = gradient(style, style.colorMode === "gradient" ? progress : 0);
  // A restrained deterministic lift gives a solid selected colour life without
  // introducing a second palette or hue picker.
  return colorString(rgb, clamp(.02 + Math.sin((phase + progress) * TAU) * .035 + generation * .025, 0, .13));
}
function strokeContinuous(painter, points, style, { width, opacity, phase, generation = 0, taper = 1, core = false, lineCap = "round", gradientArcLength, composite } = {}) {
  if (points.length < 2) return 0;
  const mid = points[Math.floor(points.length / 2)];
  // A tapered fiber is painted in short chunks. Its colour must still be
  // measured against the complete gesture, not the current chunk; otherwise
  // every chunk incorrectly lands near the gradient's end colour.
  const progress = clamp(mid.arcLength / Math.max(V2.sampleSpacing, Number(gradientArcLength) || points.at(-1).arcLength));
  const material = fiberMaterial(style, { progress, phase, generation, core });
  painter.polyline(points, { cap: lineCap, join: "round", opacity: clamp((Number(style.opacity) || 0) * opacity * (core ? .65 : 1)) * (material?.opacity ?? 1), color: material?.color || v2Color(style, phase, progress, generation), width: Math.max(.18, (Number(style.size) || 1) * width * taper * (core ? .42 : 1)), composite });
  return points.length - 1;
}
function strokeTapered(painter, points, style, params) {
  if (points.length < 2) return 0;
  const last = points.length - 1, chunkSize = 24;
  let segments = 0;
  for (let start = 0; start < last; start += chunkSize) {
    const end = Math.min(last, start + chunkSize), progress = end / last;
    // Adjacent paths share their endpoint so Canvas can taper a fiber without
    // replaying individual brush stamps. Butt caps are essential here: round
    // caps would stack alpha at every shared endpoint and at branch roots.
    segments += strokeContinuous(painter, points.slice(start, end + 1), style, { ...params, taper: (params.taper ?? 1) * Math.pow(1 - progress, .48), opacity: params.opacity * lerp(1, .72, progress), lineCap: "butt" });
  }
  return segments;
}
function makeRoot(seed, parent, generation, style) {
  const r = channel => random(seed, channel), size = Math.max(.25, Number(style.size) || 1);
  // Birth is an absolute distance, never a fraction of the currently drawn
  // gesture.  A root therefore arrives as the gesture reaches it, rather than
  // sliding when the user continues drawing.
  const birth = 24 + r(1) * 1180;
  const length = Math.min(250, size * lerp(6, 14, r(2)) * lerp(.8, 1.5, clamp(style.spread)));
  // A root starts nearly parallel with its parent.  Its subsequent bend is
  // simulated toward the user's drawing flow, rather than being a free arc.
  return { seed, parent, generation, birth, length, size, angle: (r(3) < .5 ? -1 : 1) * lerp(.055, .32, r(4)), bend: (r(5) * 2 - 1) * lerp(.008, .05, clamp(style.wispiness)), width: parent.width * lerp(.9, 1.14, r(6)), opacity: parent.opacity * lerp(1.02, 1.34, r(7)), phase: fract(parent.colorPhase + r(8) * .24) };
}
function rootPoints(master, root, strand = 0) {
  const available = master.at(-1).arcLength - root.birth;
  if (available < 4) return [];
  const length = Math.min(root.length, available), segments = Math.min(24, Math.max(5, Math.ceil(length / 7)));
  let anchor;
  if (root.parentRoot) {
    const parentPath = rootPoints(master, root.parentRoot);
    if (parentPath.length < 2) return [];
    const position = clamp(root.attach, 0, 1) * (parentPath.length - 1), low = Math.floor(position), high = Math.min(parentPath.length - 1, low + 1), ratio = position - low;
    const a = parentPath[low], b = parentPath[high], dx = b.x - a.x, dy = b.y - a.y, magnitude = Math.hypot(dx, dy) || 1;
    anchor = { x: lerp(a.x, b.x, ratio), y: lerp(a.y, b.y, ratio), tangentX: dx / magnitude, tangentY: dy / magnitude };
  } else anchor = v2Point(master, root.parent, root.birth);
  if (!anchor) return [];
  let heading = Math.atan2(anchor.tangentY, anchor.tangentX) + root.angle;
  const strandSeed = hash(root.seed ^ Math.imul(strand + 1, 0x9e3779b9));
  const strandBias = (random(strandSeed, 0) * 2 - 1) * .045;
  const phase = random(strandSeed, 1) * TAU, frequency = lerp(.08, .17, random(strandSeed, 2));
  const output = [{ x: anchor.x, y: anchor.y, arcLength: root.birth }];
  let x = anchor.x, y = anchor.y;
  for (let i = 1; i <= segments; i += 1) {
    const t = i / segments, distance = length * t, flow = sampleMaster(master, root.birth + distance);
    const flowAngle = flow ? Math.atan2(flow.tangentY, flow.tangentX) : heading;
    let turnToFlow = flowAngle - heading;
    while (turnToFlow > Math.PI) turnToFlow -= TAU;
    while (turnToFlow < -Math.PI) turnToFlow += TAU;
    // This is the simulation's gravity: its direction is the local direction
    // of the drawn gesture. Finer generations align slightly more strongly.
    heading += turnToFlow * (.085 + root.generation * .018) + root.bend * Math.sin(distance * frequency + phase) + strandBias;
    const step = length / segments;
    x += Math.cos(heading) * step; y += Math.sin(heading) * step;
    output.push({ x, y, arcLength: root.birth + distance });
  }
  return output;
}
function createRootNetwork(master, fibers, style) {
  const assist = clamp(style.assistLevel), strength = smoothstep(V2.branchStartAssist, 1, assist);
  if (!strength) return [];
  const roots = [];
  const add = (root) => { if (roots.length < V2.maxRoots) roots.push(root); };
  for (let i = 0; i < fibers.secondary.length; i += 1) {
    for (let limb = 0; limb < 2; limb += 1) {
      const seed = hash((Number(style.seed) >>> 0) ^ (i + 0x5bd1e995 + limb * 0x27d4eb2d));
      if (random(seed, 0) < lerp(limb ? .06 : .16, limb ? .74 : .93, strength)) {
        const first = makeRoot(seed, fibers.secondary[i], 1, style); add(first);
        for (let child = 0; child < 2; child += 1) if (random(seed, 10 + child * 10) < lerp(.05, .61, strength)) {
          const childSeed = hash(seed ^ (child ? 0x1b873593 : 0x68bc21eb));
          const second = makeRoot(childSeed, fibers.secondary[i], 2, style); second.parentRoot = first; second.attach = lerp(.2 + child * .14, .58 + child * .18, random(seed, 11 + child * 10)); second.birth = first.birth + first.length * second.attach; second.length *= .68; second.width = first.width * .86; second.opacity = first.opacity * .84; add(second);
          if (random(seed, 12 + child * 10) < lerp(.01, .38, strength)) { const third = makeRoot(hash(childSeed ^ 0x02e5be93), fibers.secondary[i], 3, style); third.parentRoot = second; third.attach = lerp(.22, .66, random(seed, 13 + child * 10)); third.birth = second.birth + second.length * third.attach; third.length *= .45; third.width = second.width * .78; third.opacity = second.opacity * .76; add(third); }
        }
      }
    }
  }
  return roots;
}
function smoothRandom(seed, position) {
  const low = Math.floor(position), amount = position - low, eased = amount * amount * (3 - 2 * amount);
  return lerp(random(seed, low), random(seed, low + 1), eased);
}
function angleDelta(target, source) {
  let delta = target - source;
  while (delta > Math.PI) delta -= TAU;
  while (delta < -Math.PI) delta += TAU;
  return delta;
}
function sampleFiberFrame(fiber, frame) {
  const points = [{ x: fiber.startX, y: fiber.startY }, ...fiber.points];
  if (points.length < 2) return null;
  const position = clamp(frame, 0, points.length - 1), low = Math.floor(position), high = Math.min(points.length - 1, low + 1), ratio = position - low;
  const a = points[low], b = points[high], x = lerp(a.x, b.x, ratio), y = lerp(a.y, b.y, ratio);
  const before = points[Math.max(0, low - 1)], after = points[Math.min(points.length - 1, high + 1)];
  const dx = after.x - before.x, dy = after.y - before.y, length = Math.hypot(dx, dy) || 1;
  return { x, y, tangentX: dx / length, tangentY: dy / length };
}
function childLifeRange(generation) {
  if (generation === 1) return [.35, .70];
  if (generation === 2) return [.18, .45];
  if (generation === 3) return [.08, .28];
  return [.04, .16];
}
function childAngleRange(generation) {
  if (generation === 1) return [12, 38];
  if (generation === 2) return [18, 50];
  return [20, 65];
}
// A deterministic, static replay of the growing-fiber model. The master path
// supplies gravity: at every simulation step it pulls velocity toward the
// local direction in which the user drew.
function simulateGravityFibers(master, style, preview, { hierarchy = true } = {}) {
  const rawFibers = Number(style.fibers), density = rawFibers > 1 ? clamp((rawFibers - 2) / 12) : clamp(rawFibers || (6 - 2) / 12);
  // This control is local-flow attraction, not world-space gravity. A Fiber
  // should follow the gesture without accumulating a permanent screen-Y bias.
  const flowGravity = clamp(Number.isFinite(Number(style.gravity)) ? Number(style.gravity) : 42, 0, 100) / 100;
  const curl = clamp((Number(style.curl) || 12) / 60), size = Math.max(.25, Number(style.size) || 1);
  const totalArc = master.at(-1).arcLength, seed = Number(style.seed) >>> 0;
  const primaryBranchArc = Math.max(90, totalArc * .18);
  // Preview only paints the trunk and first generation. Do not spend its
  // bounded simulation budget on descendants which cannot reach the canvas.
  const maxGeneration = preview ? 1 : 6;
  const initialCount = hierarchy ? 1 : Math.round(lerp(2, 14, density)), maxFibers = preview ? 80 : 900, maxSegments = preview ? 2500 : 24000;
  const branchRate = clamp((Number(style.branching) || 13) / 1000 * (hierarchy ? lerp(.55, 1.45, density) : 1), .001, .08);
  const flow = [];
  const spawn = (params) => { if (flow.length < maxFibers) flow.push(params); };
  for (let index = 0; index < initialCount; index += 1) {
    const fiberSeed = hash(seed ^ Math.imul(index + 1, 0x9e3779b9)), r = channel => random(fiberSeed, channel);
    const start = master[0], masterAngle = Math.atan2(start.tangentY, start.tangentX);
    const angle = hierarchy ? masterAngle : masterAngle + (r(0) * 2 - 1) * .12;
    const x = hierarchy ? start.x : start.x + start.normalX * (r(1) * 2 - 1) * size * .55;
    const y = hierarchy ? start.y : start.y + start.normalY * (r(2) * 2 - 1) * size * .55;
    const baseSpeed = lerp(1.4, 1.9, r(6));
    spawn({ seed: fiberSeed, generation: 0, flowArc: 0, x, y, startX: x, startY: y, startArc: 0, velocityX: Math.cos(angle) * baseSpeed, velocityY: Math.sin(angle) * baseSpeed, baseSpeed, lifeSteps: Math.max(12, Math.ceil(totalArc / baseSpeed)), parent: null, parentFrame: 0, parentProgress: 0, width: .16 * (.72 + r(3) * .58), opacity: .72 * (.78 + r(4) * .34), phase: r(5), age: 0, points: [] });
  }
  let segments = 0;
  for (let cursor = 0; cursor < flow.length && segments < maxSegments; cursor += 1) {
    const fiber = flow[cursor], r = channel => random(fiber.seed, channel);
    while (fiber.age < fiber.lifeSteps && segments < maxSegments) {
      const guide = hierarchy && fiber.parent
        ? sampleFiberFrame(fiber.parent, fiber.parentFrame + fiber.parentProgress)
        : sampleMaster(master, fiber.flowArc);
      const heading = Math.atan2(fiber.velocityY, fiber.velocityX);
      const trunkEstablishment = hierarchy && fiber.generation === 0 ? smoothstep(0, 60, fiber.flowArc) : 1;
      const noise = (smoothRandom(fiber.seed, fiber.age * .13) - .5) * trunkEstablishment;
      const wanderingAngle = heading + noise * (.20 + curl * .28);
      let steeringX = Math.cos(wanderingAngle) * .045, steeringY = Math.sin(wanderingAngle) * .045;
      const curlWave = Math.sin(fiber.age * .018 + r(7) * 10000) * (.008 + curl * .012) * trunkEstablishment;
      steeringX += Math.cos(heading + Math.PI / 2) * curlWave;
      steeringY += Math.sin(heading + Math.PI / 2) * curlWave;
      // The trunk obeys the drawn gesture. Each later generation is freer to
      // follow its parent trajectory and retain its departure angle.
      const generationGravity = hierarchy
        ? flowGravity * .028 * Math.pow(.58, fiber.generation)
        : flowGravity * (.028 + fiber.generation * .0035);
      steeringX += guide.tangentX * generationGravity;
      steeringY += guide.tangentY * generationGravity;
      const alignment = hierarchy ? flowGravity * .018 * Math.pow(.52, fiber.generation) : flowGravity * .018;
      steeringX += (guide.tangentX * fiber.baseSpeed - fiber.velocityX) * alignment;
      steeringY += (guide.tangentY * fiber.baseSpeed - fiber.velocityY) * alignment;
      fiber.velocityX = (fiber.velocityX + steeringX) * .985;
      fiber.velocityY = (fiber.velocityY + steeringY) * .985;
      const speed = Math.hypot(fiber.velocityX, fiber.velocityY), maxSpeed = fiber.baseSpeed * 1.55;
      if (speed > maxSpeed) { fiber.velocityX = fiber.velocityX / speed * maxSpeed; fiber.velocityY = fiber.velocityY / speed * maxSpeed; }
      const currentSpeed = Math.hypot(fiber.velocityX, fiber.velocityY), currentHeading = Math.atan2(fiber.velocityY, fiber.velocityX);
      fiber.x += fiber.velocityX; fiber.y += fiber.velocityY;
      fiber.flowArc += currentSpeed;
      if (hierarchy && fiber.parent) fiber.parentProgress += currentSpeed / Math.max(.1, fiber.parent.baseSpeed);
      fiber.age += 1;
      fiber.points.push({ x: fiber.x, y: fiber.y, arcLength: fiber.flowArc }); segments += 1;
      const chance = branchRate * Math.pow(.63, fiber.generation);
      const minimumBranchAge = fiber.generation === 0 ? 28 : 18;
      const canBranch = fiber.generation > 0 || fiber.flowArc >= primaryBranchArc;
      if (canBranch && fiber.age >= minimumBranchAge && fiber.generation < maxGeneration && random(fiber.seed, fiber.age + 40) < chance && flow.length < maxFibers) {
        const childSeed = hash(fiber.seed ^ Math.imul(fiber.age + 1, 0x85ebca6b)), childR = channel => random(childSeed, channel);
        const remaining = fiber.lifeSteps - fiber.age, generation = fiber.generation + 1;
        const [lifeLow, lifeHigh] = hierarchy ? childLifeRange(generation) : [.46, .84];
        const [angleLow, angleHigh] = hierarchy ? childAngleRange(generation) : [3, 16];
        if (remaining > 12) { const departure = lerp(angleLow, angleHigh, childR(2)) * Math.PI / 180, childAngle = currentHeading + (childR(1) < .5 ? -1 : 1) * departure, childSpeed = currentSpeed * lerp(.82, .98, childR(5)); spawn({ seed: childSeed, generation, flowArc: fiber.flowArc, x: fiber.x, y: fiber.y, startX: fiber.x, startY: fiber.y, startArc: fiber.flowArc, velocityX: Math.cos(childAngle) * childSpeed, velocityY: Math.sin(childAngle) * childSpeed, baseSpeed: childSpeed, lifeSteps: Math.max(8, Math.round(remaining * lerp(lifeLow, lifeHigh, childR(0)))), parent: hierarchy ? fiber : null, parentFrame: fiber.points.length, parentProgress: 0, width: Math.max(.018, fiber.width * lerp(.58, .78, childR(3))), opacity: fiber.opacity * .9, phase: fract(fiber.phase + childR(4) * .18), age: 0, points: [] }); }
      }
    }
  }
  return { fibers: flow, segments };
}
function renderFiberPathV2(painter, points, style, { preview = false } = {}) {
  const started = globalThis.performance?.now?.() ?? 0, master = measure("Fiber master path", () => deriveFiberMasterPath(points));
  if (master.length < 2) return;
  const network = measure(preview ? "Fiber preview simulation" : "Fiber committed simulation", () => simulateGravityFibers(master, style, preview));
  const gradientArcLength = master.at(-1).arcLength;
  measure(preview ? "Fiber preview painting" : "Fiber committed painting", () => {
    for (const fiber of network.fibers) if (fiber.points.length > 1 && (!preview || fiber.generation < 2)) {
      const path = [{ x: fiber.startX, y: fiber.startY, arcLength: fiber.startArc }, ...fiber.points];
      strokeTapered(painter, path, style, { width: fiber.width, opacity: fiber.opacity, phase: fiber.phase, generation: fiber.generation, taper: 1 - fiber.generation * .1, gradientArcLength });
    }
  });
  for (const fiber of network.fibers) if (!fiber.generation && fiber.points.length > 1) strokeTapered(painter, [{ x: fiber.startX, y: fiber.startY, arcLength: fiber.startArc }, ...fiber.points], style, { width: fiber.width, opacity: fiber.opacity, phase: fiber.phase, core: true, gradientArcLength, composite: "lighter" });
  if (globalThis.__KALEIDOSCOPE_DEBUG_FIBER__) console.debug("[fiber-brush]", { version: 2, masterSamples: master.length, fibers: network.fibers.length, segments: network.segments, preview, generationMs: (globalThis.performance?.now?.() ?? started) - started });
}
function renderHairPath(painter, points, style, { preview = false } = {}) {
  const master = measure("Fiber master path", () => deriveFiberMasterPath(points));
  if (master.length < 2) return;
  const network = measure(preview ? "Fiber preview simulation" : "Fiber committed simulation", () => simulateGravityFibers(master, style, preview, { hierarchy: false }));
  const gradientArcLength = master.at(-1).arcLength;
  measure(preview ? "Fiber preview painting" : "Fiber committed painting", () => {
    for (const fiber of network.fibers) if (fiber.points.length > 1 && (!preview || fiber.generation < 2)) {
      strokeContinuous(painter, [{ x: fiber.startX, y: fiber.startY, arcLength: fiber.startArc }, ...fiber.points], style, { width: fiber.width, opacity: fiber.opacity, phase: fiber.phase, generation: fiber.generation, gradientArcLength });
    }
  });
}

/** Renders a complete deterministic Fiber stroke, preserving recipe v1. */
export function renderFiberPath(ctx, points, style, options = {}) {
  const painter = toBrushPainter(ctx);
  if (Number(style?.version) === 1) return renderFiberPathV1(painter, points, style, options);
  if (style?.brush === "hair") return renderHairPath(painter, points, style, options);
  return renderFiberPathV2(painter, points, style, options);
}
