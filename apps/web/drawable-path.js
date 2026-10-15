import { GENERATORS, TAU, effectivePenOffset, guillocheRosetteDependsOnTime, guillocheSecondaryWave, prepareGuillocheFrame, shapedCos, validGuillocheRosetteAnimation, validGuillocheRosetteConfig, validSpirographAnimation, validSpirographConfig } from "./generators.js";
import { measure } from "./perf.js";

const MAX_SAMPLES_PER_CONTOUR = 2048;
const MIN_PARAMETER_STEP = .002;
function validMaterial(material) { return Boolean(material && typeof material === "object" && typeof material.type === "string"); }
function validPoint(point) { return Number.isFinite(point?.x) && Number.isFinite(point?.y) && (point.holdCount === undefined || (Number.isFinite(point.holdCount) && point.holdCount >= 0)); }

function validGeneratedStroke(drawable) {
  if (!GENERATORS[drawable?.generator] || drawable.generatorVersion !== GENERATORS[drawable.generator].version || !validMaterial(drawable.material)) return false;
  const validRecipe = drawable.generator === "spirograph"
    ? validSpirographConfig(drawable.config) && validSpirographAnimation(drawable.animation)
    : drawable.generator === "guillocheRosette"
      && validGuillocheRosetteConfig(drawable.config) && validGuillocheRosetteAnimation(drawable.animation);
  if (!validRecipe) return false;
  const { start, end } = drawable.domain || {};
  const step = drawable.sampling?.step;
  return drawable.sampling?.mode === "parameter" && Number.isFinite(start) && Number.isFinite(end) && end > start
    && end - start <= TAU * 8 && Number.isFinite(step) && step > 0 && (drawable.generator !== "spirograph" || Number(drawable.config.arms) <= 8)
    && drawable.placement === undefined;
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

function normalizedGuillocheRosetteContours(drawable, time) {
  return measure("guilloche geometry", () => {
    const config = { ...GENERATORS.guillocheRosette.defaults, ...drawable.config }, { start, end } = drawable.domain;
    const requestedStep = Math.max(MIN_PARAMETER_STEP, Number(drawable.sampling.step));
    const count = Math.min(MAX_SAMPLES_PER_CONTOUR, Math.max(2, Math.ceil((end - start) / requestedStep) + 1));
    const frame = prepareGuillocheFrame(config, drawable.animation, time);
    const contours = Array.from({ length: config.lineCount }, () => ({ points: [], closed: true }));
    const lineOffsets = Array.from({ length: config.lineCount }, (_, line) => (line - (config.lineCount - 1) / 2) * config.lineSpacing);
    for (let index = 0; index < count; index += 1) {
      const t = start + (end - start) * index / (count - 1);
      const petalAngle = config.petals * t;
      const radius = config.baseRadius + config.primaryAmplitude * shapedCos(petalAngle, config.roundness) + frame.secondaryAmplitude * guillocheSecondaryWave(config, t, frame);
      const angle = t + frame.rotation + config.angularModulation * Math.sin(config.angularFrequency * t + frame.phaseOffset), cosine = Math.cos(angle), sine = Math.sin(angle);
      for (let line = 0; line < config.lineCount; line += 1) contours[line].points.push({ x: (radius + lineOffsets[line]) * cosine, y: (radius + lineOffsets[line]) * sine });
    }
    return contours;
  });
}

export function isDrawable(drawable) {
  if (drawable?.kind === "pathStroke") return Array.isArray(drawable.gesture?.points) && validMaterial(drawable.material) && typeof drawable.geometry?.type === "string" && drawable.gesture.points.every(validPoint);
  if (drawable?.kind === "generatedStroke") return validGeneratedStroke(drawable);
  return false;
}

export function drawableDependsOnTime(drawable) {
  if (drawable?.kind !== "generatedStroke") return false;
  if (drawable.generator === "spirograph") return Number(drawable.animation?.amount) !== 0 && Number(drawable.animation?.speed) !== 0;
  return drawable.generator === "guillocheRosette" && guillocheRosetteDependsOnTime(drawable.animation);
}

export function derivePath(drawable, { width, height, time = 0 } = {}) {
  return measure("derivePath", () => {
  if (drawable?.kind === "pathStroke") return { contours: [{ points: drawable.gesture?.points || [], closed: false }], instances: [{ x: 0, y: 0 }] };
  if (!validGeneratedStroke(drawable) || !Number.isFinite(width) || !Number.isFinite(height)) return { contours: [] };
  // Geometry belongs to one canonical location in the continuous drawing
  // world; generated recipes have no placement.
  const baseContours = drawable.generator === "spirograph" ? normalizedSpirographContours(drawable, time) : normalizedGuillocheRosetteContours(drawable, time);
  const contours = baseContours.map(contour => ({
    closed: contour.closed,
    points: contour.points.map(point => ({ x: (point.x + .5) * width, y: (.5 - point.y) * height }))
  }));
  return { contours, instances: [{ x: 0, y: 0 }] };
  });
}
