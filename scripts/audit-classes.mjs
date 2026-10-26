/**
 * Audit every Tailwind-ish class the plugin uses against the host's compiled CSS.
 *
 * The plugin renders inside the dashboard's precompiled Tailwind bundle, so a
 * class the host never used is simply absent — no error, just a property that
 * never applies. This finds those.
 *
 * Run: node scripts/audit-classes.mjs
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(root);

function hermesHome() {
  if (process.env.HERMES_HOME) return process.env.HERMES_HOME;
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? ".", "AppData", "Local");
    return join(local, "hermes");
  }
  return join(process.env.HOME ?? ".", ".hermes");
}

const assetsDir = join(hermesHome(), "hermes-agent", "hermes_cli", "web_dist", "assets");
if (!existsSync(assetsDir)) {
  console.error(`audit: host CSS not found at ${assetsDir}`);
  process.exit(1);
}
const cssFile = readdirSync(assetsDir).find((f) => f.endsWith(".css"));
const css = readFileSync(join(assetsDir, cssFile), "utf8");

/** Tailwind escapes `.`, `/`, `[`, `]`, `%`, `(`, `)` etc. in selectors. */
function escapeClass(cls) {
  return cls.replace(/[.:/[\]()%,#!]/g, (ch) => `\\${ch}`);
}

function present(cls) {
  if (css.includes(`.${escapeClass(cls)}`)) return true;
  // Custom classes (hb-*) live in the plugin's own stylesheet, not the host's.
  return false;
}

const uiDir = join(projectRoot, "src", "ui");
const ownCss = readFileSync(join(uiDir, "style.css"), "utf8");
const ownClasses = new Set([...ownCss.matchAll(/\.([a-z][\w-]*)/g)].map((m) => m[1]));

const found = new Map();
// `.tsx` too: the project list and the workspace picker are TSX, and when this
// loop only read `.ts` their classes were never audited — a class the host lacks
// would have failed silently exactly the way this script exists to prevent.
for (const file of readdirSync(uiDir).filter((f) => /\.tsx?$/.test(f) && f !== "sdk.ts" && f !== "format.ts")) {
  const src = readFileSync(join(uiDir, file), "utf8");
  for (const match of src.matchAll(/className:\s*"([^"]+)"/g)) {
    for (const cls of match[1].split(/\s+/).filter(Boolean)) {
      if (!found.has(cls)) found.set(cls, new Set());
      found.get(cls).add(file);
    }
  }
}

const missing = [];
const ok = [];
for (const [cls, files] of [...found].sort((a, b) => a[0].localeCompare(b[0]))) {
  if (cls.startsWith("hb-")) {
    if (!ownClasses.has(cls)) missing.push([cls, `${[...files].join(",")} (hb- class not defined in style.css)`]);
    else ok.push(cls);
    continue;
  }
  if (present(cls)) ok.push(cls);
  else missing.push([cls, [...files].join(",")]);
}

console.log(`host CSS: ${cssFile} (${(css.length / 1024).toFixed(0)} KiB)`);
console.log(`classes used: ${found.size}   resolved from host/own CSS: ${ok.length}   missing: ${missing.length}\n`);
if (missing.length) {
  console.log("MISSING (these silently do nothing):");
  for (const [cls, where] of missing) console.log(`  ${cls.padEnd(28)} ${where}`);
  process.exitCode = 1;
} else {
  console.log("every class resolves.");
}
