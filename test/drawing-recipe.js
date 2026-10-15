/** Build explicit schema-v4 recipes for raster and document tests.
 * Adapter fixtures exercise the established brush algorithms; Ink/Silk have
 * separate material tests. Overrides keep long input fixtures readable.
 */
export function drawingRecipe({ kind, points, style, gesture, geometry, material, ...recipe }) {
  const options = style || material?.options || {};
  return {
    kind, ...recipe,
    ...(kind === "pathStroke" ? { gesture: { ...gesture, seed: options.seed, points: points || gesture?.points || [] } } : {}),
    geometry: { type: kind === "generatedStroke" ? "generator" : options.brush || geometry?.type || "pen" },
    material: { type: "adapter", color: options.color, opacity: options.opacity, width: options.size, options: { ...options } }
  };
}
