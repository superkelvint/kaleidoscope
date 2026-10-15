import { isDrawable } from "./drawable-path.js";

const BRUSHES = new Set(["pen", "ribbon", "calligraphy", "spray", "texture", "fiber", "hair", "wisp"]);
const GEOMETRIES = new Set(["freehand", ...BRUSHES]);
const MATERIALS = new Set(["ink", "silk", "adapter"]);
const PALETTE = ["color", "colorMode", "startColor", "endColor", "opacity", "composite"];
const MAPPING = ["wispUnitsPerPixel", "wispCenterX", "wispCenterY"];
const GEOMETRY_OPTIONS = { ribbon: ["lines", "span"], calligraphy: ["nibRatio"] };
const BRUSH_OPTIONS = {
  pen: ["taper"], ribbon: [], calligraphy: [], spray: ["density", "particleSize"], texture: ["textureId", "spacing", "rotationMode"],
  fiber: ["version", "assistLevel", "fibers", "gravity", "branching", "curl", "spread", "wispiness"],
  hair: ["version", "assistLevel", "fibers", "gravity", "branching", "curl", "spread", "wispiness"],
  wisp: ["version", "energy", "momentum", "turbulence", "persistence", "density"]
};
const NUMBERS = new Set(["size", "width", "opacity", "seed", "version", "lines", "span", "nibRatio", "density", "particleSize", "spacing", "assistLevel", "fibers", "gravity", "branching", "curl", "spread", "wispiness", "energy", "momentum", "turbulence", "persistence", "strands", "wander", "glow", "pull", "drag", "schemaVersion", "materialVersion", ...MAPPING]);
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));

/** Compatibility conversion is pure and one-way. New recipes have one owner
 * for each palette, geometry, brush-mechanics, and frozen mapping field. */
export function strokeStyle(drawable) {
  const geometry = drawable.geometry || {}, material = drawable.material || {};
  const style = { brush: geometry.type === "freehand" ? "pen" : geometry.type, ...pick(material, PALETTE),
    size: material.width, seed: drawable.gesture?.seed ?? material.seed, ...geometry.options, ...material.options, ...drawable.gesture?.mapping };
  // Shared materials always used their top-level color/width/opacity. Only the
  // old adapter gave overloaded options precedence over those common fields.
  if (material.type !== "adapter") Object.assign(style, pick(material, PALETTE), { size: material.width });
  return style;
}
export function makeStrokeMaterial(style, { generated = false, adapter = false } = {}) {
  const brush = style.brush || "pen", type = adapter ? "adapter" : style.material || "ink";
  const material = { type, ...pick(style, PALETTE), width: style.size };
  if (generated && style.seed !== undefined) material.seed = style.seed;
  if (type === "adapter") {
    material.options = { brush, ...pick(style, BRUSH_OPTIONS[brush] || []), ...pick(style, ["schemaVersion", "materialVersion"]) };
    // A generator's path is authoritative geometry. Its optional brush shaping
    // belongs to the adapter, rather than a second generator geometry recipe.
    if (generated) Object.assign(material.options, pick(style, GEOMETRY_OPTIONS[brush] || []));
  } else if (type === "silk") {
    Object.assign(material, { strands: style.silkStrands ?? style.strands, spread: style.silkSpread ?? style.spread,
      wander: style.silkWander ?? style.wander, glow: style.silkGlow ?? style.glow }, pick(style, ["pull", "drag"]));
    for (const key of Object.keys(material)) if (material[key] === undefined) delete material[key];
  }
  return material;
}
export function makePaintRecipe(points, style, { snapshotPoints = true } = {}) {
  const brush = style.brush || "pen";
  const type = style.geometry || (["pen", "spray", "texture"].includes(brush) ? "freehand" : brush);
  const geometry = { type }, geometryOptions = pick(style, GEOMETRY_OPTIONS[type] || []);
  if (Object.keys(geometryOptions).length) geometry.options = geometryOptions;
  const mapping = pick(style, MAPPING), gesture = { points: snapshotPoints ? structuredClone(points) : points };
  if (style.seed !== undefined) gesture.seed = style.seed;
  if (Object.keys(mapping).length) gesture.mapping = mapping;
  const adapter = style.material === "adapter" || type !== "freehand" || ["spray", "texture"].includes(style.material) || (style.material === "ink" && style.colorMode === "gradient");
  return { kind: "pathStroke", gesture, geometry, material: makeStrokeMaterial(style, { adapter }) };
}
export function normalizeStrokeRecipe(drawable) {
  const style = strokeStyle(drawable);
  if (drawable.kind === "generatedStroke") return { ...structuredClone(drawable), material: makeStrokeMaterial({ ...drawable.material, ...style, material: drawable.material.type }, { generated: true, adapter: drawable.material.type === "adapter" }) };
  const next = makePaintRecipe(drawable.gesture.points, { ...drawable.material, ...style, geometry: drawable.geometry.type, material: drawable.material.type });
  next.material = makeStrokeMaterial({ ...drawable.material, ...style, material: drawable.material.type }, { adapter: drawable.material.type === "adapter" });
  next.gesture = { ...structuredClone(drawable.gesture), ...next.gesture };
  // Shared freehand frame settings are geometry, not palette/brush options.
  if (drawable.geometry.frame) next.geometry.frame = structuredClone(drawable.geometry.frame);
  if (drawable.geometry.closed !== undefined) next.geometry.closed = drawable.geometry.closed;
  return next;
}
function plainData(value, seen = new Set()) {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  seen.add(value);
  const valid = Object.values(value).every(entry => plainData(entry, seen)); seen.delete(value); return valid;
}
function validFields(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  for (const [key, entry] of Object.entries(value)) if (entry !== undefined && NUMBERS.has(key) && !Number.isFinite(entry)) return false;
  if (value.colorMode !== undefined && !["solid", "gradient"].includes(value.colorMode)) return false;
  if (value.composite !== undefined && !["source-over", "lighter"].includes(value.composite)) return false;
  if (value.rotationMode !== undefined && !["fixed", "followStroke"].includes(value.rotationMode)) return false;
  if (value.taper !== undefined && !["none", "sine"].includes(value.taper)) return false;
  for (const key of ["color", "startColor", "endColor"]) if (value[key] !== undefined && (typeof value[key] !== "string" || !value[key].trim())) return false;
  return true;
}
export function validStrokeRecipe(drawable) {
  if (!plainData(drawable) || !isDrawable(drawable) || !MATERIALS.has(drawable.material.type)) return false;
  const material = drawable.material, style = strokeStyle(drawable);
  if (!validFields(material) || !validFields(material.options || {}) || !validFields(drawable.geometry?.options || {})) return false;
  if (!(style.size > 0) || !Number.isFinite(style.size) || !Number.isFinite(style.opacity) || style.opacity < 0 || style.opacity > 1) return false;
  if (style.seed !== undefined && (!Number.isInteger(style.seed) || style.seed < 0 || style.seed > 0xffffffff)) return false;
  if (material.type === "adapter" && !BRUSHES.has(style.brush)) return false;
  if (drawable.kind === "generatedStroke") return material.type !== "adapter" || style.brush !== "wisp";
  if (!GEOMETRIES.has(drawable.geometry.type) || (material.type !== "adapter" && drawable.geometry.type !== "freehand")) return false;
  if (!validFields(drawable.gesture.mapping || {})) return false;
  if (drawable.gesture.mapping?.wispUnitsPerPixel !== undefined && drawable.gesture.mapping.wispUnitsPerPixel <= 0) return false;
  if (drawable.geometry.closed !== undefined && drawable.geometry.closed !== false) return false;
  if (drawable.geometry.frame) {
    const frame = drawable.geometry.frame;
    if (!validFields(frame) || (frame.sampling !== undefined && !["input", "distance"].includes(frame.sampling))) return false;
    if (frame.spacing !== undefined && (!Number.isFinite(frame.spacing) || frame.spacing <= 0)) return false;
    if (frame.smoothing !== undefined && (!Number.isFinite(frame.smoothing) || frame.smoothing < 0 || frame.smoothing >= 1)) return false;
  }
  return true;
}

export function validPaintSamples(points, start = 0) {
  if (!Array.isArray(points)) return false;
  for (let index = Math.max(0, start); index < points.length; index += 1) {
    const point = points[index];
    if (!plainData(point) || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return false;
    if (point.holdCount !== undefined && (!Number.isFinite(point.holdCount) || point.holdCount < 0)) return false;
  }
  return true;
}
/** Hot-path validation examines frozen recipe metadata and the new tail only.
 * Full document validation remains at begin/commit/restore and prefix rebuild. */
export function validPaintSessionUpdate(drawable, consumed) {
  if (drawable?.kind !== "pathStroke" || !Array.isArray(drawable.gesture?.points)) return false;
  return validStrokeRecipe({ ...drawable, gesture: { ...drawable.gesture, points: [] } })
    && validPaintSamples(drawable.gesture.points, Math.min(consumed, drawable.gesture.points.length) - 1);
}
