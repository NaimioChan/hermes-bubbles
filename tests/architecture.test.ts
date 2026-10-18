import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Two architectural invariants from AGENTS.md that neither typecheck nor the
 * component tests can see, because both are about what the code is NOT allowed
 * to touch.
 *
 * 铁律 1 — `src/core/` is pure: events in, timeline out. No `window`,
 * `document`, `WebSocket` or `fetch`. That is what makes the reducer, the
 * markdown parser and the session model testable without a DOM; a single stray
 * `document` reference silently moves a file out of the testable tier.
 *
 * No `innerHTML` anywhere in `src/ui/` — the Markdown renderer emits a node tree
 * and lets React escape the text, which is what removes HTML injection as a
 * possibility instead of sanitizing around it. One `dangerouslySetInnerHTML`
 * would hand a model-authored string direct control of the DOM, so it is worth
 * a guard rather than a convention.
 */

const SRC = join(__dirname, "..", "src");

function sourcesIn(dir: string): { name: string; text: string }[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ name: `${dir.split(/[\\/]/).pop()}/${name}`, text: readFileSync(join(dir, name), "utf8") }));
}

/** Strip comments so explanatory prose about a banned API does not trip the guard. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("architecture invariants", () => {
  it("keeps src/core free of DOM, network and socket globals", () => {
    const banned = [/\bwindow\./, /\bdocument\./, /\bnew WebSocket\b/, /\bfetch\s*\(/, /\blocalStorage\b/];
    const offences: string[] = [];
    for (const { name, text } of sourcesIn(join(SRC, "core"))) {
      const code = stripComments(text);
      for (const pattern of banned) {
        if (pattern.test(code)) offences.push(`${name}: ${pattern}`);
      }
    }
    expect(offences).toEqual([]);
  });

  it("keeps the plugin free of HTML-string injection", () => {
    const offences: string[] = [];
    for (const dir of ["core", "ui", "app", "gateway"]) {
      const full = join(SRC, dir);
      let files: { name: string; text: string }[];
      try {
        files = sourcesIn(full);
      } catch {
        continue;
      }
      for (const { name, text } of files) {
        const code = stripComments(text);
        for (const pattern of [/innerHTML/, /outerHTML/, /dangerouslySetInnerHTML/, /insertAdjacentHTML/]) {
          if (pattern.test(code)) offences.push(`${name}: ${pattern}`);
        }
      }
    }
    expect(offences).toEqual([]);
  });

  it("keeps every user-visible string in the catalog", () => {
    // 铁律 16: the plugin's default language is English and follows the
    // dashboard. A CJK character left in the code outside `core/i18n.ts` is a
    // string that bypassed the catalog — which is exactly how tool cards, slash
    // notices, attachment reasons and the tab label ended up Chinese on an
    // English dashboard (issues #6 and #7).
    const cjk = /[\u4e00-\u9fff]/;
    // Sanity-check the scanner before trusting it.
    expect(cjk.test(stripComments('const a = "你好";'))).toBe(true);
    expect(cjk.test(stripComments("// 中文注释 is fine"))).toBe(false);

    const offences: string[] = [];
    for (const dir of ["", "core", "ui", "app", "gateway"]) {
      let files: { name: string; text: string }[];
      try {
        files = sourcesIn(dir ? join(SRC, dir) : SRC);
      } catch {
        continue;
      }
      for (const { name, text } of files) {
        if (name === "core/i18n.ts") continue;
        const code = stripComments(text);
        code.split("\n").forEach((line, index) => {
          if (cjk.test(line)) offences.push(`${name}:${index + 1}: ${line.trim()}`);
        });
      }
    }
    expect(offences).toEqual([]);
  });

  it("keeps the notification sink alive across route changes", () => {
    // The controller is a module-level singleton (persistent.ts): it keeps
    // streaming while the user is on another dashboard route. Clearing the sink
    // in the page's cleanup therefore silenced notifications for exactly the
    // case they exist for — an arrival the user is not watching.
    const code = stripComments(readFileSync(join(SRC, "ui", "ChatPage.ts"), "utf8"));
    expect(code).toMatch(/controller\.setNoticeSink\(/);
    expect(code).not.toMatch(/setNoticeSink\(\s*null\s*\)/);
  });

  it("guards the regexes themselves (a guard that matches nothing is not a guard)", () => {
    // Sanity-check the two scanners against known-bad input.
    expect(/innerHTML/.test(stripComments("el.innerHTML = x;"))).toBe(true);
    expect(/\bdocument\./.test(stripComments("document.body"))).toBe(true);
    // Comments must be ignored, or this file would flag itself.
    expect(/\bdocument\./.test(stripComments("/* document.title */ const a = 1;"))).toBe(false);
    expect(/innerHTML/.test(stripComments("// innerHTML would be bad here"))).toBe(false);
    // The sink-lifetime guard must also be able to fire.
    expect(/setNoticeSink\(\s*null\s*\)/.test("controller.setNoticeSink(null);")).toBe(true);
    expect(/setNoticeSink\(\s*null\s*\)/.test(stripComments("// do not call setNoticeSink(null)"))).toBe(false);
  });
});
