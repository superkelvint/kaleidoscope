import { writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { renderFiberPath } from "../fiber-brush.js";

const width = 1024, height = 1024;
const brush = process.argv[2] === "hair" ? "hair" : "fiber";
const outputStem = brush === "hair" ? "hair-simulation" : "fiber-v2-simulation";
const escape = value => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

class SvgContext {
  constructor() {
    this.paths = []; this.stack = [];
    this.globalAlpha = 1; this.globalCompositeOperation = "source-over";
    this.strokeStyle = "#fff"; this.lineWidth = 1; this.lineCap = "round"; this.lineJoin = "round";
  }
  save() { this.stack.push({ globalAlpha: this.globalAlpha, globalCompositeOperation: this.globalCompositeOperation, strokeStyle: this.strokeStyle, lineWidth: this.lineWidth, lineCap: this.lineCap, lineJoin: this.lineJoin }); }
  restore() { Object.assign(this, this.stack.pop() || {}); }
  beginPath() { this.current = []; }
  moveTo(x, y) { this.current.push(`M ${x.toFixed(2)} ${y.toFixed(2)}`); }
  lineTo(x, y) { this.current.push(`L ${x.toFixed(2)} ${y.toFixed(2)}`); }
  stroke() {
    if (this.current?.length > 1) this.paths.push({ d: this.current.join(" "), alpha: this.globalAlpha, blend: this.globalCompositeOperation, color: this.strokeStyle, width: this.lineWidth, cap: this.lineCap, join: this.lineJoin });
  }
}

function gesture() {
  const output = [];
  for (let i = 0; i <= 280; i += 1) {
    const t = i / 280;
    output.push({ x: 115 + 790 * t + Math.sin(t * Math.PI * 2.1) * 45, y: 810 - 590 * t + Math.sin(t * Math.PI * 3.1 + .5) * 165 });
  }
  return output;
}

const context = new SvgContext();
renderFiberPath(context, gesture(), {
  brush, version: 2, seed: 375910235,
  size: 17, opacity: .96, colorMode: "gradient", startColor: "#ffd66b", endColor: "#ff4eae",
  gravity: 42, branching: 13, fibers: 6, curl: 12
});
const paths = context.paths.map(path => `<path d="${path.d}" fill="none" stroke="${escape(path.color)}" stroke-width="${path.width.toFixed(2)}" stroke-linecap="${path.cap}" stroke-linejoin="${path.join}" opacity="${path.alpha.toFixed(3)}" style="mix-blend-mode:${path.blend === "lighter" ? "screen" : "normal"}"/>`).join("\n  ");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs><filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
  <rect width="100%" height="100%" fill="#03182a"/>
  <g filter="url(#glow)">
  ${paths}
  </g>
</svg>\n`;

const pixels = new Uint8Array(width * height * 4);
for (let i = 0; i < pixels.length; i += 4) { pixels[i] = 3; pixels[i + 1] = 24; pixels[i + 2] = 42; pixels[i + 3] = 255; }
const rgb = color => color.match(/\d+/g).map(Number);
function paintDot(x, y, radius, color, alpha) {
  const left = Math.max(0, Math.floor(x - radius)), right = Math.min(width - 1, Math.ceil(x + radius));
  const top = Math.max(0, Math.floor(y - radius)), bottom = Math.min(height - 1, Math.ceil(y + radius));
  for (let py = top; py <= bottom; py += 1) for (let px = left; px <= right; px += 1) {
    const distance = Math.hypot(px + .5 - x, py + .5 - y) / Math.max(.001, radius);
    if (distance > 1) continue;
    const a = alpha * (1 - distance * distance) ** 2, index = (py * width + px) * 4;
    pixels[index] += (color[0] - pixels[index]) * a;
    pixels[index + 1] += (color[1] - pixels[index + 1]) * a;
    pixels[index + 2] += (color[2] - pixels[index + 2]) * a;
  }
}
for (const path of context.paths) {
  const numbers = path.d.match(/-?\d+(?:\.\d+)?/g).map(Number), color = rgb(path.color);
  for (let i = 2; i < numbers.length; i += 2) {
    const x0 = numbers[i - 2], y0 = numbers[i - 1], x1 = numbers[i], y1 = numbers[i + 1], steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
      paintDot(x, y, Math.max(2.5, path.width * 3.2), color, path.alpha * .075);
      paintDot(x, y, Math.max(.7, path.width / 2), color, path.alpha);
    }
  }
}
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => { let value = index; for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1; return value >>> 0; });
function crc(data) { let value = 0xffffffff; for (const byte of data) value = (value >>> 8) ^ crcTable[(value ^ byte) & 255]; return (value ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const name = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(Buffer.concat([name, data]))); return Buffer.concat([length, name, data, checksum]); }
const scanlines = Buffer.alloc((width * 4 + 1) * height);
for (let y = 0; y < height; y += 1) { const offset = y * (width * 4 + 1); scanlines[offset] = 0; Buffer.from(pixels.buffer, y * width * 4, width * 4).copy(scanlines, offset + 1); }
const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(scanlines)), chunk("IEND", Buffer.alloc(0))]);
await writeFile(new URL(`../examples/${outputStem}.svg`, import.meta.url), svg);
await writeFile(new URL(`../examples/${outputStem}.png`, import.meta.url), png);
console.log(JSON.stringify({ paths: context.paths.length, output: `examples/${outputStem}.png` }));
