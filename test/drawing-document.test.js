import test from "node:test";
import assert from "node:assert/strict";
import { DrawingDocument } from "../drawing-document.js";

const drawable = (x = 1) => ({ kind: "pathStroke", points: [{ x, y: 1 }, { x: x + 2, y: 3 }], style: { brush: "pen", color: "#fff", colorMode: "solid", size: 2, opacity: 1, taper: "none", seed: 1 } });
const ids = () => { let n = 0; return () => `op-${++n}`; };

test("only the most recent completed commit is undoable and undo is consumable", () => {
  const document = new DrawingDocument({ createId: ids() });
  const a = document.commit(drawable(1)), b = document.commit(drawable(4)), c = document.commit(drawable(8));
  assert.deepEqual([a.id, b.id, c.id], ["op-1", "op-2", "op-3"]);
  assert.equal(document.undo().undo.id, "op-3");
  assert.deepEqual(document.getRenderView().operations.map(operation => operation.id), ["op-1", "op-2"]);
  assert.equal(document.undo(), null);
  const d = document.commit(drawable(12));
  assert.equal(document.undo().undo.id, d.id);
  assert.equal(document.getDrawable(c.id), null, "a removed operation is not retained for redo");
});

test("replace actions preserve their initial baseline until ended", () => {
  const document = new DrawingDocument({ createId: ids() });
  const id = document.commit(drawable(1)).id;
  assert.equal(document.beginReplaceAction(id), true);
  document.replace(id, drawable(10)); document.replace(id, drawable(20)); document.endReplaceAction();
  assert.equal(document.getDrawable(id).points[0].x, 20);
  document.undo();
  assert.equal(document.getDrawable(id).points[0].x, 1);
});

test("background changes consume Undo and clear discards it", () => {
  const document = new DrawingDocument({ createId: ids() });
  document.commit(drawable());
  document.setBackgroundColor("#123456");
  document.undo();
  assert.equal(document.backgroundColor, "#000000");
  assert.equal(document.undo(), null);
  document.commit(drawable(4)); document.clear();
  assert.deepEqual(document.getContentState().operations, []);
  assert.equal(document.canRedo, undefined);
  assert.equal(document.canUndo(), false);
  assert.equal(document.operationCount, 0);
  document.setBackgroundColor("#654321"); document.clear();
  assert.equal(document.canUndo(), false, "clear also discards a background-only Undo");
});

test("document persists only schema-v3 typed operations and restores without Undo", () => {
  const document = new DrawingDocument({ createId: ids() });
  assert.equal(document.restoreContentState({ version: 1, backgroundColor: "#000", operations: [], cursor: 0 }), null);
  assert.equal(document.restoreContentState({ version: 2, backgroundColor: "#000", operations: [] }), null, "v2 is deliberately not migrated");
  assert.equal(document.restoreContentState({ version: 3, backgroundColor: "#000", operations: [{ id: "same", type: "PaintOperation", points: drawable().points, style: drawable().style }, { id: "same", type: "PaintOperation", points: drawable(4).points, style: drawable(4).style }] }), null);
  assert.equal(document.restoreContentState({ version: 3, backgroundColor: "#000", operations: [{ id: "good", type: "PaintOperation", points: drawable().points, style: drawable().style }] }).type, "restore");
  assert.deepEqual(Object.keys(document.getContentState()).sort(), ["backgroundColor", "operations", "version"]);
  assert.equal(document.canUndo(), false);
  assert.equal(document.redo, undefined);
});
