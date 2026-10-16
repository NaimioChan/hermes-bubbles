/**
 * Install the built plugin into the Hermes plugin directory.
 *
 * A dashboard plugin is a directory layout, not a package: the dashboard scans
 * `$HERMES_HOME/plugins/<name>/dashboard/` for `manifest.json`. This copies the
 * build output there and tells the running dashboard to rescan, so a rebuild is
 * one command instead of a manual copy plus a server restart.
 */

import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(root);
const PLUGIN_NAME = "hermes-bubbles";

function hermesHome() {
  if (process.env.HERMES_HOME) return process.env.HERMES_HOME;
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(local, "hermes");
  }
  return join(homedir(), ".hermes");
}

async function main() {
  const dist = join(projectRoot, "dist");
  if (!existsSync(dist)) {
    console.error("install: dist/ is missing — run `npm run build` first.");
    process.exitCode = 1;
    return;
  }

  const dashboardDir = join(hermesHome(), "plugins", PLUGIN_NAME, "dashboard");
  // The manifest's paths are relative to `dashboard/` (entry: "dist/index.js"),
  // so the bundle keeps its `dist/` subdirectory. Flattening it here would make
  // every declared path a 404.
  await rm(dashboardDir, { recursive: true, force: true });
  await mkdir(join(dashboardDir, "dist"), { recursive: true });
  await cp(join(dist, "index.js"), join(dashboardDir, "dist", "index.js"));
  await cp(join(dist, "style.css"), join(dashboardDir, "dist", "style.css"));
  await cp(join(dist, "manifest.json"), join(dashboardDir, "manifest.json"));
  await cp(join(dist, "plugin_api.py"), join(dashboardDir, "plugin_api.py"));

  const files = await readdir(dashboardDir, { recursive: true });
  console.log(`installed → ${dashboardDir}`);
  console.log(`  files: ${files.join(", ")}`);

  // Nudge the running dashboard so the new bundle is picked up without a restart.
  const port = process.env.HERMES_DASHBOARD_PORT ?? "9119";
  const url = `http://127.0.0.1:${port}/api/dashboard/plugins/rescan`;
  try {
    const response = await fetch(url);
    const body = await response.text();
    console.log(`  rescan: ${response.status} ${body.slice(0, 120)}`);
  } catch (error) {
    console.log(`  rescan skipped (dashboard not running on ${port}): ${error instanceof Error ? error.message : error}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
