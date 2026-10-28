/**
 * The plugin's own icon set.
 *
 * Inline SVG through `React.createElement`, not an icon package and not a font:
 * the bundle ships without extra dependencies, the glyphs inherit `currentColor`
 * so they follow the theme, and there is no webfont to fetch from a host that
 * may not serve one.
 *
 * Every icon is drawn on a 24-unit grid with `stroke-width: 1.7` and round caps,
 * which is the weight that reads at a 16–20px button size. Nothing here is a
 * "brand" mark; these are the six or seven shapes the page actually needs.
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
  | "chevron";

/** Path data per icon: `[d, ...]` drawn with one shared stroke style. */
const PATHS: Record<IconName, string[]> = {
  // Circular arrow: the chat-page refresh (data only, not a browser reload).
  refresh: ["M20 12a8 8 0 1 1-2.34-5.66", "M20 4v4h-4"],
  // Three dots: the menu affordance ("···" as the brief calls it).
  dots: ["M6 12h.01", "M12 12h.01", "M18 12h.01"],
  send: ["M12 19V5", "M5.5 11.5 12 5l6.5 6.5"],
  // A filled square is the universal stop; `fill` is set per icon below.
  stop: ["M8 8h8v8H8z"],
  // Arrow into a tray line: delivering the message into a running turn.
  insert: ["M12 15V4", "M7 9l5-5 5 5", "M4 20h16"],
  paperclip: [
    "M20 11.5 12.2 19.3a4.2 4.2 0 0 1-6-6l8-8a3 3 0 0 1 4.2 4.2l-8 8a1.8 1.8 0 0 1-2.5-2.5l7.3-7.3",
  ],
  plus: ["M12 5v14", "M5 12h14"],
  // Model: a chip.
  model: ["M8 8h8v8H8z", "M12 3v5", "M12 16v5", "M3 12h5", "M16 12h5"],
  // Reasoning effort: a dial.
  reasoning: ["M12 20a8 8 0 1 1 8-8", "M12 12l4-4"],
  bell: ["M18 16H6l1.4-2.1V10a4.6 4.6 0 0 1 9.2 0v3.9z", "M10 19a2 2 0 0 0 4 0"],
  bellOff: ["M18 16H6l1.4-2.1V10a4.6 4.6 0 0 1 9.2 0v3.9z", "M10 19a2 2 0 0 0 4 0", "M4 4l16 16"],
  close: ["M6 6l12 12", "M18 6 6 18"],
  image: ["M4 5h16v14H4z", "M4 16l4.5-4.5 4 4", "M13 14l3-3 4 4", "M15.5 9h.01"],
  video: ["M4 6h11v12H4z", "M15 10l5-3v10l-5-3"],
  file: ["M6 3h7l5 5v13H6z", "M13 3v5h5"],
  chevron: ["M9 6l6 6-6 6"],
};

/** Icons whose shape is filled rather than stroked. */
const FILLED: ReadonlySet<IconName> = new Set<IconName>(["stop"]);

/**
 * Icons drawn as circles instead of paths: `[cx, cy, r]`.
 *
 * The three-dot menu has to read as three even dots at 18px, and a 1.7px stroked
 * zero-length segment renders as a faint comma rather than a dot.
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
      className: props.className,
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: filled || circles.length || rects.length ? "currentColor" : "none",
      stroke: filled || circles.length || rects.length ? "none" : "currentColor",
      strokeWidth: 1.7,
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
