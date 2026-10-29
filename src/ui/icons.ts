/**
 * The plugin's own icon set.
 *
 * Inline SVG through `React.createElement`, not an icon package and not a font:
 * the bundle ships without extra dependencies, the glyphs inherit `currentColor`
 * so they follow the theme, and there is no webfont to fetch from a host that
 * may not serve one.
 *
 * **Geometry comes from Lucide** (ISC, https://lucide.dev) — the path data below
 * is Lucide's `lucide-static` 1.64.0 drawings, trimmed to what this file needs.
 * The point is not taste, it is consistency: every shape shares one 24-unit grid,
 * one stroke weight and one optical size, so a row of three buttons reads as a
 * set. The reply footer used to be three *text glyphs* — `⑂`, `⧉`, `↻` — which
 * are three different fonts' idea of a glyph with three different bounding boxes,
 * cap heights and stroke densities. No amount of `font-size` reconciles that;
 * only drawing them on one grid does.
 *
 * One deviation: the three-dot menu is filled circles rather than Lucide's
 * stroked ones. A 1.75px stroke around a zero-radius point renders as a faint
 * comma at 18px, and the menu affordance has to read as three even dots.
 */

import type { HermesPluginSdk } from "./sdk";

export type IconName =
  | "refresh"
  | "dots"
  | "send"
  | "stop"
  | "insert"
  | "paperclip"
  | "plus"
  | "model"
  | "reasoning"
  | "bell"
  | "bellOff"
  | "close"
  | "image"
  | "video"
  | "file"
  | "chevron"
  | "branch"
  | "copy"
  | "check"
  | "redo"
  | "pencil"
  | "trash"
  | "download"
  | "alert"
  | "circle"
  | "circleDot";

/** Path data per icon: `[d, ...]` drawn with one shared stroke style. */
const PATHS: Record<IconName, string[]> = {
  // Circular arrow: the chat-page refresh (data only, not a browser reload).
  refresh: ["M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8", "M21 3v5h-5"],
  // Three dots: the menu affordance ("···" as the brief calls it).
  dots: ["M6 12h.01", "M12 12h.01", "M18 12h.01"],
  send: ["M12 19V5", "M5.5 11.5 12 5l6.5 6.5"],
  // A filled square is the universal stop; `fill` is set per icon below.
  stop: ["M8 8h8v8H8z"],
  // Arrow into a tray line: delivering the message into a running turn.
  insert: ["M12 7v14", "m18 13-6-6-6 6", "M5 3h14"],
  paperclip: [
    "m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551",
  ],
  plus: ["M5 12h14", "M12 5v14"],
  // Model: a chip with its pins.
  model: [
    "M12 2v2", "M12 20v2", "M17 2v2", "M17 20v2",
    "M2 7h2", "M2 12h2", "M2 17h2", "M20 7h2", "M20 12h2", "M20 17h2",
    "M7 2v2", "M7 20v2",
    "M7 4h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
    "M10 8h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z",
  ],
  // Reasoning effort: a dial.
  reasoning: ["m12 14 4-4", "M3.34 19a10 10 0 1 1 17.32 0"],
  bell: [
    "M10.268 21a2 2 0 0 0 3.464 0",
    "M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326",
  ],
  bellOff: [
    "M10.268 21a2 2 0 0 0 3.464 0",
    "M17 17H4a1 1 0 0 1-.74-1.673C4.59 13.956 6 12.499 6 8a6 6 0 0 1 .258-1.742",
    "m2 2 20 20",
    "M8.668 3.01A6 6 0 0 1 18 8c0 2.687.77 4.653 1.707 6.05",
  ],
  close: ["M18 6 6 18", "m6 6 12 12"],
  image: [
    "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z",
    "M9 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
    "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21",
  ],
  video: [
    "m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5",
    "M4 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z",
  ],
  file: [
    "M8 2h6.4a2.4 2.4 0 0 1 1.7.706l3.594 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z",
    "M14 2v5a1 1 0 0 0 1 1h5",
    "M10 9H8",
    "M16 13H8",
    "M16 17H8",
  ],
  chevron: ["m9 18 6-6-6-6"],
  // Branch in a new chat: the two-commit fork the desktop app uses.
  branch: ["M15 6a9 9 0 0 0-9 9V3", "M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"],
  copy: [
    "M10 8h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z",
    "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2",
  ],
  check: ["M20 6 9 17l-5-5"],
  // Regenerate: the clockwise circle arrow every chat UI uses for it.
  redo: ["M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8", "M21 3v5h-5"],
  pencil: [
    "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z",
    "m15 5 4 4",
  ],
  trash: [
    "M10 11v6",
    "M14 11v6",
    "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6",
    "M3 6h18",
    "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
  ],
  // Session as context: it goes down into the composer.
  download: ["M12 3v14", "m6 11 6 6 6-6", "M5 21h14"],
  alert: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M12 8v4", "M12 16h.01"],
  // Todo status glyphs. Same 24 grid, so the list lines up with everything
  // else in a row instead of using a font's ○ ◐ ✓/✕ (which never share a size).
  circle: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z"],
  circleDot: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"],
};

/** Icons whose shape is filled rather than stroked. */
const FILLED: ReadonlySet<IconName> = new Set<IconName>(["stop"]);

/**
 * Icons drawn as circles instead of paths: `[cx, cy, r]`.
 *
 * The three-dot menu has to read as three even dots at 18px, and a 1.75px
 * stroked zero-radius segment renders as a faint comma rather than a dot.
 */
const CIRCLES: Partial<Record<IconName, [number, number, number][]>> = {
  dots: [
    [6, 12, 1.55],
    [12, 12, 1.55],
    [18, 12, 1.55],
  ],
};

/** Icons drawn as a rounded rect: `[x, y, w, h, r]`. */
const RECTS: Partial<Record<IconName, [number, number, number, number, number][]>> = {
  stop: [[8, 8, 8, 8, 2]],
};

export interface IconProps {
  name: IconName;
  /** Rendered size in px. */
  size?: number;
  /** Extra class, for the few places that animate a glyph. */
  className?: string;
}

/**
 * One icon.
 *
 * `aria-hidden` always: every icon in this page sits inside a button that
 * already carries a `title` and `aria-label`, and a labelled *and* announced
 * glyph is read twice.
 *
 * The `hb-icon` class — not an inline style — carries `display: block`: an
 * inline SVG is a baseline-aligned inline box, and the few px of descender it
 * leaves under itself is exactly the vertical drift this set exists to remove.
 */
export function Icon(sdk: HermesPluginSdk, props: IconProps) {
  const { React } = sdk;
  const size = props.size ?? 18;
  const filled = FILLED.has(props.name);
  const circles = CIRCLES[props.name] ?? [];
  const rects = RECTS[props.name] ?? [];
  const paths = circles.length || rects.length ? [] : PATHS[props.name];
  return React.createElement(
    "svg",
    {
      className: props.className ? `hb-icon ${props.className}` : "hb-icon",
      // The icon's identity as an attribute: a script (or the acceptance suite)
      // cannot read a glyph off an SVG the way it could off a text character,
      // and "which icon is showing" is exactly what the copy button's
      // confirmation state is.
      "data-icon": props.name,
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: filled || circles.length || rects.length ? "currentColor" : "none",
      stroke: filled || circles.length || rects.length ? "none" : "currentColor",
      strokeWidth: 1.75,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
      focusable: "false",
    },
    ...paths.map((d, index) => React.createElement("path", { key: `p${index}`, d })),
    ...circles.map(([cx, cy, r], index) =>
      React.createElement("circle", { key: `c${index}`, cx, cy, r }),
    ),
    ...rects.map(([x, y, w, h, rx], index) =>
      React.createElement("rect", { key: `r${index}`, x, y, width: w, height: h, rx }),
    ),
  );
}
