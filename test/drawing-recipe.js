import { makePaintRecipe, makeStrokeMaterial, strokeStyle } from "../stroke-recipe.js";

/** Compact adapter fixtures exercise established brush algorithms. Ink/Silk
 * and the public controller have their own shared-material coverage. */
export function drawingRecipe({ kind, points, style, gesture, geometry, material, ...recipe }) {
  const options = style || strokeStyle({ gesture, geometry, material });
  if (kind === "generatedStroke") return { kind, ...recipe, geometry: { type: "generator" }, material: makeStrokeMaterial(options, { generated: true, adapter: true }) };
  return makePaintRecipe(points || gesture?.points || [], { ...options, material: "adapter" });
}
