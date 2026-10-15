import { isDrawable } from "./drawable-path.js";
import { isStrokeMaterial } from "./stroke-material.js";

const clone = value => structuredClone(value);
const validGesture = gesture => Array.isArray(gesture?.points) && gesture.points.every(point => Number.isFinite(point?.x) && Number.isFinite(point?.y));
const validGeometry = geometry => typeof geometry?.type === "string" && geometry.type.length > 0;
const validDrawable = drawable => isDrawable(drawable)
  && (drawable.kind === "generatedStroke" || validGeometry(drawable.geometry))
  && isStrokeMaterial(drawable.material)
  && (drawable.kind !== "pathStroke" || validGesture(drawable.gesture));

/** Durable semantic truth for a drawing. It intentionally owns no pixels or caches. */
export class DrawingDocument {
  constructor({ createId = null } = {}) {
    let serial = 0;
    this.createId = createId || (() => {
      serial += 1;
      return globalThis.crypto?.randomUUID?.() || `drawing-op-${serial}`;
    });
    this.backgroundColor = "#000000";
    this.operations = [];
    // Session-only reversal data; it is deliberately never persisted.
    this.lastUndo = null;
    this.replaceAction = null;
  }

  getContentState() { return clone({ version: 4, backgroundColor: this.backgroundColor, operations: this.operations }); }
  getRenderView() { return { backgroundColor: this.backgroundColor, operations: this.operations.map(clone) }; }
  canUndo() { return Boolean(this.lastUndo); }
  get operationCount() { return this.operations.length; }
  getDrawable(id) { return clone(drawableForOperation(this.operations.find(operation => operation.id === id)) || null); }
  findLatest(predicate) {
    for (let index = this.operations.length - 1; index >= 0; index -= 1) { const drawable = drawableForOperation(this.operations[index]); if (predicate(drawable, this.operations[index].id)) return { id: this.operations[index].id, drawable: clone(drawable) }; }
    return null;
  }
  commit(drawable) {
    if (!validDrawable(drawable)) return null;
    const operation = operationForDrawable(this.createId(), drawable);
    this.operations.push(operation); this.lastUndo = { type: "remove", id: operation.id }; this.replaceAction = null;
    return { type: "append", id: operation.id, operation: clone(operation), index: this.operations.length - 1 };
  }
  beginReplaceAction(id) {
    if (this.replaceAction?.id === id) return true;
    const drawable = this.getDrawable(id);
    if (!drawable) return false;
    this.replaceAction = { id, previousDrawable: drawable };
    return true;
  }
  endReplaceAction() { this.replaceAction = null; }
  replace(id, drawable) {
    const index = this.operations.findIndex(operation => operation.id === id);
    if (index < 0 || !validDrawable(drawable)) return null;
    const action = this.replaceAction?.id === id ? this.replaceAction : null;
    const before = action ? clone(action.previousDrawable) : clone(drawableForOperation(this.operations[index]));
    this.operations[index] = operationForDrawable(id, drawable);
    // Generator edits intentionally are retained-state changes, not commands.
    if (this.operations[index].type !== "GeneratorOperation") this.lastUndo = { type: "replace", id, previousDrawable: before };
    return { type: "replace", id, before, after: clone(drawable), index };
  }
  undo() {
    const undo = this.lastUndo;
    if (!undo) return null;
    this.lastUndo = null; this.replaceAction = null;
    if (undo.type === "remove") {
      const index = this.operations.findIndex(operation => operation.id === undo.id);
      if (index < 0) return null;
      this.operations.splice(index, 1);
    } else if (undo.type === "replace") {
      const index = this.operations.findIndex(operation => operation.id === undo.id);
      if (index < 0) return null;
      this.operations[index] = operationForDrawable(undo.id, undo.previousDrawable);
    } else if (undo.type === "background") this.backgroundColor = undo.previousColor;
    else return null;
    return { type: "undo", undo: clone(undo) };
  }
  clear() {
    if (!this.operations.length && !this.lastUndo) return null;
    this.operations = []; this.lastUndo = null; this.replaceAction = null;
    return { type: "clear" };
  }
  setBackgroundColor(color) {
    if (typeof color !== "string" || !color.trim() || color === this.backgroundColor) return null;
    const before = this.backgroundColor; this.backgroundColor = color; this.lastUndo = { type: "background", previousColor: before }; this.replaceAction = null;
    return { type: "background", before, after: color };
  }
  restoreContentState(state) {
    // Schema-v3 recipes remain explicit adapter recipes so their original
    // reconstruction semantics survive the geometry/material separation.
    if (!state || ![3, 4].includes(state.version) || "cursor" in state || typeof state.backgroundColor !== "string" || !Array.isArray(state.operations)) return null;
    const ids = new Set(), operations = [];
    for (const saved of state.operations) {
      const operation = state.version === 3 ? migrateV3Operation(saved) : saved;
      if (!validOperation(operation) || ids.has(operation.id)) return null;
      ids.add(operation.id); operations.push(clone(operation));
    }
    this.backgroundColor = state.backgroundColor; this.operations = operations; this.lastUndo = null; this.replaceAction = null;
    return { type: "restore" };
  }
}

function drawableForOperation(operation) {
  if (!operation) return null;
  if (operation.type === "PaintOperation") return { kind: "pathStroke", gesture: clone(operation.gesture), geometry: clone(operation.geometry), material: clone(operation.material) };
  if (operation.type === "GeneratorOperation") {
    const { generator, generatorVersion, config, animation, domain, sampling, material } = operation;
    return { kind: "generatedStroke", generator, generatorVersion, config, animation, domain, sampling, geometry: { type: "generator" }, material: clone(material) };
  }
  return null;
}
function operationForDrawable(id, drawable) {
  return drawable.kind === "pathStroke"
    ? { id, type: "PaintOperation", gesture: clone(drawable.gesture), geometry: clone(drawable.geometry), material: clone(drawable.material) }
    : { id, type: "GeneratorOperation", generator: drawable.generator, generatorVersion: drawable.generatorVersion, config: clone(drawable.config), animation: clone(drawable.animation), domain: clone(drawable.domain), sampling: clone(drawable.sampling), material: clone(drawable.material) };
}
function validOperation(operation) {
  if (typeof operation?.id !== "string" || !operation.id) return false;
  return validDrawable(drawableForOperation(operation));
}

function migrateV3Operation(operation) {
  const style = operation?.style;
  if (!style || typeof style.brush !== "string") return null;
  const material = { type: "adapter", color: style.color, opacity: style.opacity, width: style.size, options: { ...clone(style), schemaVersion: 3 } };
  if (operation.type === "PaintOperation") return { id: operation.id, type: operation.type, gesture: { points: clone(operation.points), seed: style.seed }, geometry: { type: style.brush }, material };
  if (operation.type === "GeneratorOperation") {
    const { id, type, generator, generatorVersion, config, animation, domain, sampling } = operation;
    return clone({ id, type, generator, generatorVersion, config, animation, domain, sampling, material });
  }
  return null;
}
