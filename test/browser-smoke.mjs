import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const server = spawn(process.execPath, ["tools/test-server.mjs"], { stdio: "ignore" });
const errors = [];
let browser;
try {
  await new Promise(resolve => setTimeout(resolve, 300));
  browser = await chromium.launch({ headless: true, args: ["--enable-webgl", "--use-angle=swiftshader"] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.addInitScript(() => { localStorage.clear(); window.__KALEIDOSCOPE_TEST_HOOKS__ = true; });
  await page.goto("http://127.0.0.1:4173/", { waitUntil: "networkidle" });
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
  await page.locator("#undoDrawing").click();
  assert.equal(await page.evaluate(() => window.__KALEIDOSCOPE_TEST_HOOKS__.drawingSource.operationCount), 0, "a second Undo is consumable and does nothing");
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
    const animatedId = drawingSource.commitDrawable({ kind: "generatedStroke", generator: "guillocheRosette", generatorVersion: 2, config: { petals: 8, secondaryFrequency: 13, primaryAmplitude: .08, secondaryAmplitude: .035, baseRadius: .2, rotation: 0, lineCount: 2, lineSpacing: .006, phaseOffset: 0 }, animation: { amount: .5, speed: .15, targets: { phaseOffset: true, secondaryAmplitude: false, secondaryFrequency: false, rotation: false } }, domain: { start: 0, end: Math.PI * 2 }, sampling: { mode: "parameter", step: .01 }, style: { brush: "pen", color: "#ffffff", colorMode: "solid", size: 4, opacity: 1, taper: "none", seed: 3 } });
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
  await page.locator("#drawingBrush").selectOption("wisp");
  await page.locator("#drawingWispEnergy").fill("0.8");
  await page.locator("#drawingWispMomentum").fill("0.42");
  await page.locator("#drawingWispTurbulence").fill("1.4");
  await page.locator("#drawingWispPersistence").fill("240");
  await page.locator("#drawingWispDensity").fill("8");
  await drawWisp(page, canvas);
  const wispStyle = await page.evaluate(() => window.__KALEIDOSCOPE_TEST_HOOKS__.drawingSource.findLatestDrawable()?.style);
  assert.equal(wispStyle?.brush, "wisp", "a browser Wisp gesture commits through the fixed-rate controller path");
  assert.deepEqual({ version: wispStyle?.version, energy: wispStyle?.energy, momentum: wispStyle?.momentum, turbulence: wispStyle?.turbulence, persistence: wispStyle?.persistence, density: wispStyle?.density }, { version: 2, energy: .8, momentum: .42, turbulence: 1.4, persistence: 240, density: 8 }, "the Wisp UI commits every artist control into the durable recipe");
  assert.ok(Number.isFinite(wispStyle?.wispUnitsPerPixel) && wispStyle.wispUnitsPerPixel > 0, "the browser Wisp stroke persists its frozen logical-pixel scale");
  await page.locator("#drawingTool").selectOption("arc");
  assert.equal(await page.locator("#drawingTool").inputValue(), "freehand", "Wisp tool coercion is reflected in the UI");
  await page.locator("#drawingGenerator").selectOption("spirograph");
  const generatorBrush = await page.evaluate(() => {
    const hooks = window.__KALEIDOSCOPE_TEST_HOOKS__;
    return { control: document.querySelector("#drawingBrush").value, controller: hooks.drawingController.settings.brush, preview: hooks.drawingSource.preview?.style?.brush };
  });
  assert.deepEqual(generatorBrush, { control: "pen", controller: "pen", preview: "pen" }, "generated paths cannot reinterpret Wisp time samples as spatial samples");
  assert.deepEqual(errors, []);
} finally {
  await browser?.close(); server.kill("SIGTERM");
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
