const TAU = Math.PI * 2;
const GUILLOCHE_SECONDARY_AMPLITUDE_EXCURSION = .125;
const GUILLOCHE_ROTATION_EXCURSION = TAU * .1;

export const SPIROGRAPH_LIMITS = {
  lobes: [3, 12], penOffset: [0, 2], reach: [.05, .48], rotation: [0, TAU], arms: [1, 8]
};

export const GUILLOCHE_ROSETTE_LIMITS = {
  petals: [1, 24], secondaryFrequency: [1, 24], primaryAmplitude: [0, .25],
  secondaryAmplitude: [0, .25], baseRadius: [.05, .48], rotation: [0, TAU],
  lineCount: [1, 40], lineSpacing: [.001, .02], phaseOffset: [0, TAU],
  roundness: [.35, 2], angularModulation: [0, .75], angularFrequency: [1, 16]
};

function finiteInRange(value, [min, max], { integer = false } = {}) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max && (!integer || Number.isInteger(number));
}

export function validSpirographConfig(config) {
  return Boolean(config) && finiteInRange(config.lobes, SPIROGRAPH_LIMITS.lobes, { integer: true })
    && finiteInRange(config.penOffset, SPIROGRAPH_LIMITS.penOffset)
    && finiteInRange(config.reach, SPIROGRAPH_LIMITS.reach)
    && finiteInRange(config.rotation, SPIROGRAPH_LIMITS.rotation)
    && Number.isFinite(Number(config.phase))
    && finiteInRange(config.arms, SPIROGRAPH_LIMITS.arms, { integer: true });
}

export function validSpirographAnimation(animation) {
  return Boolean(animation) && Number.isFinite(Number(animation.amount)) && Number(animation.amount) >= 0 && Number(animation.amount) <= 1
    && Number.isFinite(Number(animation.speed)) && Number(animation.speed) >= 0 && Number.isFinite(Number(animation.phase));
}

export function validGuillocheRosetteConfig(config) {
  return Boolean(config)
    && finiteInRange(config.petals, GUILLOCHE_ROSETTE_LIMITS.petals, { integer: true })
    && finiteInRange(config.secondaryFrequency, GUILLOCHE_ROSETTE_LIMITS.secondaryFrequency, { integer: true })
    && finiteInRange(config.primaryAmplitude, GUILLOCHE_ROSETTE_LIMITS.primaryAmplitude)
    && finiteInRange(config.secondaryAmplitude, GUILLOCHE_ROSETTE_LIMITS.secondaryAmplitude)
    && finiteInRange(config.baseRadius, GUILLOCHE_ROSETTE_LIMITS.baseRadius)
    && finiteInRange(config.rotation, GUILLOCHE_ROSETTE_LIMITS.rotation)
    && finiteInRange(config.lineCount, GUILLOCHE_ROSETTE_LIMITS.lineCount, { integer: true })
    && finiteInRange(config.lineSpacing, GUILLOCHE_ROSETTE_LIMITS.lineSpacing)
    && finiteInRange(config.phaseOffset, GUILLOCHE_ROSETTE_LIMITS.phaseOffset)
    && (config.roundness === undefined || finiteInRange(config.roundness, GUILLOCHE_ROSETTE_LIMITS.roundness))
    && (config.angularModulation === undefined || finiteInRange(config.angularModulation, GUILLOCHE_ROSETTE_LIMITS.angularModulation))
    && (config.angularFrequency === undefined || finiteInRange(config.angularFrequency, GUILLOCHE_ROSETTE_LIMITS.angularFrequency, { integer: true }));
}

export function validGuillocheRosetteAnimation(animation) {
  if (!animation || !finiteInRange(animation.amount, [0, 1]) || !finiteInRange(animation.speed, [0, 2])) return false;
  const targets = animation.targets;
  return Boolean(targets) && ["phaseOffset", "secondaryAmplitude", "secondaryFrequency", "rotation"].every(key => typeof targets[key] === "boolean");
}

export function guillocheRosetteDependsOnTime(animation) {
  return validGuillocheRosetteAnimation(animation) && Number(animation.amount) !== 0 && Number(animation.speed) !== 0 && Object.values(animation.targets).some(Boolean);
}

/** Per-frame values shared by every line in an animated guilloché family. */
export function prepareGuillocheFrame(config, animation, time) {
  const amount = Number(animation?.amount) || 0;
  const speed = Number(animation?.speed) || 0;
  const targets = animation?.targets || {};
  const timePhase = time * speed * TAU;
  return {
    phaseOffset: config.phaseOffset + (targets.phaseOffset ? Math.sin(timePhase) * TAU * .18 * amount : 0),
    // Runtime amplitude is intentionally signed: a zero-valued durable slider
    // can still animate, and negative values are a harmless phase inversion.
    secondaryAmplitude: config.secondaryAmplitude + (targets.secondaryAmplitude ? Math.sin(timePhase + TAU / 3) * GUILLOCHE_SECONDARY_AMPLITUDE_EXCURSION * amount : 0),
    // Blend two closed integer-frequency curves instead of sampling a
    // fractional frequency, which would leave a seam at the contour closure.
    frequencyMorph: targets.secondaryFrequency ? (Math.sin(timePhase + TAU * 2 / 3) + 1) * .5 * amount : 0,
    rotation: config.rotation + (targets.rotation ? Math.sin(timePhase + Math.PI / 3) * GUILLOCHE_ROTATION_EXCURSION * amount : 0)
  };
}

/** Symmetric cosine shaping; exponent 1 preserves the original sine-wave recipe. */
export function shapedCos(angle, roundness = 1) {
  const cosine = Math.cos(angle);
  return Math.sign(cosine) * Math.abs(cosine) ** roundness;
}

export function guillocheSecondaryWave(config, t, frame) {
  const roundness = config.roundness ?? 1;
  const base = shapedCos(config.secondaryFrequency * t + frame.phaseOffset, roundness);
  if (!frame.frequencyMorph) return base;
  const next = shapedCos((config.secondaryFrequency + 1) * t + frame.phaseOffset, roundness);
  return base + (next - base) * frame.frequencyMorph;
}

export function effectivePenOffset(config, animation, time) {
  const base = Number(config.penOffset);
  if (!animation || !Number(animation.amount) || !Number(animation.speed)) return base;
  const motion = Math.sin(Number(animation.phase) + Number(time) * Number(animation.speed) * TAU);
  return base + motion * Math.min(base, 2 - base) * Number(animation.amount);
}

export const GENERATORS = {
  spirograph: {
    id: "spirograph",
    version: 2,
    // Keep the first preview inside the canonical source region sampled by the
    // default wallpaper/motif. Larger reaches remain available in the UI.
    defaults: { lobes: 5, penOffset: 1.2, reach: .1, rotation: 0, phase: 0, arms: 1 },
    sample(config, t) {
      const R = 1, r = 1 / config.lobes, d = r * config.penOffset;
      const x = (R - r) * Math.cos(t) + d * Math.cos(((R - r) / r) * t + config.phase);
      const y = (R - r) * Math.sin(t) - d * Math.sin(((R - r) / r) * t + config.phase);
      const cosine = Math.cos(config.rotation), sine = Math.sin(config.rotation);
      return { x: (x * cosine - y * sine) * config.reach, y: (x * sine + y * cosine) * config.reach };
    },
    period() { return TAU; }
  },
  guillocheRosette: {
    id: "guillocheRosette",
    version: 2,
    defaults: { petals: 8, secondaryFrequency: 13, primaryAmplitude: .08, secondaryAmplitude: .035, baseRadius: .2, rotation: 0, lineCount: 18, lineSpacing: .006, phaseOffset: 0, roundness: 1, angularModulation: 0, angularFrequency: 3 },
    sample(config, t, animation, time, lineOffset = 0) {
      const frame = prepareGuillocheFrame(config, animation, time);
      const roundness = config.roundness ?? 1;
      const radius = config.baseRadius + lineOffset + config.primaryAmplitude * shapedCos(config.petals * t, roundness) + frame.secondaryAmplitude * guillocheSecondaryWave(config, t, frame);
      const angle = t + frame.rotation + (config.angularModulation ?? 0) * Math.sin((config.angularFrequency ?? 3) * t + frame.phaseOffset);
      return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
    },
    period() { return TAU; }
  }
};

export { TAU };
