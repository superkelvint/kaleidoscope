import test from "node:test";
import assert from "node:assert/strict";
import { BRUSHES, canReplayBrushPath, colorAtPathPosition, createPaintSessionRenderer, replayBrushContours, replayBrushPath } from "../brushes.js";
import { brushTextureCatalog } from "../brush-textures.js";
import { BrushPainter } from "../brush-painter.js";

class FakeContext2D {
  constructor() { this.calls = []; }
  set fillStyle(value) { this.calls.push(["fillStyle", value]); }
  set strokeStyle(value) { this.calls.push(["strokeStyle", value]); }
  set lineWidth(value) { this.calls.push(["lineWidth", value]); }
  set lineCap(value) { this.calls.push(["lineCap", value]); }
  set lineJoin(value) { this.calls.push(["lineJoin", value]); }
  set globalAlpha(value) { this.calls.push(["globalAlpha", value]); }
  save() { this.calls.push(["save"]); }
  restore() { this.calls.push(["restore"]); }
  beginPath() { this.calls.push(["beginPath"]); }
  moveTo(...args) { this.calls.push(["moveTo", ...args]); }
  lineTo(...args) { this.calls.push(["lineTo", ...args]); }
  closePath() { this.calls.push(["closePath"]); }
  arc(...args) { this.calls.push(["arc", ...args]); }
  ellipse(...args) { this.calls.push(["ellipse", ...args]); }
  translate(...args) { this.calls.push(["translate", ...args]); }
  rotate(...args) { this.calls.push(["rotate", ...args]); }
  drawImage(...args) { this.calls.push(["drawImage", ...args]); }
  fill() { this.calls.push(["fill"]); }
  stroke() { this.calls.push(["stroke"]); }
}

const options = {
  color: "#ffffff", size: 10, opacity: .8, lines: 3, span: 20,
  nibRatio: .25, density: 4, particleSize: 2, tangent: { x: 1, y: 0 }
};

test("transient paint-session renderers expose brush-neutral batches and backdrop capability", () => {
  const pen = createPaintSessionRenderer({ kind: "pathStroke", points: [], style: { ...options, brush: "pen", taper: "none" } });
  const penBatches = pen.advance({ kind: "pathStroke", points: [{ x: 10, y: 12 }], style: { ...options, brush: "pen", taper: "none" } });
  assert.equal(penBatches[0].requiresBackdrop, false);
  assert.ok(penBatches[0].instructions.length);
  assert.ok(penBatches[0].bounds.left < 10);

  const wispStyle = { ...options, brush: "wisp", version: 1 };
  const wisp = createPaintSessionRenderer({ kind: "pathStroke", points: [], style: wispStyle });
  const wispBatches = wisp.advance({ kind: "pathStroke", points: [{ x: 10, y: 12 }, { x: 18, y: 15 }, { x: 26, y: 14 }, { x: 34, y: 20 }, { x: 42, y: 18 }], style: wispStyle });
  assert.equal(wispBatches[0].requiresBackdrop, true);
  assert.ok(wispBatches[0].instructions.length);
});

test("ribbon stamps one strand per configured line across its perpendicular span", () => {
  const ctx = new FakeContext2D();
  BRUSHES.ribbon.move(ctx, { x: 0, y: 0 }, { x: 10, y: 10 }, options);
  assert.deepEqual(ctx.calls.filter(([name]) => name === "arc"), [
    ["arc", 10, 0, 5, 0, Math.PI * 2],
    ["arc", 10, 10, 5, 0, Math.PI * 2],
    ["arc", 10, 20, 5, 0, Math.PI * 2]
  ]);
});

test("directional brushes wait for a valid tangent before their first mark", () => {
  for (const brushName of ["ribbon", "calligraphy"]) {
    const ctx = new FakeContext2D();
    BRUSHES[brushName].begin(ctx, { x: 10, y: 10 }, { ...options, tangent: null });
    BRUSHES[brushName].move(ctx, { x: 10, y: 10 }, { x: 20, y: 20 }, { ...options, tangent: null });
    assert.equal(ctx.calls.length, 0, `${brushName} does not make an arbitrary first mark`);
  }
});

test("every brush can characterize output as backend-neutral painter primitives", () => {
  const tipId = "painter-tip", tip = { width: 8, height: 4 };
  brushTextureCatalog.loaded.set(tipId, { width: 8, height: 4, tints: new Map([["#ffffff", tip]]) });
  const path = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 80, y: 10 }];
  const styles = {
    pen: { ...options, brush: "pen", taper: "none" }, ribbon: { ...options, brush: "ribbon" }, calligraphy: { ...options, brush: "calligraphy" },
    spray: { ...options, brush: "spray", seed: 3 }, texture: { ...options, brush: "texture", textureId: tipId, spacing: .5 },
    fiber: { ...options, brush: "fiber", version: 2, seed: 3, fibers: .2, gravity: 20, branching: 0, curl: 0, spread: .5, wispiness: .5, assistLevel: .1 },
    hair: { ...options, brush: "hair", version: 2, seed: 3, fibers: .2, gravity: 20, branching: 0, curl: 0, spread: .5, wispiness: .5, assistLevel: .1 }
  };
  for (const [name, style] of Object.entries(styles)) {
    const instructions = [], painter = new BrushPainter(instruction => instructions.push(instruction));
    replayBrushPath(painter, path, style);
    assert.ok(instructions.length, `${name} emits instructions`);
    assert.ok(instructions.every(instruction => typeof instruction.type === "string"), `${name} has typed primitives`);
  }
  brushTextureCatalog.loaded.delete(tipId);
});

test("calligraphy uses the supplied tangent to orient an elongated nib", () => {
  const ctx = new FakeContext2D();
  BRUSHES.calligraphy.move(ctx, { x: 0, y: 0 }, { x: 10, y: 20 }, { ...options, tangent: { x: 0, y: 1 } });
  assert.deepEqual(ctx.calls.find(([name]) => name === "rotate"), ["rotate", Math.PI / 2]);
  assert.deepEqual(ctx.calls.find(([name]) => name === "ellipse"), ["ellipse", 0, 0, 5, 1.25, 0, 0, Math.PI * 2]);
});

test("spray emits its configured number of round particles", () => {
  const ctx = new FakeContext2D();
  BRUSHES.spray.begin(ctx, { x: 50, y: 50 }, options);
  const particles = ctx.calls.filter(([name]) => name === "arc");
  assert.equal(particles.length, 4);
  assert.ok(particles.every(([, x, y, radius]) => Math.hypot(x - 50, y - 50) <= 5 && radius === 1));
});

test("pen and spray retain immediate pointer-down marks", () => {
  const penContext = new FakeContext2D();
  BRUSHES.pen.begin(penContext, { x: 50, y: 50 }, options);
  assert.equal(penContext.calls.filter(([name]) => name === "arc").length, 1);

  const sprayContext = new FakeContext2D();
  BRUSHES.spray.begin(sprayContext, { x: 50, y: 50 }, options);
  assert.equal(sprayContext.calls.filter(([name]) => name === "arc").length, 4);
});

test("replay validity uses the same finite non-seam tangent rule as directional replay", () => {
  assert.equal(canReplayBrushPath([{ x: 10, y: 10 }], { ...options, brush: "pen" }), true);
  assert.equal(canReplayBrushPath([{ x: 10, y: 10 }], { ...options, brush: "ribbon" }), false);
  assert.equal(canReplayBrushPath([{ x: 10, y: 10 }, { x: 90, y: 10 }], { ...options, brush: "calligraphy" }), false);
  assert.equal(canReplayBrushPath([{ x: 10, y: 10 }, { x: 20, y: 10 }], { ...options, brush: "calligraphy" }), true);
});

test("replayed Spray uses its seed and Pen taper uses normalized path position", () => {
  const path = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }];
  const sprayOptions = { ...options, brush: "spray", seed: 12345 };
  const first = new FakeContext2D(), second = new FakeContext2D();
  replayBrushPath(first, path, sprayOptions);
  replayBrushPath(second, path, sprayOptions);
  assert.deepEqual(first.calls.filter(([name]) => name === "arc"), second.calls.filter(([name]) => name === "arc"));

  const pen = new FakeContext2D();
  replayBrushPath(pen, path, { ...options, brush: "pen", taper: "sine" });
  assert.deepEqual(pen.calls.filter(([name]) => name === "arc").map(call => call[3]), [0, 5, 0]);

  const plainPen = new FakeContext2D();
  replayBrushPath(plainPen, path, { ...options, brush: "pen", taper: "none" });
  assert.deepEqual(plainPen.calls.filter(([name]) => name === "moveTo"), [["moveTo", 0, 0]]);
  assert.deepEqual(plainPen.calls.filter(([name]) => name === "lineTo"), [["lineTo", 10, 0], ["lineTo", 20, 0]]);
  assert.equal(plainPen.calls.filter(([name]) => name === "stroke").length, 1);
});

test("eligible Pen contours share one native Canvas path without joining contours", () => {
  const ctx = new FakeContext2D();
  replayBrushContours(ctx, [
    { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], closed: false },
    { points: [{ x: 20, y: 0 }, { x: 20, y: 10 }], closed: true }
  ], { ...options, opacity: 1, brush: "pen", taper: "none", colorMode: "solid" });
  assert.equal(ctx.calls.filter(([name]) => name === "beginPath").length, 1);
  assert.equal(ctx.calls.filter(([name]) => name === "stroke").length, 1);
  assert.deepEqual(ctx.calls.filter(([name]) => name === "moveTo"), [["moveTo", 0, 0], ["moveTo", 20, 0]]);
  assert.equal(ctx.calls.filter(([name]) => name === "closePath").length, 1);
  assert.equal(ctx.calls.filter(([name]) => name === "arc").length, 0);

  const gradient = new FakeContext2D();
  replayBrushContours(gradient, [{ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], closed: false }], {
    ...options, brush: "pen", taper: "none", colorMode: "gradient", startColor: "#fff", endColor: "#000"
  });
  assert.equal(gradient.calls.filter(([name]) => name === "arc").length, 2, "gradient Pen stays on legacy replay");
});

test("replay retains timed Spray and Texture hold deposition", () => {
  const spray = new FakeContext2D();
  replayBrushPath(spray, [{ x: 20, y: 20, holdCount: 3 }], { ...options, brush: "spray", seed: 42 });
  assert.equal(spray.calls.filter(([name]) => name === "arc").length, 16, "initial spray plus three timed emissions");

  const id = "held-tip";
  const tip = { width: 10, height: 10 };
  brushTextureCatalog.loaded.set(id, { width: 10, height: 10, tints: new Map([["#ffffff", tip]]) });
  const texture = new FakeContext2D();
  replayBrushPath(texture, [{ x: 20, y: 20, holdCount: 3 }], {
    ...options, brush: "texture", textureId: id, spacing: .5, rotationMode: "fixed"
  });
  assert.equal(texture.calls.filter(([name]) => name === "drawImage").length, 4, "initial dab plus three timed dabs");
  brushTextureCatalog.loaded.delete(id);
});

test("gradient brush styles interpolate from the first path stamp to the last", () => {
  const style = { ...options, brush: "pen", colorMode: "gradient", startColor: "#ff0000", endColor: "#0000ff" };
  assert.equal(colorAtPathPosition(style, 0), "#ff0000");
  assert.equal(colorAtPathPosition(style, .5), "#800080");
  assert.equal(colorAtPathPosition(style, 1), "#0000ff");

  const ctx = new FakeContext2D();
  replayBrushPath(ctx, [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }], style);
  assert.deepEqual(ctx.calls.filter(([name]) => name === "fillStyle").map(([, color]) => color), ["#ff0000", "#800080", "#0000ff"]);
});

test("texture replay uses cached tips, size-relative spacing, and stable path rotation", () => {
  const id = "test-tip";
  brushTextureCatalog.loaded.set(id, {
    width: 20, height: 10, tints: new Map([["#ffffff", { width: 20, height: 10 }]])
  });
  const ctx = new FakeContext2D();
  replayBrushPath(ctx, [{ x: 0, y: 0 }, { x: 20, y: 0 }], {
    ...options, brush: "texture", textureId: id, spacing: .5, rotationMode: "followStroke"
  });
  assert.equal(ctx.calls.filter(([name]) => name === "drawImage").length, 5, "initial stamp plus one every five source pixels");
  assert.ok(ctx.calls.filter(([name]) => name === "rotate").every(([, angle]) => angle === 0));
  assert.deepEqual(ctx.calls.filter(([name]) => name === "drawImage")[0].slice(2), [-5, -2.5, 10, 5]);
  brushTextureCatalog.loaded.delete(id);
});

test("texture replay applies the existing gradient color path through cached tint variants", () => {
  const id = "gradient-tip";
  const red = { width: 10, height: 10 }, purple = { width: 10, height: 10 }, blue = { width: 10, height: 10 };
  brushTextureCatalog.loaded.set(id, {
    width: 10, height: 10,
    tints: new Map([["#ff0000", red], ["#800080", purple], ["#0000ff", blue]])
  });
  const ctx = new FakeContext2D();
  replayBrushPath(ctx, [{ x: 0, y: 0 }, { x: 20, y: 0 }], {
    ...options, brush: "texture", textureId: id, spacing: 1, colorMode: "gradient",
    startColor: "#ff0000", endColor: "#0000ff", rotationMode: "followStroke"
  });
  assert.deepEqual(ctx.calls.filter(([name]) => name === "drawImage").map(([, tip]) => tip), [red, purple, blue]);
  brushTextureCatalog.loaded.delete(id);
});
