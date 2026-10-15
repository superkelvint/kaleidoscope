import { toBrushPainter } from "./brush-painter.js";
import { interpolateHcl, resolveBrushMaterial, wispVelocityEnergy } from "./brush-material.js";

/*
 * Wisp is a source-faithful procedural paint brush inspired by WeaveSilk.
 * Fixed-cadence durable input samples drive one evolving particle chain. Each
 * input sample adds one particle, advances several simulation/deposition steps,
 * and paints the resulting low-alpha curve snapshots additively. On release it
 * stops accepting input and lets that same chain settle through its tail; once
 * complete, the stroke is static.
 *
 * Durable points plus style are a deterministic reconstruction recipe, not
 * retained authoritative simulation state. The live chain belongs to a
 * transient PaintSession. Ordinary completion therefore keeps its already
 * painted material and must not replay Wisp merely to “commit” it. Replay is
 * for restore/reconstruction, material rebuild, export, or cache loss.
 *
 * input sample
 *   -> add particle
 *   -> drawsPerFrame physics steps
 *   -> curve emission per step
 *   -> additive paint
 *
 * pointer-up
 *   -> stop input
 *   -> settle same particle chain
 *   -> PaintSession ends
 *   -> durable reconstruction record remains
 */

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
// Wisp's normal recipe is fixed at 8 octaves / .65 fallout.
// Precompute these once instead of rebuilding them for every particle step.
const WISP_OCTAVE_FREQUENCIES = Object.freeze([
  1, 2, 4, 8, 16, 32, 64, 128
]);

const WISP_OCTAVE_WEIGHTS = Object.freeze((() => {
  const weights = [];
  let effect = 1;

  for (let index = 0; index < 8; index += 1) {
    effect *= .65;
    weights.push(effect);
  }

  return weights;
})());

export function wispNoise3d(x, y, z) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);

  const dx = x - x0;
  const dy = y - y0;
  const dz = z - z0;

  // Precompute the offset versions instead of recalculating them in each
  // corner call.
  const dx1 = dx - 1;
  const dy1 = dy - 1;
  const dz1 = dz - 1;

  // Inline all eight lattice corners. This avoids allocating/calling the
  // `corner` closure for every noise evaluation.
  const c000 = gradientDot(
    gradientHash(x0, y0, z0),
    dx, dy, dz
  );

  const c100 = gradientDot(
    gradientHash(x0 + 1, y0, z0),
    dx1, dy, dz
  );

  const c010 = gradientDot(
    gradientHash(x0, y0 + 1, z0),
    dx, dy1, dz
  );

  const c110 = gradientDot(
    gradientHash(x0 + 1, y0 + 1, z0),
    dx1, dy1, dz
  );

  const c001 = gradientDot(
    gradientHash(x0, y0, z0 + 1),
    dx, dy, dz1
  );

  const c101 = gradientDot(
    gradientHash(x0 + 1, y0, z0 + 1),
    dx1, dy, dz1
  );

  const c011 = gradientDot(
    gradientHash(x0, y0 + 1, z0 + 1),
    dx, dy1, dz1
  );

  const c111 = gradientDot(
    gradientHash(x0 + 1, y0 + 1, z0 + 1),
    dx1, dy1, dz1
  );

  const u = fade(dx);
  const v = fade(dy);
  const w = fade(dz);

  const lower = mix(
    mix(c000, c100, u),
    mix(c010, c110, u),
    v
  );

  const upper = mix(
    mix(c001, c101, u),
    mix(c011, c111, u),
    v
  );

  return mix(lower, upper, w);
}

export function wispNoise(x, y, z, octaves = 8, fallout = .65) {
  // Hot path: this is what Wisp itself uses.
  //
  // Keep the individual += operations rather than turning this into one giant
  // expression so floating-point accumulation follows the same order as the
  // original implementation.
  if (octaves === 8 && fallout === .65) {
    let sum = 0;

    let frequency = WISP_OCTAVE_FREQUENCIES[0];
    sum += WISP_OCTAVE_WEIGHTS[0]
      * (1 + wispNoise3d(frequency * x, frequency * y, frequency * z))
      / 2;

    frequency = WISP_OCTAVE_FREQUENCIES[1];
    sum += WISP_OCTAVE_WEIGHTS[1]
      * (1 + wispNoise3d(frequency * x, frequency * y, frequency * z))
      / 2;

    frequency = WISP_OCTAVE_FREQUENCIES[2];
    sum += WISP_OCTAVE_WEIGHTS[2]
      * (1 + wispNoise3d(frequency * x, frequency * y, frequency * z))
      / 2;

    frequency = WISP_OCTAVE_FREQUENCIES[3];
    sum += WISP_OCTAVE_WEIGHTS[3]
      * (1 + wispNoise3d(frequency * x, frequency * y, frequency * z))
      / 2;

    frequency = WISP_OCTAVE_FREQUENCIES[4];
    sum += WISP_OCTAVE_WEIGHTS[4]
      * (1 + wispNoise3d(frequency * x, frequency * y, frequency * z))
      / 2;

    frequency = WISP_OCTAVE_FREQUENCIES[5];
    sum += WISP_OCTAVE_WEIGHTS[5]
      * (1 + wispNoise3d(frequency * x, frequency * y, frequency * z))
      / 2;

    frequency = WISP_OCTAVE_FREQUENCIES[6];
    sum += WISP_OCTAVE_WEIGHTS[6]
      * (1 + wispNoise3d(frequency * x, frequency * y, frequency * z))
      / 2;

    frequency = WISP_OCTAVE_FREQUENCIES[7];
    sum += WISP_OCTAVE_WEIGHTS[7]
      * (1 + wispNoise3d(frequency * x, frequency * y, frequency * z))
      / 2;

    return sum;
  }

  // Preserve the exported helper's existing behavior for tests/debugging or
  // any future recipe that uses non-default octave/fallout values.
  let effect = 1;
  let frequency = 1;
  let sum = 0;

  for (let index = 0; index < octaves; index += 1) {
    effect *= fallout;

    sum += effect
      * (1 + wispNoise3d(
        frequency * x,
        frequency * y,
        frequency * z
      ))
      / 2;

    frequency *= 2;
  }

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
/**
 * Freeze the source-faithful simulation recipe for a style snapshot.
 *
 * WISP_V1 is the WeaveSilk-faithful baseline. Version 2 artist controls adjust
 * that recipe without replacing its underlying simulation model: Density is
 * drawsPerFrame, and startLife scales with Density so Persistence remains
 * approximately a real-time persistence control. Dimensionless physics
 * constants are deliberately not source-unit scaled. Do not casually normalize,
 * simplify, or retune these constants: their calibrated relationships define
 * the brush's recognizable behavior.
 */
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
/** Backward-compatible export; the implementation now belongs to materials. */
export const interpolateWispHcl = interpolateHcl;
function writePoint(points, index, x, y) {
  const point = points[index] || (points[index] = {});
  point.x = x; point.y = y;
  return point;
}
/**
 * Build one backend-neutral polyline using the original WeaveSilk curve rule:
 * begin at curve[0], use the historical `i < curve.length - 2` loop bound,
 * then emit quadratic midpoint segments approximated by exactly three
 * subdivisions. The unusual bound and subdivision count are visual behavior.
 *
 * When supplied, reusablePoints is caller-owned scratch storage. Its point
 * objects may be rewritten and its length trimmed on every call; consumers may
 * use the returned points synchronously only unless they clone them first.
 */
function drawCurve(curve, reusablePoints = null) {
  if (!curve.length) return null;
  const points = reusablePoints || [];
  let pointCount = 0;
  writePoint(points, pointCount++, curve[0].x, curve[0].y);
  // A reusable buffer can still contain points from the preceding emission;
  // trim it before `points.at(-1)` becomes the next quadratic's start.
  points.length = pointCount;
  const lengthMinusOne = curve.length - 1;
  let p1 = curve[1];
  // Exact source bounds: i = 1; i < curve.length - 2; i += 1.
  for (let index = 1; index < lengthMinusOne - 1; index += 1) {
    const p2 = curve[index + 1], start = points.at(-1), end = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    for (let subdivision = 1; subdivision <= 3; subdivision += 1) {
      const t = subdivision / 3, inverse = 1 - t;
      writePoint(points, pointCount++, inverse * inverse * start.x + 2 * inverse * t * p1.x + t * t * end.x, inverse * inverse * start.y + 2 * inverse * t * p1.y + t * t * end.y);
    }
    p1 = p2;
  }
  points.length = pointCount;
  return points.length > 1 ? points : null;
}
/*
 * Wisp invariants / do not casually change:
 * - input has fixed-cadence semantics; duplicate stationary samples matter
 * - WISP_V1: drawsPerFrame = 5, startLife = 150, base opacity = .09
 * - deposition is HCL velocity color with round lighter compositing
 * - input momentum decay uses screen-axis `&&`, not source velocity magnitude
 * - center atan2 is cross-wired; position update is intentionally unusual
 * - neighboring particles use a zero-rest constraint
 * - unitsPerPixel converts frozen display calibration into source coordinates
 * - drawCurve's loop/subdivision semantics and the pointer release tail matter
 */

/**
 * Execute one exact simulation/deposition step, not one input frame.
 *
 * It increments simulation time; removes expired front particles; computes the
 * Perlin force in source/display-calibrated units; adds the center-relative
 * force angle and input momentum; applies historical momentum decay; performs
 * the historical position update; decreases life once; applies the zero-rest
 * neighboring-particle constraint; and emits the current chain as one curve.
 *
 * Several expressions in this function look mathematically unusual. They are
 * source-faithful behavior, not bugs. Do not "correct" them without comparing
 * against the original WeaveSilk implementation and updating regression tests.
 */
function step(state, scratch = null) {
  const curve = state.curve;
  const scale = state.unitsPerPixel;
  const recipe = state.recipe;
  // Time is measured in simulation/deposition steps, not input frames.
  state.time += 1;
  // The front ages out first; the remainder stays one ordered particle chain.
  while (curve.length && curve[0].life === 0) curve.shift();
  for (let index = 0; index < curve.length; index += 1) {
    const particle = curve[index];
    // Convert calibrated display-space noise parameters into frozen source
    // units before applying the source-faithful Perlin field.
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
    // Durable source-space input momentum is added after the intrinsic force.
    accX += recipe.initialVelocityForceScale * particle.inputVx;
    accY += recipe.initialVelocityForceScale * particle.inputVy;
    // The historical decay condition is exactly raw logical-screen axes:
    // `if (particle.inputScreenVx && particle.inputScreenVy)`. Do not replace
    // it with source-space velocity or a magnitude test.
    if (particle.inputScreenVx && particle.inputScreenVy) { particle.inputVx *= recipe.initialVelocityDecay; particle.inputVy *= recipe.initialVelocityDecay; }
    // This is the original unusual update, not conventional Verlet; retain the
    // assignment order exactly even though px/py become the new position.
    particle.x += (particle.x - particle.px) * recipe.friction + accX;
    particle.y += (particle.y - particle.py) * recipe.friction + accY;
    particle.px = particle.x; particle.py = particle.y;
    // A particle loses life once per simulation step.
    particle.life -= 1;
    if (index) {
      // Apply the historical neighboring-particle zero-rest constraint.
      const prior = curve[index - 1], xoff = prior.x - particle.x, yoff = prior.y - particle.y, distance = Math.hypot(xoff, yoff);
      if (distance > recipe.restingDistance + .01 * scale) {
        const difference = recipe.rigidity * (recipe.restingDistance - distance) / distance, fx = difference * xoff, fy = difference * yoff;
        particle.x -= fx; prior.x += fx; particle.y -= fy; prior.y += fy;
      }
    }
  }
  // One post-physics chain snapshot becomes this step's deposition curve.
  const newest = curve.at(-1), points = drawCurve(curve, scratch?.points);
  if (!newest || !points) return null;
  if (!scratch) return { points, newest: { life: newest.life, inputVx: newest.inputVx, inputVy: newest.inputVy } };
  scratch.newest.life = newest.life;
  scratch.newest.inputVx = newest.inputVx;
  scratch.newest.inputVy = newest.inputVy;
  return scratch;
}
/**
 * Create transient Wisp simulation state; it is never durable document state.
 * `curve` is the alive particle chain; `time` is the simulation-step clock;
 * `unitsPerPixel` freezes display-pixel -> source-unit calibration; `centerX`
 * / `centerY` freeze the source-space intrinsic force-field center; `recipe`
 * is the frozen simulation recipe; `prior` is the preceding durable sample;
 * and `steps` / `maxParticles` are diagnostics and replay metadata.
 */
export function createWispSimulation(style = {}) {
  return {
    curve: [], time: 0, unitsPerPixel: unitsPerPixel(style), centerX: Number(style.wispCenterX), centerY: Number(style.wispCenterY),
    recipe: wispRecipe(style), prior: null, maxParticles: 0, steps: 0
  };
}
/**
 * Consume exactly one durable input sample. Source-space velocity is computed
 * from `prior`, while separately supplied raw screen-axis velocity is retained
 * for the historical momentum-decay condition. This creates exactly one
 * particle, advances exactly recipe.drawsPerFrame steps, and synchronously
 * emits every non-null curve snapshot.
 *
 * Duplicate and stationary samples are meaningful; do not deduplicate zero
 * velocity input. Sampling cadence belongs outside this function. Changing
 * drawsPerFrame changes Wisp's deposition-density/time behavior.
 */
export function advanceWispSimulation(state, sample, emit = () => {}, scratch = null) {
  const next = { x: finite(sample?.x), y: finite(sample?.y) };
  const prior = state.prior || next;
  const inputVx = next.x - prior.x, inputVy = next.y - prior.y;
  const inputScreenVx = Number.isFinite(Number(sample?.inputScreenVx)) ? Number(sample.inputScreenVx) : inputVx;
  const inputScreenVy = Number.isFinite(Number(sample?.inputScreenVy)) ? Number(sample.inputScreenVy) : inputVy;
  state.curve.push({ px: next.x, py: next.y, x: next.x, y: next.y, inputVx, inputVy, inputScreenVx, inputScreenVy, life: state.recipe.startLife });
  state.prior = next;
  for (let draw = 0; draw < state.recipe.drawsPerFrame; draw += 1) {
    const emission = step(state, scratch); state.steps += 1;
    if (emission) emit(emission);
    state.maxParticles = Math.max(state.maxParticles, state.curve.length);
  }
}
/**
 * Deterministically drain the release tail: add no particles, keep stepping
 * the same chain, and finish only when it is empty. Live PaintSessions normally
 * settle this incrementally across display frames; synchronous draining exists
 * for reconstruction/replay.
 */
export function settleWispSimulation(state, emit = () => {}, scratch = null) {
  while (state.curve.length) {
    const emission = step(state, scratch); state.steps += 1;
    if (emission) emit(emission);
    state.maxParticles = Math.max(state.maxParticles, state.curve.length);
  }
}
function createWispBounds(style) {
  const width = Math.max(.2, finite(style.size) / 8) * unitsPerPixel(style), pad = width / 2;
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  return {
    add(emission) {
      for (const point of emission.points) { left = Math.min(left, point.x - pad); top = Math.min(top, point.y - pad); right = Math.max(right, point.x + pad); bottom = Math.max(bottom, point.y + pad); }
    },
    value() { return Number.isFinite(left) ? { left, top, right, bottom } : null; }
  };
}
function boundsForWispEmissions(emissions, style) {
  const bounds = createWispBounds(style);
  for (const emission of emissions) bounds.add(emission);
  return bounds.value();
}
function cloneEmission(emission) {
  return {
    points: emission.points.map(point => ({ x: point.x, y: point.y })),
    newest: { life: emission.newest.life, inputVx: emission.newest.inputVx, inputVy: emission.newest.inputVy }
  };
}

/**
 * Main one-shot deterministic streaming replay primitive. It runs the same
 * simulation as live Wisp, processes durable samples in order, optionally
 * settles the release tail, streams each emission synchronously, and can
 * accumulate bounds in that same pass without retaining emission history.
 *
 * Emission geometry may be backed by reusable storage. `onEmission()` may
 * inspect/use it synchronously but must clone it before retaining references
 * beyond the callback. Returned metadata supplies optional bounds, total
 * simulation steps, maximum particle count, and emission counts;
 * retainedEmissionCount: 0 is intentional.
 */
export function simulateWispPath(points, style = {}, { tail = true, onEmission = null, bounds = false } = {}) {
  if (!Array.isArray(points) || !points.length) return { bounds: null, maxParticles: 0, steps: 0, emissionCount: 0, peakEmissionPoints: 0, retainedEmissionCount: 0 };
  const state = createWispSimulation(style);
  const scratch = { points: [], newest: { life: 0, inputVx: 0, inputVy: 0 } };
  const measured = bounds ? createWispBounds(style) : null;
  let emissionCount = 0, peakEmissionPoints = 0;
  const emit = emission => {
    emissionCount += 1;
    peakEmissionPoints = Math.max(peakEmissionPoints, emission.points.length);
    measured?.add(emission);
    onEmission?.(emission);
  };
  for (const sample of points) advanceWispSimulation(state, sample, emit, scratch);
  if (tail) settleWispSimulation(state, emit, scratch);
  return { bounds: measured?.value() || null, maxParticles: state.maxParticles, steps: state.steps, emissionCount, peakEmissionPoints, retainedEmissionCount: 0 };
}
/**
 * Compatibility/retained-snapshot API. This intentionally clones and retains
 * every emission, using O(total emitted geometry) transient memory. Hot
 * rendering, preview, measurement, and ordinary reconstruction should prefer
 * streaming APIs. Use this only when multiple consumers genuinely require the
 * exact same retained emission sequence; do not route ordinary live/replay
 * paths through it.
 */
export function prepareWispPath(points, style = {}, { tail = true } = {}) {
  const emissions = [];
  const metadata = simulateWispPath(points, style, { tail, bounds: true, onEmission: emission => emissions.push(cloneEmission(emission)) });
  return { emissions, bounds: metadata.bounds, maxParticles: metadata.maxParticles, steps: metadata.steps };
}
/**
 * Render the compatibility retained snapshots from prepareWispPath(). This is
 * for consumers that genuinely already need retained geometry, not a preferred
 * simulation or live-rendering path.
 */
export function renderWispPrepared(target, prepared, style = {}) {
  const painter = toBrushPainter(target), opacity = clamp(finite(style.opacity)), recipe = wispRecipe(style);
  const width = Math.max(.2, finite(style.size) / 8) * unitsPerPixel(style);
  for (const emission of prepared.emissions) {
    const material = resolveBrushMaterial(style, { energy: wispVelocityEnergy(emission.newest, unitsPerPixel(style)), opacityScale: opacity * recipe.startOpacity * emission.newest.life / recipe.startLife, profile: "wisp" });
    painter.polyline(emission.points, { ...material, width, cap: "round", join: "round" });
  }
}
/**
 * Thin rendering consumer over simulateWispPath(), deliberately without a
 * second simulation implementation. Every emission preserves exact emitted
 * geometry, HCL velocity-derived color, opacity = style opacity × Wisp start
 * opacity × normalized newest-particle life, source-scaled line width, round
 * cap/join, and "lighter" compositing.
 */
export function renderWispPath(target, points, style = {}, options = {}) {
  const painter = toBrushPainter(target), opacity = clamp(finite(style.opacity)), recipe = wispRecipe(style);
  const width = Math.max(.2, finite(style.size) / 8) * unitsPerPixel(style);
  return simulateWispPath(points, style, {
    ...options,
    onEmission(emission) {
      const material = resolveBrushMaterial(style, { energy: wispVelocityEnergy(emission.newest, unitsPerPixel(style)), opacityScale: opacity * recipe.startOpacity * emission.newest.life / recipe.startLife, profile: "wisp" });
      painter.polyline(emission.points, { ...material, width, cap: "round", join: "round" });
      options.onEmission?.(emission);
    }
  });
}

/**
 * Run the same deterministic simulation as rendering but consume emissions
 * solely for bounds. This remains streaming and must not construct emissions[].
 * Calling measureWispPath() and renderWispPath() separately runs two complete
 * simulations; hot paths needing both should accumulate bounds during the
 * rendering simulation instead.
 */
export function measureWispPath(points, style = {}, options = {}) {
  return simulateWispPath(points, style, { ...options, bounds: true });
}

/**
 * Despite the legacy name, this is Wisp's transient PaintSession simulator for
 * one gesture, not a durable preview object. It owns live simulation state,
 * consumes append-only samples, accumulates only the current paint delta and
 * total visible bounds, enters finishing on pointer-up, advances a bounded
 * release-tail budget per display frame, tracks tailSteps, and knows when its
 * particle chain is done. It creates no durable document state.
 *
 * After material/raster loss, replay() reconstructs exactly the already-visible
 * pixels from the consumed input prefix plus exactly tailSteps. It must not
 * accidentally settle the entire future tail. `advance()` consumes newly
 * arrived input; `settle()` advances release tail without input; `replay()`
 * rebuilds previously visible transient pixels.
 */
export function createWispLivePreview(drawable) {
  const style = structuredClone(drawable.style), samples = [], state = createWispSimulation(style);
  let delta = [], finishing = false, tailSteps = 0;
  const accumulatedBounds = createWispBounds(style);
  const styleFingerprint = JSON.stringify(style);
  let lastAdvanceSampleCount = 0;
  return {
    // Additive emissions must be composed over the already-visible material.
    // The rasterizer consumes this capability without knowing this brush.
    requiresBackdrop: true,
    acceptsStyle(nextStyle) { return JSON.stringify(nextStyle) === styleFingerprint; },
    // PaintSessions are append-only. Their owner supplies only the new suffix;
    // `samples` remains solely for reconstruction after a material rebuild.
    advance(newSamples) {
      if (!Array.isArray(newSamples)) return false;
      delta = [];
      lastAdvanceSampleCount = newSamples.length;
      for (const nextSample of newSamples) {
        const sample = structuredClone(nextSample); samples.push(sample);
        advanceWispSimulation(state, sample, emission => { delta.push(emission); accumulatedBounds.add(emission); });
      }
      return delta.length > 0;
    },
    deltaBounds() { return boundsForWispEmissions(delta, style); },
    paintDelta(target) { renderWispPrepared(target, { emissions: delta }, style); },
    finishDelta() { delta = []; },
    beginFinish() { finishing = true; },
    // Advance a bounded part of the release tail. This shares the exact
    // simulator used by replay and avoids a synchronous mouse-up drain.
    settle(stepBudget = state.recipe.drawsPerFrame) {
      if (!finishing || !state.curve.length) return false;
      delta = [];
      for (let stepIndex = 0; stepIndex < stepBudget && state.curve.length; stepIndex += 1) {
        const emission = step(state); state.steps += 1; tailSteps += 1;
        if (emission) { delta.push(emission); accumulatedBounds.add(emission); }
        state.maxParticles = Math.max(state.maxParticles, state.curve.length);
      }
      return delta.length > 0;
    },
    get isFinished() { return finishing && !state.curve.length; },
    get bounds() { return accumulatedBounds.value(); },
    // Reconstruct exactly the already-visible simulation state after a canvas
    // rebuild: durable input prefix plus the settled tail frames to date.
    replay(target) {
      const replayState = createWispSimulation(style);
      const paint = emission => renderWispPrepared(target, { emissions: [emission] }, style);
      for (const sample of samples) advanceWispSimulation(replayState, sample, paint);
      for (let stepIndex = 0; stepIndex < tailSteps && replayState.curve.length; stepIndex += 1) {
        const emission = step(replayState); replayState.steps += 1;
        if (emission) paint(emission);
      }
    },
    get activeParticleCount() { return state.curve.length; },
    get consumedSampleCount() { return samples.length; },
    get lastAdvanceSampleCount() { return lastAdvanceSampleCount; },
    dispose() { delta = []; samples.length = 0; state.curve.length = 0; }
  };
}
