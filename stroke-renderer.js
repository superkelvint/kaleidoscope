import { strokeStyle } from "./stroke-recipe.js";
import { brushFootprint, brushTextureId, createLiveBrushPreview, createPaintSessionRenderer, measureBrushReplay, renderBrushReplay, replayBrushContours } from "./brushes.js";
import { derivePath } from "./drawable-path.js";
import { deriveStrokeGeometry } from "./stroke-geometry.js";
import { createMaterialSession, measureMaterialBounds, renderMaterial } from "./stroke-material.js";

// Only the compatibility boundary knows the old overloaded brush style. The
// rasterizer receives the same prepared render and session protocol for every
// material, including legacy v3 and specialized brush adapters.
function adapterDrawable(drawable) { return { ...drawable, points: drawable.gesture?.points || [], style: strokeStyle(drawable) }; }
function pathBounds(path, style) {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const contour of path.contours) for (const point of contour.points) {
    left = Math.min(left, point.x); top = Math.min(top, point.y); right = Math.max(right, point.x); bottom = Math.max(bottom, point.y);
  }
  if (!Number.isFinite(left)) return null;
  const padding = brushFootprint(style) + 2;
  return { left: Math.floor(left - padding), top: Math.floor(top - padding), right: Math.ceil(right + padding), bottom: Math.ceil(bottom + padding) };
}
function prepareShared(drawable, project) {
  const path = drawable.kind === "pathStroke" ? null : derivePath(drawable, project);
  const geometry = path
    ? { paths: path.contours.map(contour => deriveStrokeGeometry({ type: "generator", closed: contour.closed }, { points: contour.points }).paths[0]) }
    : deriveStrokeGeometry(drawable.geometry, { gesture: drawable.gesture });
  const context = { seed: drawable.gesture?.seed ?? drawable.material.seed };
  return { bounds: measureMaterialBounds(geometry, drawable.material, context), path: null,
    render: target => renderMaterial(target, geometry, drawable.material, context), resourceId: null };
}
function prepareAdapter(drawable, project, { preview = false } = {}) {
  const input = adapterDrawable(drawable), style = input.style;
  const measurement = measureBrushReplay(input, { tail: !preview });
  const path = measurement ? null : derivePath(drawable, project);
  const bounds = measurement ? measurement.bounds && {
    left: Math.floor(measurement.bounds.left - 2), top: Math.floor(measurement.bounds.top - 2), right: Math.ceil(measurement.bounds.right + 2), bottom: Math.ceil(measurement.bounds.bottom + 2)
  } : pathBounds(path, style);
  return { bounds, path, resourceId: brushTextureId(style), render(target, options = {}) {
    if (measurement) renderBrushReplay(target, input, { tail: !options.preview });
    else replayBrushContours(target, path.contours, options.preview ? { ...style, preview: true } : style);
  } };
}
const RENDERERS = Object.freeze({
  ink: { prepare: prepareShared, session: createMaterialSession },
  silk: { prepare: prepareShared, session: createMaterialSession },
  adapter: { prepare: prepareAdapter, session(drawable) {
    const renderer = createPaintSessionRenderer(adapterDrawable(drawable));
    let consumed = 0;
    return {
      acceptsStyle: next => renderer.acceptsStyle(strokeStyle(next)),
      advance(next) { const batches = renderer.advance(adapterDrawable(next), consumed); consumed = next.gesture.points.length; return batches; },
      beginFinish: () => renderer.beginFinish?.(), settle: () => renderer.settle?.() || [],
      get isFinished() { return renderer.isFinished; }, get bounds() { return renderer.bounds; },
      reconstruct: next => renderer.reconstruct(adapterDrawable(next)), dispose: () => renderer.dispose?.(),
      rasterMode: renderer.rasterMode, resourceId: brushTextureId(strokeStyle(drawable))
    };
  } }
});
export function prepareStroke(drawable, project, options) {
  const renderer = RENDERERS[drawable?.material?.type];
  return renderer ? renderer.prepare(drawable, project, options) : { bounds: null, path: null, render() {}, resourceId: null };
}
export function createStrokeSession(drawable) {
  const session = RENDERERS[drawable?.material?.type]?.session(drawable);
  if (!session) return null;
  const metadata = JSON.stringify({ ...drawable.gesture, points: undefined });
  return {
    acceptsDrawable: next => JSON.stringify({ ...next.gesture, points: undefined }) === metadata && session.acceptsStyle(next), advance: next => session.advance(next),
    beginFinish: () => session.beginFinish(), settle: () => session.settle(),
    get isFinished() { return session.isFinished; }, get bounds() { return session.bounds; },
    reconstruct: next => session.reconstruct(next), dispose: () => session.dispose(), resourceId: session.resourceId, rasterMode: session.rasterMode || "incremental"
  };
}
export function strokeDescription(drawable) { return drawable.material.type === "adapter" ? strokeStyle(drawable).brush : drawable.material.type; }

/** Optional incremental preview capability. Reconstructed/constructed previews
 * use prepareStroke; adapters may opt into an accumulating transient preview. */
export function createStrokeLivePreview(drawable) {
  if (drawable.material.type !== "adapter") return null;
  const live = createLiveBrushPreview(adapterDrawable(drawable));
  if (!live) return null;
  return {
    acceptsDrawable: next => live.acceptsStyle(strokeStyle(next)), advance: points => live.advance(points),
    deltaBounds: () => live.deltaBounds(), paintDelta: target => live.paintDelta(target), finishDelta: () => live.finishDelta?.(),
    reconstruct: target => live.replay(target), get bounds() { return live.bounds; },
    get consumedSampleCount() { return live.consumedSampleCount; }, get activeParticleCount() { return live.activeParticleCount; },
    dispose: () => live.dispose?.()
  };
}
