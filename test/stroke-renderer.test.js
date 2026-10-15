import test from "node:test";
import assert from "node:assert/strict";
import { DrawingController } from "../drawing-controller.js";
import { brushTextureCatalog } from "../brush-textures.js";
import { BrushPainter } from "../brush-painter.js";
import { createStrokeSession, prepareStroke } from "../stroke-renderer.js";

const points = [{ x: 10, y: 20 }, { x: 20, y: 25 }, { x: 40, y: 10 }, { x: 60, y: 25 }];
for (const name of ["pen", "silk", "ribbon", "calligraphy", "spray", "texture", "fiber", "hair", "wisp"]) {
  test(`${name} implements the same live, replay, bounds, and finishing contract`, () => {
    const originalTip = brushTextureCatalog.getTintedTip;
    if (name === "texture") brushTextureCatalog.getTintedTip = () => ({ width: 8, height: 4 });
    try {
      const controller = new DrawingController({ source: {} });
      if (name === "silk") controller.setMaterial(name); else controller.setBrush(name);
      controller.set("wispPersistence", 60); controller.set("wispDensity", 1); controller.set("fibers", .2);
      const style = controller.styleSnapshot(); style.seed = 17;
      const recipe = count => controller.drawable(points.slice(0, count), style);
      const session = createStrokeSession(recipe(0));
      assert.equal(session.acceptsDrawable(recipe(1)), true);
      const changed = recipe(1); changed.material.color = "#224466";
      assert.equal(session.acceptsDrawable(changed), false);
      const reseeded = recipe(1); reseeded.gesture.seed += 1;
      assert.equal(session.acceptsDrawable(reseeded), false, "gesture metadata is frozen for the session");
      let emitted = 0, latest = [];
      for (let count = 1; count <= points.length; count += 1) { latest = session.advance(recipe(count)).flatMap(batch => batch.instructions); emitted += latest.length; }
      assert.ok(emitted > 0);
      assert.ok(session.reconstruct(recipe(points.length)).length > 0);
      session.beginFinish();
      for (let step = 0; step < 1000 && !session.isFinished; step += 1) session.settle();
      assert.equal(session.isFinished, true);
      const prepared = prepareStroke(recipe(points.length), { width: 100, height: 100, time: 0 });
      assert.ok(prepared.bounds && Object.values(prepared.bounds).every(Number.isFinite));
      const instructions = []; prepared.render(new BrushPainter(item => instructions.push(item)));
      assert.ok(instructions.length > 0);
      if (session.rasterMode === "replace") assert.deepEqual(instructions, latest, "replacement prefixes and reconstruction use identical paint instructions");
      if (name === "texture") assert.equal(prepared.resourceId, session.resourceId);
      session.dispose();
    } finally { brushTextureCatalog.getTintedTip = originalTip; }
  });
}
