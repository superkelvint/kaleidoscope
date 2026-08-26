/**
 * Backend-neutral drawing instructions used by durable brushes.  The small
 * surface is intentional: Pixi can consume these without learning Canvas2D
 * path state, while Canvas remains the compatibility backend.
 */
export class BrushPainter {
  constructor(emit = () => {}) { this.emit = emit; }
  polyline(points, style = {}) { if (points?.length > 1) this.emit({ type: "polyline", points: points.map(({ x, y }) => ({ x, y })), ...style }); }
  circle(x, y, radius, style = {}) { this.emit({ type: "circle", x, y, radius, ...style }); }
  ellipse(x, y, radiusX, radiusY, rotation, style = {}) { this.emit({ type: "ellipse", x, y, radiusX, radiusY, rotation, ...style }); }
  image(image, x, y, width, height, rotation = 0, style = {}) { this.emit({ type: "image", image, x, y, width, height, rotation, ...style }); }
}

export class CanvasBrushPainter extends BrushPainter {
  constructor(ctx) {
    super(instruction => this.paint(instruction));
    this.ctx = ctx;
  }
  paint(instruction) {
    const ctx = this.ctx, alpha = instruction.opacity ?? 1;
    ctx.save(); ctx.globalAlpha = alpha;
    if (instruction.composite) ctx.globalCompositeOperation = instruction.composite;
    if (instruction.type === "polyline") {
      ctx.strokeStyle = instruction.color; ctx.lineWidth = instruction.width;
      ctx.lineCap = instruction.cap || "round"; ctx.lineJoin = instruction.join || "round";
      ctx.beginPath(); ctx.moveTo(instruction.points[0].x, instruction.points[0].y);
      for (let i = 1; i < instruction.points.length; i += 1) ctx.lineTo(instruction.points[i].x, instruction.points[i].y);
      if (instruction.closed) ctx.closePath(); ctx.stroke();
    } else if (instruction.type === "circle") {
      ctx.fillStyle = instruction.color; ctx.beginPath(); ctx.arc(instruction.x, instruction.y, instruction.radius, 0, Math.PI * 2); ctx.fill();
    } else if (instruction.type === "ellipse") {
      ctx.fillStyle = instruction.color; ctx.translate(instruction.x, instruction.y); ctx.rotate(instruction.rotation || 0);
      ctx.beginPath(); ctx.ellipse(0, 0, instruction.radiusX, instruction.radiusY, 0, 0, Math.PI * 2); ctx.fill();
    } else if (instruction.type === "image") {
      ctx.translate(instruction.x, instruction.y); ctx.rotate(instruction.rotation || 0);
      ctx.drawImage(instruction.image, -instruction.width / 2, -instruction.height / 2, instruction.width, instruction.height);
    }
    ctx.restore();
  }
}

export function toBrushPainter(target) { return target instanceof BrushPainter ? target : new CanvasBrushPainter(target); }
export function paintBrushInstructions(target, instructions = []) {
  const painter = toBrushPainter(target);
  for (const instruction of instructions) {
    if (typeof painter.paint === "function") painter.paint(instruction);
    else painter.emit(instruction);
  }
}
