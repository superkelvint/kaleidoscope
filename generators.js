const TAU = Math.PI * 2;

export const SPIROGRAPH_LIMITS = {
  lobes: [3, 12], penOffset: [0, 2], reach: [.05, .48], rotation: [0, TAU], arms: [1, 8]
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

export function effectivePenOffset(config, animation, time) {
  const base = Number(config.penOffset);
  if (!animation || !Number(animation.amount) || !Number(animation.speed)) return base;
  const motion = Math.sin(Number(animation.phase) + Number(time) * Number(animation.speed) * TAU);
  return base + motion * Math.min(base, 2 - base) * Number(animation.amount);
}

export const GENERATORS = {
  spirograph: {
    id: "spirograph",
    version: 1,
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
  }
};

export { TAU };
