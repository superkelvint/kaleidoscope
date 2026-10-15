import { drawingRecipe } from "./drawing-recipe.js";
import test from "node:test";
import assert from "node:assert/strict";
import { DrawingDocument } from "../drawing-document.js";

const drawable = (x = 1) => (drawingRecipe({ kind: "pathStroke", points: [{ x, y: 1 }, { x: x + 2, y: 3 }], style: { brush: "pen", color: "#fff", colorMode: "solid", size: 2, opacity: 1, taper: "none", seed: 1 } }));
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
  assert.equal(document.getDrawable(id).gesture.points[0].x, 20);
  document.undo();
  assert.equal(document.getDrawable(id).gesture.points[0].x, 1);
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

test("document persists only schema-v4 typed operations and restores without Undo", () => {
  const document = new DrawingDocument({ createId: ids() });
  assert.equal(document.restoreContentState({ version: 1, backgroundColor: "#000", operations: [], cursor: 0 }), null);
  assert.equal(document.restoreContentState({ version: 2, backgroundColor: "#000", operations: [] }), null, "v2 is deliberately not migrated");
  assert.equal(document.restoreContentState({ version: 4, backgroundColor: "#000", operations: [{ id: "same", type: "PaintOperation", gesture: drawable().gesture, geometry: drawable().geometry, material: drawable().material }, { id: "same", type: "PaintOperation", gesture: drawable(4).gesture, geometry: drawable(4).geometry, material: drawable(4).material }] }), null);
  assert.equal(document.restoreContentState({ version: 4, backgroundColor: "#000", operations: [{ id: "good", type: "PaintOperation", gesture: drawable().gesture, geometry: drawable().geometry, material: drawable().material }] }).type, "restore");
  assert.deepEqual(Object.keys(document.getContentState()).sort(), ["backgroundColor", "operations", "version"]);
  assert.equal(document.canUndo(), false);
  assert.equal(document.redo, undefined);
});

test("schema-v3 recipes restore with stable IDs and preserve the legacy brush contract", () => {
  const document = new DrawingDocument(), points = [{ x: 1, y: 2 }, { x: 10, y: 8 }];
  const style = { brush: "pen", color: "#fff", size: 4, opacity: .5, materialVersion: 1, seed: 9 };
  const saved = { version: 3, backgroundColor: "#123456", operations: [{ id: "old-paint", type: "PaintOperation", points, style }] };
  const original = structuredClone(saved);
  assert.equal(document.restoreContentState(saved)?.type, "restore");
  const restored = document.getDrawable("old-paint");
  assert.deepEqual(restored.gesture, { points, seed: 9 });
  assert.equal(restored.material.options.schemaVersion, 3);
  assert.equal(restored.material.options.materialVersion, 1);
  assert.equal(document.getContentState().version, 4);
  assert.equal(document.canUndo(), false);
  assert.deepEqual(saved, original);
});
