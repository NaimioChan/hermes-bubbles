/**
 * Build the plugin bundle.
 *
 * Output is a single IIFE at `dist/index.js` plus `dist/style.css`. React is
 * external by construction — the bundle never imports it (it takes the host's
 * instance off `window`), so there is no `external` entry to configure and no
 * way for a stray import to smuggle a second React into the page.
 */

import { build } from "esbuild";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");

/** Placeholder in `src/ui/style.css` that the build swaps for the PNG's data URI. */
const WHALE_TOKEN = "__WHALE_TAIL__";

async function main() {
  await mkdir(dist, { recursive: true });

  const result = await build({
    entryPoints: [join(root, "src/index.ts")],
    bundle: true,
    format: "iife",
    globalName: "HermesBubbles",
    outfile: join(dist, "index.js"),
    target: ["chrome110", "firefox110", "safari16"],
    minify: false,
    sourcemap: false,
    legalComments: "none",
    logLevel: "info",
  });

  if (result.errors.length > 0) {
    process.exitCode = 1;
    return;
  }

  const bundle = await readFile(join(dist, "index.js"), "utf8");
  // A bundled React would silently shadow the host's instance and break hooks.
  // Failing the build is cheaper than debugging that in a browser.
  if (/react\.production|react\.development|__SECRET_INTERNALS/.test(bundle)) {
    console.error("build: the bundle appears to contain React — it must come from the host SDK.");
    process.exitCode = 1;
    return;
  }

  await writeFile(
    join(dist, "style.css"),
    await readFile(join(root, "src/ui/style.css"), "utf8"),
    "utf8",
  );
  await cp(join(root, "manifest.json"), join(dist, "manifest.json"));
  await cp(join(root, "plugin_api.py"), join(dist, "plugin_api.py"));

  // The running whale tail is the one binary the plugin ships. Inlining it
  // keeps `dist/style.css` self-contained: no relative-URL resolution to get
  // wrong against whoever serves the plugin's static files, and no second asset
  // path in the manifest. The placeholder is asserted so a renamed token cannot
  // ship a mask pointing at the literal string `__WHALE_TAIL__`.
  const cssPath = join(dist, "style.css");
  const css = await readFile(cssPath, "utf8");
  const tail = await readFile(join(root, "src/ui/whale-tail.png"));
  if (!css.includes(WHALE_TOKEN)) {
    console.error(`build: ${WHALE_TOKEN} missing from src/ui/style.css — the whale tail would not render.`);
    process.exitCode = 1;
    return;
  }
  await writeFile(cssPath, css.split(WHALE_TOKEN).join(`data:image/png;base64,${tail.toString("base64")}`), "utf8");

  const bytes = Buffer.byteLength(bundle, "utf8");
  console.log(`built dist/index.js (${(bytes / 1024).toFixed(1)} KiB)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
