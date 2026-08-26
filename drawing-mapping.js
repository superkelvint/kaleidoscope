import { globalWallpaperPoint } from "./global-wallpaper.js";
import { localMotifPoint, rotateForRenderer } from "./local-motif.js";

export { rotateForRenderer } from "./local-motif.js";

export function displayGeometryContext(rendererState = {}, displayCanvas) {
  const rect = displayCanvas.getBoundingClientRect();
  const centerX = Number.isFinite(rendererState.centerX) ? rendererState.centerX : .5;
  const centerY = Number.isFinite(rendererState.centerY) ? rendererState.centerY : .5;
  return { segments: rendererState.segments, symmetryMode: rendererState.symmetryMode, mirror: rendererState.mirror, center: { x: rect.left + centerX * rect.width, y: rect.top + (1 - centerY) * rect.height } };
}

/** Map a client/display point through a frozen renderer mapping state. */
export function screenToSourcePoint(event, displayCanvas, rendererState = {}, sourceWidth, sourceHeight) {
  const rect = displayCanvas.getBoundingClientRect();
  const x = Number(event.x ?? event.clientX), y = Number(event.y ?? event.clientY);
  const uv = { x: (x - rect.left) / Math.max(rect.width, 1), y: 1 - (y - rect.top) / Math.max(rect.height, 1) };
  const center = { x: Number.isFinite(rendererState.centerX) ? rendererState.centerX : .5, y: Number.isFinite(rendererState.centerY) ? rendererState.centerY : .5 };
  const aspect = Math.max(rect.width, 1) / Math.max(rect.height, 1);
  const screen = { x: (uv.x - center.x) * aspect, y: uv.y - center.y };
  let grid = screen;
  if (rendererState.wallpaperMode && rendererState.wallpaperMode !== "single") grid = rotateForRenderer({ x: screen.x - (Number(rendererState.gridX) || 0), y: screen.y - (Number(rendererState.gridY) || 0) }, -(Number(rendererState.gridRotationDeg) || 0) * Math.PI / 180);
  const q = localMotifPoint(globalWallpaperPoint(grid, rendererState.wallpaperMode, rendererState.wallpaperSize), rendererState);
  // q is isotropic display/symmetry space. Convert it once to source UV
  // using only source aspect; display aspect was consumed to construct screen.
  const source = rotateForRenderer(q, Number(rendererState.rotationRad) || 0);
  const zoom = Math.max(Number(rendererState.zoom) || 1, .001);
  source.x = source.x / zoom;
  source.y = source.y / zoom;
  const imageAspect = sourceWidth / sourceHeight;
  source.x = source.x / Math.max(imageAspect, .001) + (Number(rendererState.panX) || 0) + .5;
  source.y = source.y + (Number(rendererState.panY) || 0) + .5;
  // Keep gestures locally unwrapped. The rasterizer folds translated copies
  // into the finite periodic material, avoiding a false long segment at seams.
  return { x: source.x * sourceWidth, y: (1 - source.y) * sourceHeight };
}
