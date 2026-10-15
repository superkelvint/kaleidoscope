import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const root = resolve(process.env.SITE_DIR || ".");
const basePath = process.env.BASE_PATH || "/";
const types = { ".html": "text/html", ".css": "text/css", ".svg": "image/svg+xml", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".png": "image/png" };
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (!pathname.startsWith(basePath)) throw new Error("invalid base path");
    const relative = decodeURIComponent(pathname.slice(basePath.length)) || "index.html";
    const file = resolve(root, relative);
    if (!file.startsWith(root + sep)) throw new Error("invalid path");
    if (!(await stat(file)).isFile()) throw new Error("not a file");
    response.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    response.end(await readFile(file));
  } catch { response.writeHead(404).end("not found"); }
});
server.listen(Number(process.env.PORT || 4173), "127.0.0.1");
