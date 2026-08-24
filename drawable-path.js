import { GENERATORS, TAU, effectivePenOffset, validSpirographAnimation, validSpirographConfig } from "./generators.js";

const MAX_SAMPLES_PER_CONTOUR = 2048;
const MIN_PARAMETER_STEP = .002;
const TILE_PLACEMENT_LIMITS = { spacing: [.15, .9], radius: 2 };

function validStyle(style) { return Boolean(style && typeof style === "object" && typeof style.brush === "string"); }
function validPoint(point) { return Number.isFinite(point?.x) && Number.isFinite(point?.y) && (point.holdCount === undefined || (Number.isFinite(point.holdCount) && point.holdCount >= 0)); }

function validGeneratedStroke(drawable) {
  if (drawable?.generator !== "spirograph" || drawable.generatorVersion !== GENERATORS.spirograph.version || !validStyle(drawable.style)) return false;
  if (!validSpirographConfig(drawable.config) || !validSpirographAnimation(drawable.animation)) return false;
  const { start, end } = drawable.domain || {};
  const step = drawable.sampling?.step;
  return drawable.sampling?.mode === "parameter" && Number.isFinite(start) && Number.isFinite(end) && end > start
    && end - start <= TAU * 8 && Number.isFinite(step) && step > 0 && Number(drawable.config.arms) <= 8
    && Boolean(placementOf(drawable));
}

function placementOf(drawable) {
  const placement = drawable?.placement;
  // Recipes created before placement existed preserve their original, single
  // contour behavior exactly.
  if (placement === undefined) return { mode: "single", spacing: .9 };
  if (!placement || !["single", "tile"].includes(placement.mode)) return null;
  const spacing = Number(placement.spacing);
  if (!Number.isFinite(spacing) || spacing < TILE_PLACEMENT_LIMITS.spacing[0] || spacing > TILE_PLACEMENT_LIMITS.spacing[1]) return null;
  return { mode: placement.mode, spacing };
}

function normalizedSpirographContours(drawable, time) {
  const generator = GENERATORS[drawable.generator];
  const { start, end } = drawable.domain;
  const requestedStep = Math.max(MIN_PARAMETER_STEP, Number(drawable.sampling.step));
  const count = Math.min(MAX_SAMPLES_PER_CONTOUR, Math.max(2, Math.ceil((end - start) / requestedStep) + 1));
  const config = { ...drawable.config, penOffset: effectivePenOffset(drawable.config, drawable.animation, time) };
  const sector = TAU / config.lobes;
  const contours = [];
  for (let arm = 0; arm < config.arms; arm += 1) {
    const armRotation = sector * arm / config.arms;
    const cosine = Math.cos(armRotation), sine = Math.sin(armRotation);
    const points = [];
    for (let index = 0; index < count; index += 1) {
      const point = generator.sample(config, start + (end - start) * index / (count - 1));
      points.push({ x: point.x * cosine - point.y * sine, y: point.x * sine + point.y * cosine });
    }
    contours.push({ points, closed: true });
  }
  return contours;
}

export function isDrawable(drawable) {
  if (drawable?.kind === "pathStroke") return Array.isArray(drawable.points) && validStyle(drawable.style) && drawable.points.every(validPoint);
  if (drawable?.kind === "generatedStroke") return validGeneratedStroke(drawable);
  return false;
}

export function drawableDependsOnTime(drawable) {
  return drawable?.kind === "generatedStroke" && Number(drawable.animation?.amount) !== 0 && Number(drawable.animation?.speed) !== 0;
}

export function derivePath(drawable, { width, height, time = 0 } = {}) {
  if (drawable?.kind === "pathStroke") return { contours: [{ points: drawable.points, closed: false }] };
  if (!validGeneratedStroke(drawable) || !Number.isFinite(width) || !Number.isFinite(height)) return { contours: [] };
  const placement = placementOf(drawable);
  if (!placement) return { contours: [] };
  // Generate the animated recipe once, then place copies before converting
  // normalized coordinates to source pixels.
  const baseContours = normalizedSpirographContours(drawable, time);
  const offsets = placement.mode === "tile"
    ? Array.from({ length: (TILE_PLACEMENT_LIMITS.radius * 2 + 1) ** 2 }, (_, index) => ({
      x: (index % (TILE_PLACEMENT_LIMITS.radius * 2 + 1) - TILE_PLACEMENT_LIMITS.radius) * placement.spacing,
      y: (Math.floor(index / (TILE_PLACEMENT_LIMITS.radius * 2 + 1)) - TILE_PLACEMENT_LIMITS.radius) * placement.spacing
    }))
    : [{ x: 0, y: 0 }];
  const contours = [];
  for (const offset of offsets) for (const contour of baseContours) contours.push({
    closed: contour.closed,
    points: contour.points.map(point => ({ x: (point.x + offset.x + .5) * width, y: (.5 - point.y - offset.y) * height }))
  });
  return { contours };
}
