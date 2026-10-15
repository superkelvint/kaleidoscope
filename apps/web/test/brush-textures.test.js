import test from "node:test";
import assert from "node:assert/strict";
import { BRUSH_TEXTURES, DEFAULT_BRUSH_TEXTURE_ID, MAX_BRUSH_TEXTURE_DIMENSION, fittedSize } from "../brush-textures.js";

test("brush catalog has stable unique IDs and an explicit available default", () => {
  assert.equal(BRUSH_TEXTURES.length, 26);
  assert.equal(new Set(BRUSH_TEXTURES.map(texture => texture.id)).size, BRUSH_TEXTURES.length);
  assert.ok(BRUSH_TEXTURES.some(texture => texture.id === DEFAULT_BRUSH_TEXTURE_ID));
  assert.ok(BRUSH_TEXTURES.every(texture => texture.label && texture.src.endsWith(".png")));
});

test("decoded texture dimensions are capped once while preserving aspect ratio", () => {
  assert.deepEqual(fittedSize(1600, 800), { width: MAX_BRUSH_TEXTURE_DIMENSION, height: 256 });
  assert.deepEqual(fittedSize(300, 200), { width: 300, height: 200 });
});
