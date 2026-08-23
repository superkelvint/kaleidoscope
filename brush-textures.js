/** PNG brush-tip catalog and reusable Canvas2D mask/tint cache. */
export const MAX_BRUSH_TEXTURE_DIMENSION = 512;
export const MAX_TINTED_VARIANTS_PER_TEXTURE = 32;
export const THUMBNAIL_SIZE = 128;

const texture = (id, label, filename) => ({ id, label, src: `./brushes/${filename}` });

// Keep this explicit: the app is served as native ES modules with no asset glob
// build step, and this is intentionally the only filename source of truth.
export const BRUSH_TEXTURES = [
  texture("wootha-charcoal-011", "Wootha Charcoal 011", "wootha-charcoal.abr-011.png"),
  texture("wootha-charcoal-021", "Wootha Charcoal 021", "wootha-charcoal.abr-021.png"),
  texture("wootha-charcoal-022", "Wootha Charcoal 022", "wootha-charcoal.abr-022.png"),
  texture("wootha-charcoal-023", "Wootha Charcoal 023", "wootha-charcoal.abr-023.png"),
  texture("wootha-001", "Wootha 001", "wootha.abr-001.png"),
  texture("wootha-003", "Wootha 003", "wootha.abr-003.png"),
  texture("wootha-014", "Wootha 014", "wootha.abr-014.png"),
  texture("wootha-015", "Wootha 015", "wootha.abr-015.png"),
  texture("wootha-023", "Wootha 023", "wootha.abr-023.png"),
  texture("wootha-024", "Wootha 024", "wootha.abr-024.png"),
  texture("wootha-025", "Wootha 025", "wootha.abr-025.png"),
  texture("wootha-028", "Wootha 028", "wootha.abr-028.png"),
  texture("wootha-032", "Wootha 032", "wootha.abr-032.png"),
  texture("wootha-035", "Wootha 035", "wootha.abr-035.png"),
  texture("wootha-047", "Wootha 047", "wootha.abr-047.png"),
  texture("wootha-048", "Wootha 048", "wootha.abr-048.png"),
  texture("wootha-049", "Wootha 049", "wootha.abr-049.png"),
  texture("wootha-050", "Wootha 050", "wootha.abr-050.png"),
  texture("wootha-052", "Wootha 052", "wootha.abr-052.png"),
  texture("wootha-053", "Wootha 053", "wootha.abr-053.png"),
  texture("wootha-054", "Wootha 054", "wootha.abr-054.png"),
  texture("wootha-055", "Wootha 055", "wootha.abr-055.png"),
  texture("wootha-062", "Wootha 062", "wootha.abr-062.png"),
  texture("wootha-063", "Wootha 063", "wootha.abr-063.png"),
  texture("wootha-064", "Wootha 064", "wootha.abr-064.png"),
  texture("wootha-065", "Wootha 065", "wootha.abr-065.png")
];

// A square charcoal tip makes the first texture stroke visibly distinct from
// the small round Pen default; users can select any catalog tip afterward.
export const DEFAULT_BRUSH_TEXTURE_ID = "wootha-charcoal-021";

export function createBrushCanvas(width, height) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export function fittedSize(width, height, maximum = MAX_BRUSH_TEXTURE_DIMENSION) {
  const scale = Math.min(1, maximum / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Unable to load brush texture: ${src}`));
    image.src = src;
  });
}

function normalizeMask(image) {
  const { width, height } = fittedSize(image.naturalWidth || image.width, image.naturalHeight || image.height);
  const source = createBrushCanvas(width, height);
  const sourceContext = source.getContext("2d", { willReadFrequently: true });
  sourceContext.drawImage(image, 0, 0, width, height);
  const pixels = sourceContext.getImageData(0, 0, width, height);
  const hasTransparency = pixels.data.some((_, index) => index % 4 === 3 && pixels.data[index] < 250);
  const mask = createBrushCanvas(width, height);
  const maskContext = mask.getContext("2d");
  const output = maskContext.createImageData(width, height);
  for (let index = 0; index < pixels.data.length; index += 4) {
    const luminance = 0.2126 * pixels.data[index] + 0.7152 * pixels.data[index + 1] + 0.0722 * pixels.data[index + 2];
    // Transparent exports already carry their intended shape; opaque Photoshop
    // exports are converted from black-on-white luminosity into alpha.
    const alpha = hasTransparency ? pixels.data[index + 3] : Math.round(255 - luminance);
    output.data[index] = 255;
    output.data[index + 1] = 255;
    output.data[index + 2] = 255;
    output.data[index + 3] = alpha;
  }
  maskContext.putImageData(output, 0, 0);
  return { width, height, maskCanvas: mask };
}

function thumbnailFor(maskCanvas, width, height) {
  const canvas = createBrushCanvas(THUMBNAIL_SIZE, THUMBNAIL_SIZE);
  const context = canvas.getContext("2d");
  context.fillStyle = "#e4e1ed";
  context.fillRect(0, 0, THUMBNAIL_SIZE, THUMBNAIL_SIZE);
  const scale = Math.min((THUMBNAIL_SIZE - 16) / width, (THUMBNAIL_SIZE - 16) / height);
  const drawWidth = width * scale, drawHeight = height * scale;
  // Build the dark mark on a transparent layer first. Applying source-in
  // directly after painting the opaque preview background would tint the
  // entire tile, hiding the brush shape in a dark rectangle.
  const mark = createBrushCanvas(THUMBNAIL_SIZE, THUMBNAIL_SIZE);
  const markContext = mark.getContext("2d");
  markContext.drawImage(maskCanvas, (THUMBNAIL_SIZE - drawWidth) / 2, (THUMBNAIL_SIZE - drawHeight) / 2, drawWidth, drawHeight);
  markContext.globalCompositeOperation = "source-in";
  markContext.fillStyle = "#272331";
  markContext.fillRect(0, 0, THUMBNAIL_SIZE, THUMBNAIL_SIZE);
  context.drawImage(mark, 0, 0);
  return canvas;
}

export class BrushTextureCatalog {
  constructor(entries = BRUSH_TEXTURES) {
    this.entries = entries;
    this.byId = new Map(entries.map(entry => [entry.id, entry]));
    this.loaded = new Map();
    this.loading = new Map();
    this.failed = new Set();
  }

  getEntry(id) { return this.byId.get(id) || null; }
  get(id) { return this.loaded.get(id) || null; }
  isLoading(id) { return this.loading.has(id); }
  isFailed(id) { return this.failed.has(id); }

  async ensure(id) {
    if (this.loaded.has(id)) return this.loaded.get(id);
    if (this.loading.has(id)) return this.loading.get(id);
    const entry = this.getEntry(id);
    if (!entry || this.failed.has(id)) return null;
    const promise = loadImage(entry.src).then(image => {
      const normalized = normalizeMask(image);
      const value = { ...entry, ...normalized, thumbnailCanvas: thumbnailFor(normalized.maskCanvas, normalized.width, normalized.height), tints: new Map() };
      this.loaded.set(id, value);
      return value;
    }).catch(error => {
      this.failed.add(id);
      console.warn(error.message);
      return null;
    }).finally(() => this.loading.delete(id));
    this.loading.set(id, promise);
    return promise;
  }

  getTintedTip(id, color) {
    const texture = this.get(id);
    if (!texture) return null;
    const cached = texture.tints.get(color);
    if (cached) {
      texture.tints.delete(color);
      texture.tints.set(color, cached);
      return cached;
    }
    const canvas = createBrushCanvas(texture.width, texture.height);
    const context = canvas.getContext("2d");
    context.fillStyle = color;
    context.fillRect(0, 0, texture.width, texture.height);
    context.globalCompositeOperation = "destination-in";
    context.drawImage(texture.maskCanvas, 0, 0);
    context.globalCompositeOperation = "source-over";
    texture.tints.set(color, canvas);
    if (texture.tints.size > MAX_TINTED_VARIANTS_PER_TEXTURE) texture.tints.delete(texture.tints.keys().next().value);
    return canvas;
  }
}

export const brushTextureCatalog = new BrushTextureCatalog();
