import { toBrushPainter } from "./brush-painter.js";

// An independently written, fixed-seed Perlin-style gradient noise field.
// Lattice gradients are selected from an integer coordinate hash, avoiding a
// copied permutation table or random-number generator.
const fade = value => value * value * value * (value * (value * 6 - 15) + 10);
const mix = (a, b, amount) => a + (b - a) * amount;
function gradientHash(x, y, z) {
  let value = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(z, 0x9e3779b1);
  value = Math.imul(value ^ (value >>> 15), 0x85ebca6b);
  return value ^ (value >>> 13);
}
function gradientDot(hash, x, y, z) {
  switch ((hash % 12 + 12) % 12) {
    case 0: return (x + y); case 1: return (-x + y);
    case 2: return (x - y); case 3: return (-x - y);
    case 4: return (x + z); case 5: return (-x + z);
    case 6: return (x - z); case 7: return (-x - z);
    case 8: return (y + z); case 9: return (-y + z);
    case 10: return (y - z); default: return (-y - z);
  }
}
export function wispNoise3d(x, y, z) {
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z), dx = x - x0, dy = y - y0, dz = z - z0;
  const corner = (ox, oy, oz) => gradientDot(gradientHash(x0 + ox, y0 + oy, z0 + oz), dx - ox, dy - oy, dz - oz);
  const u = fade(dx), v = fade(dy), w = fade(dz);
  const lower = mix(mix(corner(0, 0, 0), corner(1, 0, 0), u), mix(corner(0, 1, 0), corner(1, 1, 0), u), v);
  const upper = mix(mix(corner(0, 0, 1), corner(1, 0, 1), u), mix(corner(0, 1, 1), corner(1, 1, 1), u), v);
  return mix(lower, upper, w);
}
export function wispNoise(x, y, z, octaves = 8, fallout = .65) {
  let effect = 1, frequency = 1, sum = 0;
  for (let index = 0; index < octaves; index += 1) { effect *= fallout; sum += effect * (1 + wispNoise3d(frequency * x, frequency * y, frequency * z)) / 2; frequency *= 2; }
  return sum;
}

export const WISP_V1 = Object.freeze({ startLife: 150, startOpacity: .09, drawsPerFrame: 5, noiseForceScale: 1, noiseSpaceScale: .02, noiseTimeScale: .005, noiseOffset: 0, noiseOctaves: 8, noiseFallout: .65, noiseAngleScale: 5 * Math.PI, noiseAngleOffset: 0, initialVelocityForceScale: .3, initialVelocityDecay: .98, friction: .975, restingDistance: 0, rigidity: .2 });
export const WISP_ARTIST_DEFAULTS = Object.freeze({ energy: .5, momentum: .3, turbulence: 1, persistence: 150, density: 5 });
const finite = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const clamp = value => Math.min(1, Math.max(0, value));
const clampRange = (value, min, max, fallback) => Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Number(value))) : fallback;
// Curves are calibrated so the middle Energy position preserves the original
// Wisp recipe, while its endpoints still provide a useful quiet-to-lively range.
export function wispArtistControlsForEnergy(value) {
  const energy = clampRange(value, 0, 1, WISP_ARTIST_DEFAULTS.energy);
  return {
    energy,
    momentum: .24 + .14 * energy ** 1.22239242134,
    turbulence: .85 + .4 * energy ** 2,
    persistence: Math.round(110 + 130 * energy ** 1.70043971814),
    density: Math.round(4 + 4 * energy ** 2)
  };
}
function wispRecipe(style = {}) {
  if (Number(style.version) < 2) return WISP_V1;
  const energyDefaults = wispArtistControlsForEnergy(style.energy);
  const persistence = clampRange(style.persistence, 60, 300, energyDefaults.persistence);
  const density = Math.round(clampRange(style.density, 3, 10, energyDefaults.density));
  return {
    ...WISP_V1,
    // Density changes the number of simulation steps per input frame. Scale
    // life with it so Density changes deposition without unintentionally
    // shortening or extending the artist-selected Persistence.
    startLife: Math.round(persistence * density / WISP_V1.drawsPerFrame),
    drawsPerFrame: density,
    noiseForceScale: clampRange(style.turbulence, .5, 1.8, energyDefaults.turbulence),
    initialVelocityForceScale: clampRange(style.momentum, .15, .5, energyDefaults.momentum)
  };
}
const unitsPerPixel = style => {
  const value = Number(style?.wispUnitsPerPixel);
  return Number.isFinite(value) && value > 0 ? value : 1;
};
function rgb(color) { const match = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(String(color || "")); if (!match) return [255, 255, 255]; const value = match[1].length === 3 ? [...match[1]].map(x => x + x).join("") : match[1]; return [0, 2, 4].map(index => Number.parseInt(value.slice(index, index + 2), 16)); }
const linearRgb = value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
const displayRgb = value => 255 * (value <= .0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - .055);
const labEpsilon = 216 / 24389, labKappa = 24389 / 27;
const labForward = value => value > labEpsilon ? Math.cbrt(value) : (labKappa * value + 16) / 116;
const labReverse = value => value ** 3 > labEpsilon ? value ** 3 : (116 * value - 16) / labKappa;
function rgbToHcl(color) {
  const source = rgb(color), [red, green, blue] = source.map(value => linearRgb(value / 255));
  const x = labForward((.4124564 * red + .3575761 * green + .1804375 * blue) / .95047);
  const y = labForward(.2126729 * red + .7151522 * green + .072175 * blue);
  const z = labForward((.0193339 * red + .119192 * green + .9503041 * blue) / 1.08883);
  const a = 500 * (x - y), b = 200 * (y - z), hue = Math.atan2(b, a) * 180 / Math.PI;
  const c = Math.hypot(a, b);
  // d3's neutral Lab values have an undefined hue. Preserve that behavior
  // explicitly instead of letting tiny matrix-rounding residuals choose an
  // arbitrary hue for white, black, or gray input.
  return { h: source[0] === source[1] && source[1] === source[2] ? NaN : (hue < 0 ? hue + 360 : hue), c: source[0] === source[1] && source[1] === source[2] ? 0 : c, l: 116 * y - 16 };
}
function hclToRgb({ h, c, l }) {
  const radians = h * Math.PI / 180, a = Math.cos(radians) * c, b = Math.sin(radians) * c;
  const y = (l + 16) / 116, x = y + a / 500, z = y - b / 200;
  const X = .95047 * labReverse(x), Y = labReverse(y), Z = 1.08883 * labReverse(z);
  const channels = [3.2404542 * X - 1.5371385 * Y - .4985314 * Z, -.969266 * X + 1.8760108 * Y + .041556 * Z, .0556434 * X - .2040259 * Y + 1.0572252 * Z];
  return `rgb(${channels.map(channel => Math.round(Math.min(255, Math.max(0, displayRgb(channel)))).toString()).join(",")})`;
}
/** d3.interpolateHcl-compatible shortest-hue LCh interpolation for Wisp. */
export function interpolateWispHcl(startColor, endColor, amount) {
  const start = rgbToHcl(startColor), end = rgbToHcl(endColor), t = clamp(amount);
  let startHue = start.h, endHue = end.h;
  if (!Number.isFinite(startHue)) startHue = endHue;
  if (!Number.isFinite(endHue)) endHue = startHue;
  if (!Number.isFinite(startHue)) startHue = endHue = 0;
  let hueDelta = endHue - startHue;
  if (hueDelta > 180) hueDelta -= 360;
  else if (hueDelta < -180) hueDelta += 360;
  return hclToRgb({ h: startHue + hueDelta * t, c: start.c + (end.c - start.c) * t, l: start.l + (end.l - start.l) * t });
}
function snapshotColor(style, newest) {
  if (style.colorMode !== "gradient") return style.color || "#ffffff";
  const velocity = Math.hypot(newest.inputVx, newest.inputVy) / unitsPerPixel(style), exponent = 1.5;
  // d3.scale.pow() transforms the domain values before normalizing.  Clamp
  // the non-negative input before exponentiation so stationary holds stay at
  // the low color instead of producing NaN from a fractional negative power.
  const low = 10 ** exponent, high = 30 ** exponent, transformed = Math.max(0, velocity) ** exponent;
  const t = clamp((transformed - low) / (high - low));
  return interpolateWispHcl(style.startColor || style.color, style.endColor || style.color, t);
}
function drawCurve(curve) {
  if (!curve.length) return null;
  const points = [{ x: curve[0].x, y: curve[0].y }], lengthMinusOne = curve.length - 1;
  let p1 = curve[1];
  // Exact source bounds: i = 1; i < curve.length - 2; i += 1.
  for (let index = 1; index < lengthMinusOne - 1; index += 1) {
    const p2 = curve[index + 1], start = points.at(-1), end = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    for (let subdivision = 1; subdivision <= 3; subdivision += 1) {
      const t = subdivision / 3, inverse = 1 - t;
      points.push({ x: inverse * inverse * start.x + 2 * inverse * t * p1.x + t * t * end.x, y: inverse * inverse * start.y + 2 * inverse * t * p1.y + t * t * end.y });
    }
    p1 = p2;
  }
  return points.length > 1 ? points : null;
}
function step(state) {
  const curve = state.curve;
  const scale = state.unitsPerPixel;
  const recipe = state.recipe;
  state.time += 1;
  while (curve.length && curve[0].life === 0) curve.shift();
  for (let index = 0; index < curve.length; index += 1) {
    const particle = curve[index];
    const noiseValue = wispNoise(recipe.noiseOffset + particle.x * (recipe.noiseSpaceScale / scale) + 1000000, recipe.noiseOffset + particle.y * (recipe.noiseSpaceScale / scale) + 1000000, recipe.noiseOffset + recipe.noiseTimeScale * state.time, recipe.noiseOctaves, recipe.noiseFallout);
    let angle = recipe.noiseAngleOffset + recipe.noiseAngleScale * noiseValue;
    if (Number.isFinite(state.centerX) && Number.isFinite(state.centerY)) {
      // Preserve Wisp's original cross-wired center axes exactly. This is not
      // conventional atan2(dy, dx), and differs for off-center/non-square
      // source material.
      const centerAngle = Math.atan2(state.centerX - particle.y, state.centerY - particle.x);
      angle += centerAngle;
    }
    let accX = recipe.noiseForceScale * scale * Math.cos(angle), accY = recipe.noiseForceScale * scale * Math.sin(angle);
    accX += recipe.initialVelocityForceScale * particle.inputVx;
    accY += recipe.initialVelocityForceScale * particle.inputVy;
    // Wisp's odd `&&` test is about the raw pointer axes. Source mapping can
    // rotate/reflect a screen-horizontal hand velocity, so retain those axes
    // durably instead of changing whether the historical quirk takes effect.
    if (particle.inputScreenVx && particle.inputScreenVy) { particle.inputVx *= recipe.initialVelocityDecay; particle.inputVy *= recipe.initialVelocityDecay; }
    particle.x += (particle.x - particle.px) * recipe.friction + accX;
    particle.y += (particle.y - particle.py) * recipe.friction + accY;
    particle.px = particle.x; particle.py = particle.y;
    particle.life -= 1;
    if (index) {
      const prior = curve[index - 1], xoff = prior.x - particle.x, yoff = prior.y - particle.y, distance = Math.hypot(xoff, yoff);
      if (distance > recipe.restingDistance + .01 * scale) {
        const difference = recipe.rigidity * (recipe.restingDistance - distance) / distance, fx = difference * xoff, fy = difference * yoff;
        particle.x -= fx; prior.x += fx; particle.y -= fy; prior.y += fy;
      }
    }
  }
  const newest = curve.at(-1), points = drawCurve(curve);
  return newest && points ? { points, newest: { life: newest.life, inputVx: newest.inputVx, inputVy: newest.inputVy } } : null;
}
/** Computes transient complete-curve snapshots; no emission state is retained. */
export function prepareWispPath(points, style = {}, { tail = true } = {}) {
  if (!Array.isArray(points) || !points.length) return { emissions: [], bounds: null, maxParticles: 0, steps: 0 };
  const recipe = wispRecipe(style), state = { curve: [], time: 0, unitsPerPixel: unitsPerPixel(style), centerX: Number(style.wispCenterX), centerY: Number(style.wispCenterY), recipe }, emissions = [];
  let prior = { x: finite(points[0].x), y: finite(points[0].y) }, maxParticles = 0, steps = 0;
  const drawStep = () => { const emission = step(state); steps += 1; if (emission) emissions.push(emission); maxParticles = Math.max(maxParticles, state.curve.length); };
  for (const sample of points) {
    const next = { x: finite(sample.x), y: finite(sample.y) };
    const inputVx = next.x - prior.x, inputVy = next.y - prior.y;
    // Legacy/hand-authored points have no display-axis fields. In that case,
    // preserve the prior source-axis behavior rather than reinterpreting old
    // saved Wisp artwork.
    const inputScreenVx = Number.isFinite(Number(sample.inputScreenVx)) ? Number(sample.inputScreenVx) : inputVx;
    const inputScreenVy = Number.isFinite(Number(sample.inputScreenVy)) ? Number(sample.inputScreenVy) : inputVy;
    state.curve.push({ px: next.x, py: next.y, x: next.x, y: next.y, inputVx, inputVy, inputScreenVx, inputScreenVy, life: recipe.startLife });
    prior = next;
    for (let draw = 0; draw < recipe.drawsPerFrame; draw += 1) drawStep();
  }
  while (tail && state.curve.length) drawStep();
  const width = Math.max(.2, finite(style.size) / 8) * state.unitsPerPixel, pad = width / 2;
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const emission of emissions) for (const point of emission.points) { left = Math.min(left, point.x - pad); top = Math.min(top, point.y - pad); right = Math.max(right, point.x + pad); bottom = Math.max(bottom, point.y + pad); }
  return { emissions, bounds: Number.isFinite(left) ? { left, top, right, bottom } : null, maxParticles, steps };
}
export function renderWispPrepared(target, prepared, style = {}) {
  const painter = toBrushPainter(target), opacity = clamp(finite(style.opacity)), recipe = wispRecipe(style);
  const width = Math.max(.2, finite(style.size) / 8) * unitsPerPixel(style);
  for (const emission of prepared.emissions) painter.polyline(emission.points, { color: snapshotColor(style, emission.newest), opacity: opacity * recipe.startOpacity * emission.newest.life / recipe.startLife, width, cap: "round", join: "round", composite: "lighter" });
}
export function renderWispPath(target, points, style, options) { const prepared = prepareWispPath(points, style, options); renderWispPrepared(target, prepared, style); return prepared; }
