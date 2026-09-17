/**
 * Copy MapLibre's worker bundle into public/.
 *
 * v6 loads its worker as a separate ES module, which does not resolve under
 * Turbopack. Serving it as a static asset and pointing setWorkerUrl() at it
 * sidesteps the bundler. Re-run after every npm install (see package.json).
 */
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const from = join(here, "..", "node_modules", "maplibre-gl", "dist");
const to = join(here, "..", "public");

// The worker imports the shared chunk by relative path, so both must sit
// together at the same URL depth.
for (const f of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) {
  await mkdir(to, { recursive: true });
  await copyFile(join(from, f), join(to, f));
  console.log(`copied ${f} -> public/`);
}
