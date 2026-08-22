import test from "node:test";
import assert from "node:assert/strict";
import { BitmapSource } from "../bitmap-source.js";

class FakeImage {
  set src(value) {
    this.value = value;
    this.naturalWidth = 640;
    this.naturalHeight = 480;
    queueMicrotask(() => this.onload());
  }
}

function createSource(overrides = {}) {
  return new BitmapSource({
    ImageCtor: FakeImage,
    createObjectURL: () => "blob:test",
    revokeObjectURL: () => {},
    indexedDB: null,
    storage: { getItem: () => null },
    fetch: async () => ({ blob: async () => new Blob() }),
    ...overrides
  });
}

test("rejects values that are not supported images", async () => {
  await assert.rejects(createSource().load({ type: "text/plain" }), /supported image/);
});

test("decodes an image and exposes a stable WebGL-free frame snapshot", async () => {
  const source = createSource();
  await source.load({ type: "image/png" });
  assert.deepEqual(source.getResolution(), [640, 480]);
  assert.equal(source.revision, 1);
  const frame = source.getFrame();
  assert.equal(frame.width, 640);
  assert.equal(frame.height, 480);
  assert.equal(frame.revision, 1);
  assert.ok(frame.pixels instanceof FakeImage);
  assert.deepEqual(source.getFrame(), frame);

  await source.load({ type: "image/png" });
  assert.equal(source.getFrame().revision, 2);
});

test("restores no image when persistence contains neither format", async () => {
  const source = createSource();
  await assert.rejects(source.restore(), /IndexedDB/);
});
