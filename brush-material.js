// Shared, backend-neutral brush material resolution. Geometry and random
// sampling deliberately stay in their owning brushes; this file only turns
// stable semantic signals into paint instruction fields.
const clamp = value => Math.min(1, Math.max(0, Number(value) || 0));
// Additive ordinary brushes build their luminosity across repeated deposits.
// This is deliberately distinct from Wisp's source-faithful .09 simulation
// alpha and from readable source-over brush bodies.
const PROFILE_DEPOSITION_ALPHA = Object.freeze({ additive: .18, wisp: 1, texture: 1, fiber: 1, pen: 1 });

function rgb(color) {
  const match = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(String(color || ""));
  if (!match) return [255, 255, 255];
  const value = match[1].length === 3 ? [...match[1]].map(x => x + x).join("") : match[1];
  return [0, 2, 4].map(index => Number.parseInt(value.slice(index, index + 2), 16));
}
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
  const neutral = source[0] === source[1] && source[1] === source[2];
  return { h: neutral ? NaN : (hue < 0 ? hue + 360 : hue), c: neutral ? 0 : Math.hypot(a, b), l: 116 * y - 16 };
}
function hclToRgb({ h, c, l }) {
  const radians = h * Math.PI / 180, a = Math.cos(radians) * c, b = Math.sin(radians) * c;
  const y = (l + 16) / 116, x = y + a / 500, z = y - b / 200;
  const X = .95047 * labReverse(x), Y = labReverse(y), Z = 1.08883 * labReverse(z);
  const channels = [3.2404542 * X - 1.5371385 * Y - .4985314 * Z, -.969266 * X + 1.8760108 * Y + .041556 * Z, .0556434 * X - .2040259 * Y + 1.0572252 * Z];
  return `rgb(${channels.map(channel => Math.round(Math.min(255, Math.max(0, displayRgb(channel)))).toString()).join(",")})`;
}

/** d3.interpolateHcl-compatible shortest-hue LCh interpolation. */
export function interpolateHcl(startColor, endColor, amount) {
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

export function wispVelocityEnergy(newest, unitsPerPixel = 1) {
  const scale = Number.isFinite(Number(unitsPerPixel)) && Number(unitsPerPixel) > 0 ? Number(unitsPerPixel) : 1;
  const velocity = Math.hypot(Number(newest?.inputVx) || 0, Number(newest?.inputVy) || 0) / scale;
  const exponent = 1.5, low = 10 ** exponent, high = 30 ** exponent;
  return clamp((Math.max(0, velocity) ** exponent - low) / (high - low));
}

/** Stable source-space proxy for pointer speed, suitable for replay. */
export function contourEnergy(points, index, size, { closed = false } = {}) {
  if (!points?.length) return 0;
  const point = points[index];
  const neighbor = direction => {
    const limit = closed ? points.length - 1 : points.length;
    for (let step = 1; step < limit; step += 1) {
      let candidate = index + direction * step;
      if (closed) candidate = (candidate % points.length + points.length) % points.length;
      else if (candidate < 0 || candidate >= points.length) return null;
      const next = points[candidate], dx = next.x - point.x, dy = next.y - point.y;
      if (Math.hypot(dx, dy) > .0001) return { point: next, distance: Math.hypot(dx, dy) };
    }
    return null;
  };
  const prior = neighbor(-1), next = neighbor(1);
  const before = prior?.distance || 0, after = next?.distance || 0;
  const segment = before && after ? (before + after) / 2 : before || after;
  const unit = Math.max(.25, Number(size) || 1);
  if (closed && prior && next) {
    // Generated contours are closed semantic geometry. Their material energy
    // comes from the local tangent turn (curvature), not from progress around
    // the loop or its arbitrary sampling cadence.
    const incomingX = (point.x - prior.point.x) / before, incomingY = (point.y - prior.point.y) / before;
    const outgoingX = (next.point.x - point.x) / after, outgoingY = (next.point.y - point.y) / after;
    const turn = Math.acos(Math.min(1, Math.max(-1, incomingX * outgoingX + incomingY * outgoingY)));
    return clamp(turn * unit / Math.max(segment, unit * .1));
  }
  // Open strokes must be causal: immediate painting only has the preceding
  // durable sample, and replay must resolve exactly the same signal. The
  // initial stamp is intentionally quiet rather than peeking at its future.
  return clamp((before / unit - .35) / 2.65);
}

/** The causal physical-distance progress used by both live and replay paint. */
export function contourProgress(points, index, size) {
  let distance = 0;
  for (let cursor = 1; cursor < Math.min(index, points?.length || 0); cursor += 1) {
    distance += Math.hypot(points[cursor].x - points[cursor - 1].x, points[cursor].y - points[cursor - 1].y);
  }
  return clamp(distance / Math.max(Number(size) * 24, 1));
}

/** Resolve paint fields for materialVersion 1 styles. */
export function resolveBrushMaterial(style = {}, { energy = 0, progress = 0, variation = 0, opacityScale = 1, profile = "pen", colorSteps = 0 } = {}) {
  const gradient = style.colorMode === "gradient";
  // Wisp's historic velocity mapping is intentionally energy-only. Other
  // brushes combine durable contour energy with path progress very gently.
  // Shared material is driven principally by durable local energy. Progress
  // is only a gentle directional bias, so closed generated contours light up
  // from curvature rather than reading as a simple around-the-loop ramp.
  const rawAmount = profile === "wisp" ? clamp(energy) : clamp(gradient ? (.84 * energy + .16 * progress + .04 * variation) : 0);
  // Texture tips cache by final tint color. Quantize after combining every
  // material signal so local energy cannot create an unbounded tint stream.
  const steps = Math.max(0, Math.floor(Number(colorSteps) || 0));
  const amount = steps > 1 ? Math.round(rawAmount * (steps - 1)) / (steps - 1) : rawAmount;
  const color = gradient
    ? interpolateHcl(style.startColor || style.color, style.endColor || style.color, amount)
    : (style.color || "#ffffff");
  // Wisp's original material couples velocity to colour only. Its deposited
  // alpha is exactly supplied by the simulation caller, including for legacy
  // strokes with no materialVersion.
  const dynamicOpacity = gradient && profile !== "texture" && profile !== "wisp" ? 1 + (clamp(energy) - .5) * .12 : 1;
  const composite = profile === "wisp" ? "lighter" : profile === "additive" ? "lighter" : "source-over";
  const depositionAlpha = PROFILE_DEPOSITION_ALPHA[profile] ?? 1;
  return { color, opacity: clamp(clamp(opacityScale) * depositionAlpha * dynamicOpacity), composite };
}
