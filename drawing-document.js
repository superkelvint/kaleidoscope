import { isDrawable } from "./drawable-path.js";
import { BRUSHES, canReplayBrushPath } from "./brushes.js";

const clone = value => structuredClone(value);
const validDrawable = drawable => isDrawable(drawable)
  && Boolean(BRUSHES[drawable?.style?.brush])
  && (drawable.kind !== "pathStroke" || canReplayBrushPath(drawable.points, drawable.style));

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

  getContentState() { return clone({ version: 2, backgroundColor: this.backgroundColor, operations: this.operations }); }
  getRenderView() { return { backgroundColor: this.backgroundColor, operations: this.operations.map(clone) }; }
  canUndo() { return Boolean(this.lastUndo); }
  get operationCount() { return this.operations.length; }
  getDrawable(id) { return clone(this.operations.find(operation => operation.id === id)?.drawable || null); }
  findLatest(predicate) {
    for (let index = this.operations.length - 1; index >= 0; index -= 1) if (predicate(this.operations[index].drawable, this.operations[index].id)) return { id: this.operations[index].id, drawable: clone(this.operations[index].drawable) };
    return null;
  }
  commit(drawable) {
    if (!validDrawable(drawable)) return null;
    const operation = { id: this.createId(), drawable: clone(drawable) };
    this.operations.push(operation); this.lastUndo = { type: "remove", id: operation.id }; this.replaceAction = null;
    return { type: "append", id: operation.id, drawable: clone(operation.drawable), index: this.operations.length - 1 };
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
    const before = action ? clone(action.previousDrawable) : clone(this.operations[index].drawable);
    this.operations[index] = { id, drawable: clone(drawable) };
    this.lastUndo = { type: "replace", id, previousDrawable: before };
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
      this.operations[index] = { id: undo.id, drawable: clone(undo.previousDrawable) };
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
    if (!state || state.version !== 2 || "cursor" in state || typeof state.backgroundColor !== "string" || !Array.isArray(state.operations)) return null;
    const ids = new Set(), operations = [];
    for (const operation of state.operations) {
      if (typeof operation?.id !== "string" || !operation.id || ids.has(operation.id) || !validDrawable(operation.drawable)) return null;
      ids.add(operation.id); operations.push({ id: operation.id, drawable: clone(operation.drawable) });
    }
    this.backgroundColor = state.backgroundColor; this.operations = operations; this.lastUndo = null; this.replaceAction = null;
    return { type: "restore" };
  }
}
