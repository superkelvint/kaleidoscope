import { GENERATORS, TAU, effectivePenOffset, validSpirographAnimation, validSpirographConfig } from "./generators.js";

const MAX_SAMPLES_PER_CONTOUR = 2048;
const MIN_PARAMETER_STEP = .002;

function validStyle(style) { return Boolean(style && typeof style === "object" && typeof style.brush === "string"); }
function validPoint(point) { return Number.isFinite(point?.x) && Number.isFinite(point?.y) && (point.holdCount === undefined || (Number.isFinite(point.holdCount) && point.holdCount >= 0)); }

function validGeneratedStroke(drawable) {
  if (drawable?.generator !== "spirograph" || drawable.generatorVersion !== GENERATORS.spirograph.version || !validStyle(drawable.style)) return false;
  if (!validSpirographConfig(drawable.config) || !validSpirographAnimation(drawable.animation)) return false;
  const { start, end } = drawable.domain || {};
  const step = drawable.sampling?.step;
  return drawable.sampling?.mode === "parameter" && Number.isFinite(start) && Number.isFinite(end) && end > start
    && end - start <= TAU * 8 && Number.isFinite(step) && step > 0 && Number(drawable.config.arms) <= 8;
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
      const x = point.x * cosine - point.y * sine, y = point.x * sine + point.y * cosine;
      points.push({ x: (x + .5) * width, y: (.5 - y) * height });
    }
    contours.push({ points, closed: true });
  }
  return { contours };
}
