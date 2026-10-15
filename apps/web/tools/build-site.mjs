import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "dist");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
// Publish runtime files only. Keep tests, tools, and node_modules private.
for (const entry of await readdir(root, { withFileTypes: true })) {
  if ((entry.isFile() && /\.(js|html|css)$/.test(entry.name)) ||
      (entry.isDirectory() && ["brushes", "vendor"].includes(entry.name))) {
    await cp(join(root, entry.name), join(output, entry.name), { recursive: true });
  }
}
await cp(new URL("../../../LICENSE", import.meta.url), join(output, "LICENSE"));
await writeFile(join(output, ".nojekyll"), "");
console.log("Static site built in apps/web/dist");
