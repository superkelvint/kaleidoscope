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
    if (instruction.type === "polyline" && instruction.incremental) {
      // Replay immediate centerline deposition in input order. One native
      // stroke would blend translucent joins differently from live segments.
      const { points, incremental, ...style } = instruction;
      this.paint({ ...style, type: "circle", x: points[0].x, y: points[0].y, radius: style.width / 2 });
      for (let index = 1; index < points.length; index += 1) this.paint({ ...style, type: "polyline", points: [points[index - 1], points[index]] });
      ctx.restore(); return;
    }
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

/** Conservative source-space bounds for one backend-neutral instruction. */
export function brushInstructionBounds(instruction, padding = 2) {
  let points = instruction.points;
  let pad = (Number(instruction.width) || 0) / 2 + padding;
  if (!points) {
    points = [{ x: instruction.x, y: instruction.y }];
    if (instruction.type === "circle") pad = instruction.radius + padding;
    else if (instruction.type === "ellipse") pad = Math.max(instruction.radiusX, instruction.radiusY) + padding;
    else if (instruction.type === "image") pad = Math.hypot(instruction.width, instruction.height) / 2 + padding;
  }
  if (!points.length) return null;
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const point of points) { left = Math.min(left, point.x); top = Math.min(top, point.y); right = Math.max(right, point.x); bottom = Math.max(bottom, point.y); }
  return { left: left - pad, top: top - pad, right: right + pad, bottom: bottom + pad };
}
export function unionBrushBounds(a, b) {
  if (!a) return b;
  if (!b) return a;
  return { left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) };
}
