import test from "node:test";
import assert from "node:assert/strict";
import { BRUSHES, canReplayBrushPath, colorAtPathPosition, createImmediateBrushSession, createPaintSessionRenderer, replayBrushContours, replayBrushPath } from "../brushes.js";
import { brushTextureCatalog } from "../brush-textures.js";
import { contourEnergy, resolveBrushMaterial } from "../brush-material.js";
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

function assertV1LiveRebuildAndReplayMatch(style, points) {
  const liveSession = createImmediateBrushSession(style);
  for (const point of points) { liveSession.append(point); liveSession.hold(point, Math.max(0, Number(point.holdCount) || 0)); }
  const live = liveSession.takeDelta();
  const durable = [];
  replayBrushPath(new BrushPainter(item => durable.push(item)), points, style);
  const renderer = createPaintSessionRenderer({ kind: "pathStroke", points: [], style });
  renderer.advance({ kind: "pathStroke", points, style });
  const rebuilt = renderer.reconstruct({ kind: "pathStroke", points, style }).flatMap(batch => batch.instructions);
  assert.deepEqual(rebuilt, live, "PaintSession reconstruction preserves chronological samples and holds");
  assert.deepEqual(durable, live, "durable replay preserves the full live instruction sequence");
}

test("transient paint-session renderers expose brush-neutral batches and backdrop capability", () => {
  const pen = createPaintSessionRenderer({ kind: "pathStroke", points: [], style: { ...options, brush: "pen", taper: "none" } });
  const penBatches = pen.advance({ kind: "pathStroke", points: [{ x: 10, y: 12 }], style: { ...options, brush: "pen", taper: "none" } });
  assert.equal(penBatches[0].requiresBackdrop, true, "adapter Pen deposits additive material");
  assert.ok(penBatches[0].instructions.length);
  assert.ok(penBatches[0].bounds.left < 10);

  const wispStyle = { ...options, brush: "wisp", version: 1 };
  const wisp = createPaintSessionRenderer({ kind: "pathStroke", points: [], style: wispStyle });
  const wispBatches = wisp.advance({ kind: "pathStroke", points: [{ x: 10, y: 12 }, { x: 18, y: 15 }, { x: 26, y: 14 }, { x: 34, y: 20 }, { x: 42, y: 18 }], style: wispStyle });
  assert.equal(wispBatches[0].requiresBackdrop, true);
  assert.ok(wispBatches[0].instructions.length);

  const additivePen = createPaintSessionRenderer({ kind: "pathStroke", points: [], style: { ...options, brush: "pen", taper: "none", materialVersion: 1, colorMode: "gradient", startColor: "#ff0000", endColor: "#0000ff" } });
  const additiveBatches = additivePen.advance({ kind: "pathStroke", points: [{ x: 10, y: 12 }], style: { ...options, brush: "pen", taper: "none", materialVersion: 1, colorMode: "gradient", startColor: "#ff0000", endColor: "#0000ff" } });
  assert.equal(additiveBatches[0].instructions[0].composite, "lighter");
  assert.equal(additiveBatches[0].requiresBackdrop, true);
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

test("low-density Spray spaces bursts apart instead of following every pointer sample", () => {
  const ctx = new FakeContext2D();
  const path = Array.from({ length: 21 }, (_, x) => ({ x, y: 20 }));
  replayBrushPath(ctx, path, { ...options, brush: "spray", density: 1, size: 10, particleSize: 1, seed: 4 });
  assert.equal(ctx.calls.filter(([name]) => name === "arc").length, 2, "a 20-unit path emits only its initial and one spaced burst");
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

test("gradient adapter material combines local energy with causal progress", () => {
  const style = { ...options, brush: "pen", colorMode: "gradient", startColor: "#ff0000", endColor: "#0000ff" };
  assert.equal(colorAtPathPosition(style, 0), "#ff0000");
  assert.equal(colorAtPathPosition(style, .5), "#800080");
  assert.equal(colorAtPathPosition(style, 1), "#0000ff");

  const ctx = new FakeContext2D();
  replayBrushPath(ctx, [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }], style);
  const points = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }];
  const expected = points.map((_, index) => resolveBrushMaterial(style, {
    energy: contourEnergy(points, index, style.size),
    progress: index > 1 ? 10 / (style.size * 24) : 0, profile: "additive", opacityScale: style.opacity
  }).color);
  assert.deepEqual(ctx.calls.filter(([name]) => name === "fillStyle").map(([, color]) => color), expected);
});

test("adapter Pen material no longer depends on the removed materialVersion switch", () => {
  const path = [{ x: 0, y: 0 }, { x: 10, y:0 }, { x: 30, y: 0 }];
  const legacy = [], shared = [];
  const style = { ...options, brush: "pen", taper: "sine", colorMode: "gradient", startColor: "#ff0000", endColor: "#0000ff" };
  replayBrushPath(new BrushPainter(item => legacy.push(item)), path, style);
  replayBrushPath(new BrushPainter(item => shared.push(item)), path, { ...style, materialVersion: 1 });
  assert.deepEqual(shared.map(({ x, y, radius }) => ({ x, y, radius })), legacy.map(({ x, y, radius }) => ({ x, y, radius })));
  assert.deepEqual(shared, legacy);
  assert.ok(shared.every(item => item.composite === "lighter"));
});

test("materialVersion 1 Pen resolves identical live and replay material fields", () => {
  const points = [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 36, y: 0 }];
  const style = { ...options, brush: "pen", taper: "sine", materialVersion: 1, colorMode: "gradient", startColor: "#ff0000", endColor: "#0000ff" };
  const live = createImmediateBrushSession(style);
  for (const point of points) live.append(point);
  const replay = [];
  replayBrushPath(new BrushPainter(item => replay.push(item)), points, style);
  assert.deepEqual(live.takeDelta().map(({ color, opacity, composite }) => ({ color, opacity, composite })), replay.map(({ color, opacity, composite }) => ({ color, opacity, composite })));
});

test("materialVersion 1 Spray retains each segment's live material through replay", () => {
  const points = [{ x: 0, y: 0 }, { x: 48, y: 0 }];
  const style = { ...options, brush: "spray", seed: 42, density: 1, size: 10, particleSize: 1, materialVersion: 1, colorMode: "gradient", startColor: "#ff0000", endColor: "#0000ff" };
  const live = createImmediateBrushSession(style);
  for (const point of points) live.append(point);
  const replay = [];
  replayBrushPath(new BrushPainter(item => replay.push(item)), points, style);
  assert.deepEqual(live.takeDelta().map(({ color, opacity, composite }) => ({ color, opacity, composite })), replay.map(({ color, opacity, composite }) => ({ color, opacity, composite })));
});

test("v1 Spray preserves stationary and moving hold chronology through rebuild and replay", () => {
  const style = { ...options, brush: "spray", seed: 42, density: 2, size: 10, particleSize: 1, materialVersion: 1, colorMode: "gradient", startColor: "#ff0000", endColor: "#0000ff" };
  assertV1LiveRebuildAndReplayMatch(style, [{ x: 20, y: 20, holdCount: 3 }]);
  assertV1LiveRebuildAndReplayMatch(style, [{ x: 0, y: 0, holdCount: 2 }, { x: 24, y: 0, holdCount: 3 }, { x: 48, y: 8, holdCount: 1 }]);
});

test("v1 Texture preserves segment material and interleaved holds through rebuild and replay", () => {
  const originalTip = brushTextureCatalog.getTintedTip;
  brushTextureCatalog.getTintedTip = (id, color) => ({ width: 8, height: 4, id, color });
  try {
    const style = { ...options, brush: "texture", textureId: "sequence-tip", spacing: .5, rotationMode: "followStroke", materialVersion: 1, colorMode: "gradient", startColor: "#ff0000", endColor: "#0000ff" };
    assertV1LiveRebuildAndReplayMatch(style, [{ x: 0, y: 0 }, { x: 7, y: 0 }, { x: 39, y: 6 }, { x: 46, y: 6 }]);
    assertV1LiveRebuildAndReplayMatch(style, [{ x: 0, y: 0 }, { x: 18, y: 0, holdCount: 2 }, { x: 51, y: 9 }, { x: 64, y: 9, holdCount: 1 }]);
  } finally {
    brushTextureCatalog.getTintedTip = originalTip;
  }
});

test("materialVersion 1 live paint reconstructs identical pixel-input instructions", () => {
  const points = [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 36, y: 8 }];
  const style = { ...options, brush: "pen", taper: "sine", materialVersion: 1, colorMode: "gradient", startColor: "#ff0000", endColor: "#0000ff" };
  const renderer = createPaintSessionRenderer({ kind: "pathStroke", points: [], style });
  const live = renderer.advance({ kind: "pathStroke", points, style }).flatMap(batch => batch.instructions);
  const rebuilt = renderer.reconstruct({ kind: "pathStroke", points, style }).flatMap(batch => batch.instructions);
  assert.deepEqual(rebuilt, live);
});

test("solid untapered adapter Pen uses one native source-over centerline", () => {
  const instructions = [];
  replayBrushPath(new BrushPainter(item => instructions.push(item)), [{ x: 0, y: 0 }, { x: 20, y: 0 }], {
    ...options, brush: "pen", taper: "none", colorMode: "solid", color: "#22aa66", materialVersion: 1
  });
  assert.equal(instructions.length, 1);
  assert.equal(instructions[0].type, "polyline");
  assert.ok(instructions.every(item => item.color === "#22aa66" && !item.composite));
});

test("solid adapter Pen contour replay preserves the closed centerline", () => {
  const instructions = [];
  replayBrushContours(new BrushPainter(item => instructions.push(item)), [{ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], closed: true }], {
    ...options, brush: "pen", taper: "none", colorMode: "solid", materialVersion: 1
  });
  assert.equal(instructions.length, 1);
  assert.equal(instructions[0].closed, true);
  assert.equal(instructions[0].type, "polyline");
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

test("texture replay resolves quantized material colors before requesting cached tips", () => {
  const originalTip = brushTextureCatalog.getTintedTip, colors = [];
  brushTextureCatalog.getTintedTip = (id, color) => { colors.push(color); return { width: 10, height: 10 }; };
  try {
    const style = { ...options, brush: "texture", textureId: "gradient-tip", spacing: 1,
      colorMode: "gradient", startColor: "#ff0000", endColor: "#0000ff", rotationMode: "followStroke" };
    replayBrushPath(new FakeContext2D(), [{ x: 0, y: 0 }, { x: 20, y: 0 }], style);
    assert.deepEqual(colors, [0, 10, 20].map(distance => resolveBrushMaterial(style, {
      energy: distance ? contourEnergy([{ x: 0, y: 0 }, { x: 20, y: 0 }], 1, style.size) : 0,
      progress: distance / (style.size * 24), profile: "texture", colorSteps: 32, opacityScale: style.opacity
    }).color));
  } finally { brushTextureCatalog.getTintedTip = originalTip; }
});

test("migrated v3 Pen retains both legacy gradients and versioned additive deposition", () => {
  const path = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }];
  const legacy = new FakeContext2D();
  replayBrushPath(legacy, path, { ...options, schemaVersion: 3, brush: "pen", colorMode: "gradient", startColor: "#ff0000", endColor: "#0000ff" });
  assert.deepEqual(legacy.calls.filter(([name]) => name === "fillStyle").map(([, color]) => color), ["#ff0000", "#800080", "#0000ff"]);
  const shared = [];
  replayBrushPath(new BrushPainter(item => shared.push(item)), path, { ...options, schemaVersion: 3, materialVersion: 1, brush: "pen", taper: "none", colorMode: "solid" });
  assert.equal(shared.length, path.length);
  assert.ok(shared.every(item => item.type === "circle" && item.composite === "lighter"));
});
