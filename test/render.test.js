import test from "node:test";
import assert from "node:assert/strict";
import { Renderer } from "../render.js";

function fakeGl() {
  const constants = ["VERTEX_SHADER","FRAGMENT_SHADER","COMPILE_STATUS","LINK_STATUS","ARRAY_BUFFER","STATIC_DRAW","FLOAT","TEXTURE_2D","TEXTURE_MIN_FILTER","TEXTURE_MAG_FILTER","TEXTURE_WRAP_S","TEXTURE_WRAP_T","LINEAR","REPEAT","CLAMP_TO_EDGE","RGBA","UNSIGNED_BYTE","FRAMEBUFFER","COLOR_ATTACHMENT0","COLOR_BUFFER_BIT","TEXTURE0","TEXTURE1","TRIANGLES"];
  const gl = Object.fromEntries(constants.map((name, index) => [name, index + 1]));
  for (const name of ["createShader","createProgram","createVertexArray","createBuffer","createTexture","createFramebuffer"]) gl[name] = () => ({});
  for (const name of ["shaderSource","compileShader","deleteShader","attachShader","linkProgram","bindVertexArray","bindBuffer","bufferData","enableVertexAttribArray","vertexAttribPointer","bindTexture","texParameteri","pixelStorei","activeTexture","bindFramebuffer","framebufferTexture2D","deleteFramebuffer","deleteTexture","viewport","clearColor","clear","useProgram","uniform1i","uniform2f","uniform1f","drawArrays"]) gl[name] = () => {};
  gl.textureUploads = 0;
  gl.drawCalls = 0;
  gl.texImage2D = () => { gl.textureUploads += 1; };
  gl.drawArrays = () => { gl.drawCalls += 1; };
  gl.getShaderParameter = () => true; gl.getProgramParameter = () => true; gl.getShaderInfoLog = () => ""; gl.getProgramInfoLog = () => ""; gl.getUniformLocation = () => ({}); gl.getAttribLocation = () => 0;
  return gl;
}

function createRenderer() {
  const canvas = { clientWidth: 1, clientHeight: 1, width: 1, height: 1, getContext: () => fakeGl() };
  return new Renderer(canvas);
}

test("owns independent state snapshots", () => {
  const renderer = createRenderer();
  renderer.updateState({ zoom: 2 }, { preview: false });
  const snapshot = renderer.getState();
  snapshot.zoom = 99;
  assert.equal(renderer.getState().zoom, 2);
});

test("updates renderer motion without exposing a mutable source contract", () => {
  const renderer = createRenderer();
  renderer.updateMotion("zoom", { source: "sine", amount: .3 });
  assert.deepEqual(renderer.getState().motion.zoom, { source: "sine", speed: .15, amount: .3, phase: 0 });
});

test("exposes effective coordinate mapping values at the current timeline time", () => {
  const renderer = createRenderer();
  renderer.updateState({
    currentTime: .25, animate: true, zoom: 2, pulseAmount: .5, pulseSpeed: 1,
    rotationDeg: 10, speedDeg: 20, panX: 0, panY: 0,
    driftX: .1, driftY: .2, driftMode: "linear", twist: 1
  }, { preview: false });
  renderer.updateMotion("panX", { source: "sine", speed: 1, amount: .1 });
  renderer.updateMotion("segments", { source: "sine", speed: 1, amount: 2 });
  renderer.updateMotion("twist", { source: "sine", speed: 1, amount: .5 });

  const mapping = renderer.getCurrentMappingState();
  assert.equal(mapping.zoom, 3);
  assert.ok(Math.abs(mapping.rotationRad - 15 * Math.PI / 180) < 1e-12);
  assert.ok(Math.abs(mapping.panX - .125) < 1e-12);
  assert.ok(Math.abs(mapping.panY - .05) < 1e-12);
  assert.equal(mapping.segments, 14);
  assert.ok(Math.abs(mapping.twist - 1.5) < 1e-12);
  assert.deepEqual(Object.keys(mapping).sort(), ["centerX", "centerY", "gridRotationDeg", "gridX", "gridY", "mirror", "panX", "panY", "rotationRad", "segments", "symmetryMode", "twist", "wallpaperMode", "wallpaperSize", "zoom"]);
});

test("activating a source uploads its frame and resets feedback history", () => {
  const renderer = createRenderer();
  const frame = { pixels: {}, width: 20, height: 10, revision: 0 };
  renderer.setSource({
    getFrame: () => frame
  });
  assert.deepEqual(renderer.imageResolution, [20, 10]);
  assert.equal(renderer.uploadedRevision, 0);
  assert.equal(renderer.getState().playing, false);
  assert.equal(renderer.sceneDirty, true);
});

test("incremental source revisions preserve feedback and renderer state", () => {
  let stateChanges = 0;
  const canvas = { clientWidth: 1, clientHeight: 1, width: 1, height: 1, getContext: () => fakeGl() };
  const renderer = new Renderer(canvas, { onStateChange: () => { stateChanges += 1; } });
  let frame = { pixels: {}, width: 20, height: 10, revision: 0 };
  renderer.setSource({
    getFrame: () => frame
  });

  renderer.sceneDirty = false;
  renderer.state.playing = false;
  frame = { pixels: {}, width: 40, height: 30, revision: 1 };

  assert.equal(renderer.syncSourceTexture(), true);
  assert.deepEqual(renderer.imageResolution, [40, 30]);
  assert.equal(renderer.sceneDirty, false);
  assert.equal(renderer.getState().playing, false);
  assert.equal(stateChanges, 0);
  assert.equal(renderer.syncSourceTexture(), false);
});

test("re-uploads a source when switching back to it at the same revision", () => {
  const renderer = createRenderer();
  const bitmap = { getFrame: () => ({ pixels: { name: "bitmap" }, width: 20, height: 10, revision: 4 }) };
  const drawing = { getFrame: () => ({ pixels: { name: "drawing" }, width: 20, height: 10, revision: 1 }) };

  renderer.setSource(bitmap);
  renderer.setSource(drawing);
  renderer.setSource(bitmap);

  assert.equal(renderer.uploadedSource, bitmap);
  assert.equal(renderer.uploadedRevision, 4);
  assert.equal(renderer.gl.textureUploads, 4);
});

test("updates post-processing without scheduling a feedback rebuild", () => {
  const renderer = createRenderer();
  renderer.sceneDirty = false;
  renderer.updatePostProcess({ bloomStrength: .5 });
  assert.equal(renderer.getState().bloomStrength, .5);
  assert.equal(renderer.sceneDirty, false);
});

test("drawing-source frames are presented through bloom before recording capture", () => {
  let presentations = 0;
  const canvas = { clientWidth: 1, clientHeight: 1, width: 1, height: 1, getContext: () => fakeGl() };
  const renderer = new Renderer(canvas, { onPresent: () => { presentations += 1; } });
  const drawing = { getFrame: () => ({ pixels: { name: "drawing" }, width: 20, height: 10, revision: 1 }) };

  renderer.resizeTargets(1, 1);
  renderer.setSource(drawing);
  renderer.updatePostProcess({ bloomStrength: .5, bloomThreshold: .2, bloomRadius: 1 });
  renderer.gl.drawCalls = 0;
  presentations = 0;
  renderer.drawStep(0);
  renderer.present();

  // One scene pass, six bloom passes (extract, four blur, composite), then
  // the final canvas blit that captureStream records.
  assert.equal(renderer.gl.drawCalls, 8);
  assert.equal(presentations, 1);
});
