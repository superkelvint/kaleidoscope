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
    return { historyCount: drawingSource.historyIndex, sourceEnergy, outputEnergy };
  });
  assert.ok(drawnPen.historyCount > 0 && drawnPen.sourceEnergy > 0 && drawnPen.outputEnergy > 100,
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
  await page.locator("#undoDrawing").click();
  await page.locator("#redoDrawing").click();
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
  const atlasDrift = await page.evaluate(() => {
    const { drawingSource, renderer } = window.__KALEIDOSCOPE_TEST_HOOKS__;
    const request = left => ({ worldBounds: { left, top: 0, right: left + 512, bottom: 512 }, pixelWidth: 512, pixelHeight: 512 });
    let left = 0;
    const source = {
      getWorldScale: () => drawingSource.getWorldScale(),
      getFrame: () => drawingSource.getFrame(),
      prepareView: () => drawingSource.prepareView(request(left))
    };
    renderer.setSource(source);
    renderer.sourceDiagnostics.textureSubUploads = 0;
    const initialRevision = drawingSource.revision;
    for (let index = 1; index <= 300; index += 1) {
      left = index / 10;
      renderer.syncSourceTexture();
    }
    const safe = { revision: drawingSource.revision, uploads: renderer.sourceDiagnostics.textureSubUploads };
    left = 60;
    renderer.syncSourceTexture();
    const crossed = { revision: drawingSource.revision, uploads: renderer.sourceDiagnostics.textureSubUploads };
    renderer.syncSourceTexture();
    const repeated = { revision: drawingSource.revision, uploads: renderer.sourceDiagnostics.textureSubUploads, frame: drawingSource.getFrame() };
    renderer.setSource(drawingSource);
    return { initialRevision, safe, crossed, repeated };
  });
  assert.equal(atlasDrift.safe.revision, atlasDrift.initialRevision, "safe linear drift does not revise the drawing atlas");
  assert.equal(atlasDrift.safe.uploads, 0, "safe linear drift produces no texture sub-uploads");
  assert.equal(atlasDrift.crossed.revision, atlasDrift.initialRevision + 1, "crossing the safe threshold recenters once");
  assert.equal(atlasDrift.crossed.uploads, 1, "the recentered atlas uploads once");
  assert.equal(atlasDrift.repeated.revision, atlasDrift.crossed.revision, "a repeated request stays in the new safe region");
  assert.equal(atlasDrift.repeated.uploads, 1, "a repeated request does not upload again");
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
