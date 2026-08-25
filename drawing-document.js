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
    this.cursor = 0;
  }

  getContentState() {
    return clone({ version: 1, backgroundColor: this.backgroundColor, operations: this.operations, cursor: this.cursor });
  }
  getRenderView() { return { backgroundColor: this.backgroundColor, operations: this.operations.slice(0, this.cursor).map(clone), cursor: this.cursor }; }
  getHistoryState() { return { canUndo: this.cursor > 0, canRedo: this.cursor < this.operations.length, appliedCount: this.cursor }; }
  getDrawable(id) { return clone(this.operations.slice(0, this.cursor).find(operation => operation.id === id)?.drawable || null); }
  findLatest(predicate) {
    for (let index = this.cursor - 1; index >= 0; index -= 1) if (predicate(this.operations[index].drawable, this.operations[index].id)) return { id: this.operations[index].id, drawable: clone(this.operations[index].drawable) };
    return null;
  }
  commit(drawable) {
    if (!validDrawable(drawable)) return null;
    if (this.cursor < this.operations.length) this.operations.splice(this.cursor);
    const operation = { id: this.createId(), drawable: clone(drawable) };
    this.operations.push(operation); this.cursor = this.operations.length;
    return { type: "append", id: operation.id, drawable: clone(operation.drawable), index: this.cursor - 1 };
  }
  replace(id, drawable) {
    const index = this.operations.findIndex(operation => operation.id === id);
    if (index < 0 || index >= this.cursor || !validDrawable(drawable)) return null;
    const before = clone(this.operations[index].drawable);
    this.operations[index] = { id, drawable: clone(drawable) };
    return { type: "replace", id, before, after: clone(drawable), index };
  }
  undo() {
    if (this.cursor === 0) return null;
    const operation = this.operations[this.cursor - 1]; this.cursor -= 1;
    return { type: "undo", affectedIds: [operation.id], index: this.cursor };
  }
  redo() {
    if (this.cursor >= this.operations.length) return null;
    const operation = this.operations[this.cursor]; this.cursor += 1;
    return { type: "redo", affectedIds: [operation.id], index: this.cursor - 1 };
  }
  clear() {
    if (!this.operations.length) return null;
    this.operations = []; this.cursor = 0;
    return { type: "clear" };
  }
  setBackgroundColor(color) {
    if (typeof color !== "string" || !color.trim() || color === this.backgroundColor) return null;
    const before = this.backgroundColor; this.backgroundColor = color;
    return { type: "background", before, after: color };
  }
  restoreContentState(state) {
    if (!state || state.version !== 1 || typeof state.backgroundColor !== "string" || !Array.isArray(state.operations)) return null;
    const ids = new Set();
    const operations = [];
    for (const operation of state.operations) {
      if (typeof operation?.id !== "string" || !operation.id || ids.has(operation.id) || !validDrawable(operation.drawable)) return null;
      ids.add(operation.id); operations.push({ id: operation.id, drawable: clone(operation.drawable) });
    }
    if (!Number.isInteger(state.cursor) || state.cursor < 0 || state.cursor > operations.length) return null;
    this.backgroundColor = state.backgroundColor; this.operations = operations; this.cursor = state.cursor;
    return { type: "restore" };
  }
}
