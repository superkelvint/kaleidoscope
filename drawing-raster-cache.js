import { BrushPainter, paintBrushInstructions } from "./brush-painter.js";

/** A derived cache for a consecutive STATIC run, never an operation layer.
 *
 * A prefix is an opaque snapshot against the document background. Later runs
 * must work against an animated backdrop. Source-over/lighter instructions
 * compose to f(c) = min(ceiling, transmission * c + source), per color channel.
 * We rasterize the run against black and white to obtain source and ceiling;
 * painting source-over coverage black on white gives transmission. Three Canvas
 * blend passes then apply the run without replaying any static geometry.
 *
 * Fully covered pixels preserve additive saturation followed by translucent
 * paint. Canvas antialias coverage can clamp before resolving edge samples, so
 * cached edges can differ slightly from a fresh path rasterization; browser
 * tests bound both the total image error and the fraction of larger edge errors.
 * One
 * transparent source-over layer cannot represent that ordered combination.
 * All canvases are transient, at material density, and shared by the whole run.
 */
export class StaticRunCache {
  constructor({ createCanvas, width, height, backgroundColor = null }) {
    this.prefix = backgroundColor !== null;
    this.createCanvas = createCanvas;
    this.alphaImages = new WeakMap();
    this.operationIds = [];
    this.end = 0;
    const surface = color => {
      const canvas = createCanvas(width, height), context = canvas.getContext("2d");
      context.fillStyle = color; context.fillRect(0, 0, width, height);
      return { canvas, context };
    };
    this.source = surface(backgroundColor || "#000000");
    if (this.prefix) { this.context = this.source.context; this.painter = null; return; }
    this.ceiling = surface("#ffffff");
    this.transmission = surface("#ffffff");
    const contexts = [this.source.context, this.ceiling.context, this.transmission.context];
    // Transform and clip once for every sink. Instructions stream directly;
    // no emitted geometry or deposit history is retained by this cache.
    this.context = Object.fromEntries(["save", "restore", "translate", "scale", "beginPath", "rect", "clip"].map(method => [method, (...args) => {
      for (const context of contexts) context[method]?.(...args);
    }]));
    this.painter = new BrushPainter(instruction => {
      const composite = instruction.composite || "source-over";
      if (composite !== "source-over" && composite !== "lighter") throw new Error(`Unsupported static-run composite: ${composite}`);
      paintBrushInstructions(this.source.context, [instruction]);
      paintBrushInstructions(this.ceiling.context, [instruction]);
      if (composite === "source-over") {
        let image = instruction.image;
        if (instruction.type === "image" && image) {
          let alpha = this.alphaImages.get(image);
          if (!alpha) {
            alpha = this.createCanvas(image.width, image.height);
            const context = alpha.getContext("2d"); context.drawImage(image, 0, 0);
            context.globalCompositeOperation = "source-in"; context.fillStyle = "#000000";
            context.fillRect(0, 0, alpha.width, alpha.height); this.alphaImages.set(image, alpha);
          }
          image = alpha;
        }
        paintBrushInstructions(this.transmission.context, [{ ...instruction, color: "#000000", image, composite: "source-over" }]);
      }
    });
  }
  compositeInto(context) {
    context.save(); context.globalAlpha = 1;
    if (this.prefix) {
      context.globalCompositeOperation = "source-over"; context.drawImage(this.source.canvas, 0, 0);
    } else {
      context.globalCompositeOperation = "multiply"; context.drawImage(this.transmission.canvas, 0, 0);
      context.globalCompositeOperation = "lighter"; context.drawImage(this.source.canvas, 0, 0);
      context.globalCompositeOperation = "darken"; context.drawImage(this.ceiling.canvas, 0, 0);
    }
    context.restore();
  }
}
