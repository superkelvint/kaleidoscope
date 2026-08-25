import test from "node:test";
import assert from "node:assert/strict";
import { DrawingDocument } from "../drawing-document.js";

const drawable = (x = 1) => ({ kind: "pathStroke", points: [{ x, y: 1 }, { x: x + 2, y: 3 }], style: { brush: "pen", color: "#fff", colorMode: "solid", size: 2, opacity: 1, taper: "none", seed: 1 } });

test("document emits stable-ID ChangeSets and keeps snapshots immutable", () => {
  const document = new DrawingDocument({ createId: (() => { let n = 0; return () => `op-${++n}`; })() });
  const append = document.commit(drawable());
  assert.deepEqual(append, { type: "append", id: "op-1", drawable: drawable(), index: 0 });
  const state = document.getContentState(); state.operations[0].drawable.points[0].x = 99;
  assert.equal(document.getDrawable("op-1").points[0].x, 1);
  const replacement = drawable(10);
  assert.equal(document.replace("op-1", replacement).type, "replace");
  assert.deepEqual(document.getDrawable("op-1"), replacement);
});

test("document branches after undo and clear is destructive", () => {
  const document = new DrawingDocument({ createId: (() => { let n = 0; return () => `op-${++n}`; })() });
  document.commit(drawable(1)); document.commit(drawable(4));
  assert.deepEqual(document.undo(), { type: "undo", affectedIds: ["op-2"], index: 1 });
  document.commit(drawable(8));
  assert.equal(document.getHistoryState().canRedo, false);
  assert.deepEqual(document.clear(), { type: "clear" });
  assert.deepEqual(document.getHistoryState(), { canUndo: false, canRedo: false, appliedCount: 0 });
  assert.deepEqual(document.getContentState().operations, []);
});

test("document accepts only schema-v1 content with unique valid IDs", () => {
  const document = new DrawingDocument();
  assert.equal(document.restoreContentState({ version: 0, backgroundColor: "#000", operations: [], cursor: 0 }), null);
  assert.equal(document.restoreContentState({ version: 1, backgroundColor: "#000", operations: [{ id: "same", drawable: drawable() }, { id: "same", drawable: drawable(4) }], cursor: 2 }), null);
  assert.equal(document.restoreContentState({ version: 1, backgroundColor: "#000", operations: [{ id: "good", drawable: drawable() }], cursor: 1 }).type, "restore");
});
