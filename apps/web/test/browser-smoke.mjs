import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const baseURL = process.env.SMOKE_URL || "http://127.0.0.1:4173/kaleidoscope/";
const server = process.env.SMOKE_URL ? null : spawn(process.execPath, ["tools/test-server.mjs"], { stdio: "ignore", env: { ...process.env, BASE_PATH: "/kaleidoscope/" } });
const errors = [];
let browser;
try {
  await new Promise(resolve => setTimeout(resolve, 300));
  browser = await chromium.launch({ headless: true, args: ["--enable-webgl", "--use-angle=swiftshader"] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(15000);
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("kaleidoscope-smoke-initialized")) { localStorage.clear(); sessionStorage.setItem("kaleidoscope-smoke-initialized", "1"); }
    window.__KALEIDOSCOPE_TEST_HOOKS__ = true;
  });
  await page.goto(baseURL, { waitUntil: "networkidle" });
  const canvas = page.locator("#gl"); await assertVisible(canvas);
  await page.locator("#sourceDrawing").click();
  await page.evaluate(() => {
    const { drawingSource, renderer } = window.__KALEIDOSCOPE_TEST_HOOKS__;
    drawingSource.clear();
    renderer.updateState({
      segments: 2, mirror: false, symmetryMode: "radial", wallpaperMode: "single",
      zoom: 2, panX: 1.4, panY: 0, animate: false, feedbackAmount: 0, bloomStrength: 0
    }, { preview: false });
  });
  console.log("Browser smoke: Ink and Undo");
  await draw(page, canvas, 140);
  const drawnPen = await page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    const { drawingSource } = window.__KALEIDOSCOPE_TEST_HOOKS__;
    const source = drawingSource.getFrame().pixels.getContext("2d");
    const sourcePixels = source.getImageData(0, 0, drawingSource.width, drawingSource.height).data;
    let sourceEnergy = 0;
    for (let index = 0; index < sourcePixels.length; index += 64) sourceEnergy += sourcePixels[index] + sourcePixels[index + 1] + sourcePixels[index + 2];
    const canvas = document.querySelector("#gl"), gl = canvas.getContext("webgl2"), rect = canvas.getBoundingClientRect();
    const left = Math.floor(100 / rect.width * gl.drawingBufferWidth), bottom = Math.floor((rect.height - 205) / rect.height * gl.drawingBufferHeight);
    const width = Math.ceil(340 / rect.width * gl.drawingBufferWidth), height = Math.ceil(110 / rect.height * gl.drawingBufferHeight);
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(left, bottom, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let outputEnergy = 0;
    for (let index = 0; index < pixels.length; index += 4) outputEnergy += pixels[index] + pixels[index + 1] + pixels[index + 2];
    return { operationCount: drawingSource.operationCount, sourceEnergy, outputEnergy };
  });
  assert.ok(drawnPen.operationCount > 0 && drawnPen.sourceEnergy > 0 && drawnPen.outputEnergy > 100,
    `a pointer-drawn pen stroke reaches the visible WebGL canvas; ${JSON.stringify(drawnPen)}`);
  const drawingPipeline = await page.evaluate(() => {
    const hooks = window.__KALEIDOSCOPE_TEST_HOOKS__;
    const frame = hooks?.drawingSource?.getFrame?.();
    return {
      hasPixels: "pixels" in (frame || {}),
      sourceDiagnostics: hooks?.renderer?.getSourceDiagnostics?.()
    };
  });
  assert.equal(drawingPipeline.hasPixels, true, "drawing source exposes the Canvas2D pixel frame required by Renderer");
  assert.equal(drawingPipeline.sourceDiagnostics.readPixelsCalls, 0, "drawing does not read WebGL pixels back to CPU");
  assert.equal(await page.locator("#undoDrawing").isDisabled(), false, "drawing commits content to history");
  const beforeUndo = await page.evaluate(() => window.__KALEIDOSCOPE_TEST_HOOKS__.drawingSource.operationCount);
  assert.equal(beforeUndo, 1, "the completed drawing is live");
  assert.equal(await page.locator("#redoDrawing").count(), 0, "Redo control has been removed");
  await page.locator("#undoDrawing").click();
  assert.equal(await page.evaluate(() => window.__KALEIDOSCOPE_TEST_HOOKS__.drawingSource.operationCount), 0, "Undo removes the latest drawing");
  assert.equal(await page.locator("#undoDrawing").isDisabled(), true, "the single Undo has been consumed");
  assert.equal(await page.evaluate(() => window.__KALEIDOSCOPE_TEST_HOOKS__.drawingSource.undo()), false, "a second Undo does nothing");
  console.log("Browser smoke: Spray");
  await page.locator("#drawingMaterial").selectOption("spray");
  await page.locator("#drawingDensity").evaluate(input => { input.value = "3"; input.dispatchEvent(new Event("input", { bubbles: true })); });
  await drawSpray(page, canvas, 270);
  const firstSpray = await drawingEnergy(page);
  await drawSpray(page, canvas, 350);
  const secondSpray = await drawingEnergy(page);
  assert.deepEqual(errors, [], "browser drawing emits no runtime errors");
  assert.equal(secondSpray.operationCount, 2, `two browser Spray gestures both commit through the controller: ${JSON.stringify(secondSpray)}`);
  assert.equal(secondSpray.brushes.every(brush => brush === "spray"), true, "the committed gestures retain Spray rather than falling back to Pen");
  assert.ok(secondSpray.energy > firstSpray.energy, "a later timed Spray gesture retains the earlier committed spray");
  await page.locator("#sourceImage").click();
  await page.locator("#sourceDrawing").click();
  const box = await canvas.boundingBox(); assert.ok(box);
  await page.mouse.wheel(0, -240);
  await page.locator("#bloomStrength").evaluate(input => { input.value = "0.5"; input.dispatchEvent(new Event("input", { bubbles: true })); });
  await draw(page, canvas, 320);
  assert.equal(await page.locator("#undoDrawing").isDisabled(), false, "source switching, zoom, bloom, and a later stroke retain content");
  const webglErrors = await page.evaluate(() => {
    const canvas = document.querySelector("#gl"), gl = canvas?.getContext("webgl2");
    return gl ? gl.getError() : -1;
  });
  assert.equal(webglErrors, 0, "WebGL reports no errors");
  console.log("Browser smoke: periodic material and generator animation");
  const periodicDrift = await page.evaluate(async () => {
    const { drawingSource, renderer } = window.__KALEIDOSCOPE_TEST_HOOKS__;
    const energy = () => {
      const canvas = document.querySelector("#gl"), gl = canvas.getContext("webgl2");
      const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
      gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels.reduce((total, value, index) => total + (index % 4 === 3 ? 0 : value), 0);
    };
    const present = async patch => {
      renderer.updateState({ segments: 2, mirror: false, symmetryMode: "radial", wallpaperMode: "single", zoom: 2, feedbackAmount: 0, bloomStrength: 0, ...patch }, { preview: false });
      renderer.requestRender(); await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
      return energy();
    };
    const initial = await present({ animate: false, panX: 0, panY: 0, rotationDeg: 0 });
    const revision = drawingSource.revision, material = drawingSource.materialBounds, rebuilds = drawingSource.materialRebuildCount;
    const diagnostics = renderer.getSourceDiagnostics();
    const longDrift = await present({ animate: true, playing: false, driftMode: "linear", driftX: 1, driftY: 0, currentTime: 10000, panX: 0, panY: 0, rotationDeg: 0 });
    const largePan = await present({ animate: false, panX: 100, panY: 100, rotationDeg: 0 });
    const rotated = await present({ animate: false, panX: 0, panY: 0, rotationDeg: 3600 });
    const afterMotionRevision = drawingSource.revision, afterMotionMaterial = drawingSource.materialBounds, afterMotionRebuilds = drawingSource.materialRebuildCount, afterMotionDiagnostics = renderer.getSourceDiagnostics();
    const animatedId = drawingSource.commitDrawable({ kind: "generatedStroke", generator: "guillocheRosette", generatorVersion: 2, config: { petals: 8, secondaryFrequency: 13, primaryAmplitude: .08, secondaryAmplitude: .035, baseRadius: .2, rotation: 0, lineCount: 2, lineSpacing: .006, phaseOffset: 0 }, animation: { amount: .5, speed: .15, targets: { phaseOffset: true, secondaryAmplitude: false, secondaryFrequency: false, rotation: false } }, domain: { start: 0, end: Math.PI * 2 }, sampling: { mode: "parameter", step: .01 }, material: { type: "ink", color: "#ffffff", width: 4, opacity: 1, seed: 3 } });
    const animatedStart = drawingSource.revision;
    const mirrorRadial = await present({ animate: false, currentTime: 1, symmetryMode: "mirrorRadial", wallpaperMode: "single", panX: 0, panY: 0, rotationDeg: 0 });
    const p6m = await present({ animate: false, currentTime: 2, symmetryMode: "radial", wallpaperMode: "p6m", panX: 0, panY: 0, rotationDeg: 0 });
    return { initial, longDrift, largePan, rotated, mirrorRadial, p6m, animatedId, animatedStart, afterAnimationRevision: drawingSource.revision, revision, afterRevision: afterMotionRevision, material, afterMaterial: afterMotionMaterial, rebuilds, afterRebuilds: afterMotionRebuilds, diagnostics, afterDiagnostics: afterMotionDiagnostics };
  });
  assert.ok(periodicDrift.initial > 100, "the baseline drawing material is visible");
  assert.ok(periodicDrift.longDrift > 100, "linear drift at 10,000 periods never reaches permanent black");
  assert.ok(periodicDrift.largePan > 100 && periodicDrift.rotated > 100, "large pan and repeated rotation continue sampling the material");
  assert.ok(periodicDrift.mirrorRadial > 100 && periodicDrift.p6m > 100, "Mirror Radial and p6m sample the same periodic drawing material");
  assert.ok(periodicDrift.animatedId && periodicDrift.afterAnimationRevision > periodicDrift.animatedStart, "animated Guilloché updates derived material while static Pen remains present");
  assert.equal(periodicDrift.afterRevision, periodicDrift.revision, "pure source motion does not revise drawing pixels");
  assert.deepEqual(periodicDrift.afterMaterial, periodicDrift.material, "source motion does not move the repeat domain");
  assert.equal(periodicDrift.afterRebuilds, periodicDrift.rebuilds, "source motion does not rebuild the material");
  assert.deepEqual(periodicDrift.afterDiagnostics, periodicDrift.diagnostics, "source motion does not upload unchanged drawing pixels");
  console.log("Browser smoke: Wisp");
  await page.locator("#clearDrawing").click();
  assert.equal(await page.locator("#undoDrawing").isDisabled(), true);
  await page.locator("#drawingGeometry").selectOption("wisp");
  await page.locator("#drawingWispEnergy").fill("0.8");
  await page.locator("#drawingWispControls details summary").click();
  await page.locator("#drawingWispMomentum").fill("0.42");
  await page.locator("#drawingWispTurbulence").fill("1.4");
  await page.locator("#drawingWispPersistence").fill("240");
  await page.locator("#drawingWispDensity").fill("8");
  await drawWisp(page, canvas);
  await page.waitForFunction(() => !window.__KALEIDOSCOPE_TEST_HOOKS__.drawingSource.hasPaintSessions(), null, { timeout: 30000 });
  assert.equal(await page.locator("#undoDrawing").isDisabled(), false, "asynchronous Wisp completion enables Undo");
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("kaleidoscope.workspace.v13") || "null")?.drawing?.content?.operations?.some(operation => operation.geometry?.type === "wisp"));
  const wispStyle = await page.evaluate(async () => { const { strokeStyle } = await import("./stroke-recipe.js"); return strokeStyle(window.__KALEIDOSCOPE_TEST_HOOKS__.drawingSource.findLatestDrawable(() => true).drawable); });
  assert.equal(wispStyle?.brush, "wisp", "a browser Wisp gesture commits through the fixed-rate controller path");
  assert.deepEqual({ version: wispStyle?.version, energy: wispStyle?.energy, momentum: wispStyle?.momentum, turbulence: wispStyle?.turbulence, persistence: wispStyle?.persistence, density: wispStyle?.density }, { version: 2, energy: .8, momentum: .42, turbulence: 1.4, persistence: 240, density: 8 }, "the Wisp UI commits every artist control into the durable recipe");
  assert.ok(Number.isFinite(wispStyle?.wispUnitsPerPixel) && wispStyle.wispUnitsPerPixel > 0, "the browser Wisp stroke persists its frozen logical-pixel scale");
  await page.locator("#drawingTool").selectOption("arc");
  assert.equal(await page.locator("#drawingTool").inputValue(), "freehand", "Wisp tool coercion is reflected in the UI");
  await page.locator("summary").filter({ hasText: /^Generator$/ }).click();
  await page.locator("#drawingGenerator").selectOption("spirograph");
  assert.deepEqual(errors, [], "generator selection runs without UI errors");
  const generatorBrush = await page.evaluate(() => {
    const hooks = window.__KALEIDOSCOPE_TEST_HOOKS__;
    return { control: document.querySelector("#drawingMaterial").value, controller: hooks.drawingController.settings.material, preview: hooks.drawingSource.preview?.material?.type };
  });
  assert.deepEqual(generatorBrush, { control: "ink", controller: "ink", preview: "ink" }, "generated paths cannot reinterpret Wisp time samples as spatial samples");
  console.log("Browser smoke: workspace reload");
  await page.locator("#commitGenerator").click();
  const expectedWorkspace = await page.evaluate(() => ({
    content: JSON.parse(JSON.stringify(window.__KALEIDOSCOPE_TEST_HOOKS__.drawingSource.getContentState())),
    settings: window.__KALEIDOSCOPE_TEST_HOOKS__.drawingController.getState()
  }));
  await page.waitForFunction(content => {
    const saved = JSON.parse(localStorage.getItem("kaleidoscope.workspace.v13") || "null");
    return JSON.stringify(saved?.drawing?.content) === content;
  }, JSON.stringify(expectedWorkspace.content));
  await page.reload({ waitUntil: "networkidle" });
  const restoredWorkspace = await page.evaluate(() => ({
    content: JSON.parse(JSON.stringify(window.__KALEIDOSCOPE_TEST_HOOKS__.drawingSource.getContentState())),
    settings: window.__KALEIDOSCOPE_TEST_HOOKS__.drawingController.getState(),
    canUndo: window.__KALEIDOSCOPE_TEST_HOOKS__.drawingSource.canUndo()
  }));
  assert.deepEqual(restoredWorkspace.content, expectedWorkspace.content, "workspace reload preserves ordered paint and generator recipes");
  assert.deepEqual(restoredWorkspace.settings, expectedWorkspace.settings);
  assert.equal(restoredWorkspace.canUndo, false);
  console.log("Browser smoke: Ink/Silk live pixels, commit, reconstruction, and persistence");
  const materialChecks = await page.evaluate(async () => {
    const { DrawingSource } = await import("./drawing-source.js");
    const { brushTextureCatalog } = await import("./brush-textures.js");
    const tip = new OffscreenCanvas(8, 8), tipContext = tip.getContext("2d");
    tipContext.fillStyle = "rgba(136,221,255,.6)"; tipContext.fillRect(1, 1, 6, 6);
    brushTextureCatalog.loaded.set("smoke-tip", { width: 8, height: 8, tints: new Map([["#88ddff", tip]]) });
    const results = [];
    for (const [type, background] of [["ink", "#000000"], ["silk", "#000000"], ["silk", "#241821"], ["fiber", "#241821"], ["hair", "#000000"], ["texture", "#000000"]]) {
      const source = new DrawingSource({ width: 1024, height: 1024 });
      source.setBackgroundColor(background);
      const points = [{ x: 40, y: 60 }, { x: 63, y: 65 }, { x: 80, y: 40 }, { x: 105, y: 75 }];
      const specialized = ["fiber", "hair", "texture"].includes(type);
      const recipe = count => ({ kind: "pathStroke", gesture: { points: points.slice(0, count), seed: 17 }, geometry: { type: type === "texture" || !specialized ? "freehand" : type },
        material: { type: specialized ? "adapter" : type, color: "#88ddff", width: 5, opacity: .45, strands: 3,
          ...(specialized ? { options: type === "texture" ? { brush: type, textureId: "smoke-tip", spacing: .5, rotationMode: "followStroke" } : { brush: type, version: 2, fibers: .2, gravity: 20, branching: 0, curl: 0, spread: .5, wispiness: .5, assistLevel: .5 } } : {}) } });
      const pixels = () => source.getFrame().pixels.getContext("2d").getImageData(0, 0, 256, 256).data;
      let replays = 0;
      const paint = source.paintOperation;
      source.paintOperation = (...args) => { replays += 1; return paint(...args); };
      const blank = pixels();
      const id = source.beginPaintSession(recipe(1));
      for (let count = 2; count <= points.length; count += 1) source.updatePaintSession(id, recipe(count));
      const visibleDuringGesture = pixels().some((value, index) => index % 4 !== 3 && value !== blank[index]);
      const before = pixels();
      source.finishPaintSession(id);
      for (let count = 0; count < 120 && source.hasPaintSessions(); count += 1) await new Promise(requestAnimationFrame);
      const committed = pixels(), completionReplays = replays;
      const saved = source.getContentState();
      const restored = source.restoreContentState(saved), rebuilt = pixels();
      let maxDifference = 0, differenceSum = 0, commitDifference = 0;
      for (let index = 0; index < committed.length; index += 1) {
        const difference = Math.abs(committed[index] - rebuilt[index]);
        maxDifference = Math.max(maxDifference, difference); differenceSum += difference;
        commitDifference = Math.max(commitDifference, Math.abs(committed[index] - before[index]));
      }
      results.push({ type, background, visibleDuringGesture, completionReplays, operationCount: source.operationCount, finished: !source.hasPaintSessions(), restored, maxDifference, averageDifference: differenceSum / committed.length, commitDifference, undoAfterRestore: source.canUndo() });
    }
    return results;
  });
  console.log("Material pixel checks:", JSON.stringify(materialChecks));
  for (const check of materialChecks) {
    assert.equal(check.visibleDuringGesture, true, `${check.type} deposits during the gesture`);
    assert.equal(check.completionReplays, 0, `${check.type} completion promotes visible pixels`);
    assert.equal(check.operationCount, 1);
    assert.equal(check.finished, true);
    assert.equal(check.restored, true);
    assert.equal(check.undoAfterRestore, false);
    // Flushing live Canvas batches and rebuilding tiles can rasterize edge
    // coverage and premultiplied alpha slightly differently. Limit both the
    // worst edge and total error.
    assert.ok(check.maxDifference <= 16 && check.averageDifference < .03, `${check.type} reconstructs the visible pixels: ${JSON.stringify(check)}`);
    if (check.type !== "silk") assert.equal(check.commitDifference, 0, `${check.type} completion never changes deposited pixels`);
  }
  await verifyAnimationCaching(page);
  assert.deepEqual(errors, []);
} finally {
  await browser?.close(); server?.kill("SIGTERM");
}

async function assertVisible(locator) { assert.ok(await locator.isVisible(), "WebGL canvas is visible"); }
async function draw(page, canvas, y) {
  const box = await canvas.boundingBox(); assert.ok(box, "canvas has bounds");
  const x1 = box.x + 120, x2 = box.x + Math.min(box.width - 80, 400);
  await page.mouse.move(x1, box.y + y); await page.mouse.down();
  for (let i = 1; i <= 10; i += 1) await page.mouse.move(x1 + (x2 - x1) * i / 10, box.y + y + Math.sin(i / 10 * Math.PI) * 18);
  await page.mouse.up(); await page.waitForTimeout(50);
}

async function drawWisp(page, canvas) {
  const box = await canvas.boundingBox(); assert.ok(box, "canvas has bounds");
  const y = box.y + 250, start = box.x + 160, end = box.x + Math.min(box.width - 100, 520);
  await page.mouse.move(start, y); await page.mouse.down();
  for (let i = 1; i <= 8; i += 1) {
    await page.waitForTimeout(18);
    await page.mouse.move(start + (end - start) * i / 8, y);
  }
  await page.mouse.up(); await page.waitForTimeout(50);
}

async function drawSpray(page, canvas, y) {
  const box = await canvas.boundingBox(); assert.ok(box, "canvas has bounds");
  const start = box.x + 170, end = box.x + Math.min(box.width - 150, 330);
  await page.mouse.move(start, box.y + y); await page.mouse.down();
  for (let i = 1; i <= 5; i += 1) {
    await page.waitForTimeout(24);
    await page.mouse.move(start + (end - start) * i / 5, box.y + y);
  }
  await page.waitForTimeout(48); await page.mouse.up(); await page.waitForTimeout(50);
}

async function drawingEnergy(page) {
  return page.evaluate(() => {
    const { drawingSource } = window.__KALEIDOSCOPE_TEST_HOOKS__;
    const context = drawingSource.getFrame().pixels.getContext("2d");
    const pixels = context.getImageData(0, 0, drawingSource.width, drawingSource.height).data;
    let energy = 0;
    for (let index = 0; index < pixels.length; index += 64) energy += pixels[index] + pixels[index + 1] + pixels[index + 2];
    return { energy, operationCount: drawingSource.operationCount, brushes: drawingSource.getContentState().operations.map(operation => operation.material?.options?.brush) };
  });
}

async function verifyAnimationCaching(page) {
  console.log("Browser smoke: cached animation against full ordered replay");
  const { checks, coreMaxDifference } = await page.evaluate(async () => {
    const { DrawingSource } = await import("./drawing-source.js");
    const { StaticRunCache } = await import("./drawing-raster-cache.js");
    const { paintBrushInstructions } = await import("./brush-painter.js");
    const results = [];
    const paintRecipe = (type, points, color, opacity = .6) => ({ kind: "pathStroke", gesture: { points, seed: 19 }, geometry: { type: "freehand" }, material: { type, color, opacity, width: 9, strands: 3, spread: 7, seed: 19 } });
    const generator = color => ({ kind: "generatedStroke", generator: "guillocheRosette", generatorVersion: 2,
      config: { petals: 8, secondaryFrequency: 13, primaryAmplitude: .08, secondaryAmplitude: .035, baseRadius: .2, rotation: 0, lineCount: 2, lineSpacing: .006, phaseOffset: 0 },
      animation: { amount: .5, speed: .15, targets: { phaseOffset: true, secondaryAmplitude: false, secondaryFrequency: false, rotation: false } }, domain: { start: 0, end: Math.PI * 2 }, sampling: { mode: "parameter", step: .02 }, material: { type: "ink", color, opacity: .7, width: 3 } });
    for (const density of [1, 2]) for (const background of ["#000000", "#473223"]) {
      const source = new DrawingSource({ width: 256, height: 256 });
      source.setBackgroundColor(background);
      const path = [{ x: 75, y: 110 }, { x: 120, y: 140 }, { x: 175, y: 115 }];
      source.commitDrawable(paintRecipe("ink", path, "#2299ff"));
      const dynamic = [source.commitDrawable(generator("#ee6677"))];
      source.commitDrawable(paintRecipe("silk", path, "#aaffff"));
      source.commitDrawable(paintRecipe("ink", path, "#112200", .8));
      dynamic.push(source.commitDrawable(generator("#77cc55")));
      source.commitDrawable(paintRecipe("ink", path, "#442266", .4));
      source.commitDrawable(paintRecipe("silk", path, "#ffeeaa"));
      source.prepareView({ pixelDensity: density }); source.setTime(.3);
      const original = source.paintOperation, painted = [];
      source.paintOperation = (operation, ...args) => { painted.push(operation.id); return original(operation, ...args); };
      let maxDifference = 0, sum = 0, channels = 0, largeDifferences = 0;
      for (const time of [.7, 1.2]) {
        source.setTime(time);
        const cached = source.getFrame().pixels.getContext("2d").getImageData(0, 0, 256 * density, 256 * density).data;
        const reference = new OffscreenCanvas(256 * density, 256 * density), context = reference.getContext("2d");
        context.fillStyle = background; context.fillRect(0, 0, reference.width, reference.height);
        for (const operation of source.rasterizer.operations) original(operation, context, { periodic: true, transform: { x: 0, y: 0, sx: density, sy: density } });
        const expected = context.getImageData(0, 0, reference.width, reference.height).data;
        for (let index = 0; index < cached.length; index += 1) { const difference = Math.abs(cached[index] - expected[index]); maxDifference = Math.max(maxDifference, difference); sum += difference; if (difference > 24) largeDifferences += 1; }
        channels += cached.length;
      }
      results.push({ density, background, painted, dynamic, maxDifference, averageDifference: sum / channels, largeDifferenceFraction: largeDifferences / channels });
    }
    let seed = 3, coreMaxDifference = 0;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    const color = () => `#${Math.floor(random() * 0xffffff).toString(16).padStart(6, "0")}`;
    for (let trial = 0; trial < 100; trial += 1) {
      const background = color(), cache = new StaticRunCache({ createCanvas: (width, height) => new OffscreenCanvas(width, height), width: 8, height: 8 });
      const reference = new OffscreenCanvas(8, 8), context = reference.getContext("2d"); context.fillStyle = background; context.fillRect(0, 0, 8, 8);
      for (let index = 0; index < 20; index += 1) {
        const instruction = { type: "circle", x: 4, y: 4, radius: 20, color: color(), opacity: random(), composite: random() < .5 ? "lighter" : "source-over" };
        cache.painter.emit(instruction); paintBrushInstructions(context, [instruction]);
      }
      const output = new OffscreenCanvas(8, 8), target = output.getContext("2d"); target.fillStyle = background; target.fillRect(0, 0, 8, 8); cache.compositeInto(target);
      const expected = context.getImageData(4, 4, 1, 1).data, actual = target.getImageData(4, 4, 1, 1).data;
      for (let index = 0; index < 4; index += 1) coreMaxDifference = Math.max(coreMaxDifference, Math.abs(expected[index] - actual[index]));
    }
    return { checks: results, coreMaxDifference };
  });
  console.log("Animation pixel checks:", JSON.stringify({ checks: checks.map(({ density, background, maxDifference, averageDifference, largeDifferenceFraction }) => ({ density, background, maxDifference, averageDifference, largeDifferenceFraction })), coreMaxDifference }));
  assert.ok(coreMaxDifference <= 2, "100 varied saturated/translucent blend sequences agree away from antialiased edges");
  for (const check of checks) {
    assert.ok(check.dynamic.every(id => typeof id === "string"), "the fixture committed real animated generators");
    assert.deepEqual(check.painted, [...check.dynamic, ...check.dynamic], "only animated operations rasterize on a warm animation tick");
    assert.ok(check.maxDifference <= 64 && check.averageDifference < .1 && check.largeDifferenceFraction < .001, `cached runs preserve ordered source-over/additive blends: ${JSON.stringify(check)}`);
  }
}
