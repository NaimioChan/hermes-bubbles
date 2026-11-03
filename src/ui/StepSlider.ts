/**
 * A discrete horizontal slider for one setting with a short list of tiers.
 *
 * **Why not `<input type="range">`.** The native control cannot be styled into
 * what this row needs. Two specific limits, both hit while building it: the
 * thumb is a pseudo-element, so it cannot take a fill, a border AND an outer
 * focus ring without three separate browser-specific rules; and the thumb's
 * CENTRE only travels between `[radius, width - radius]`, so a track painted on
 * the input's own background never lines up with the knob at either end. The
 * second one is not tunable — it drifts as the knob moves, which is exactly the
 * complaint that killed the first version.
 *
 * **What this copies.** The shape shadcn/Radix ship (a rounded track, a filled
 * range, a bordered circular thumb that grows a ring on hover and focus), with
 * the travel math done once, in one place: the thumb's box goes from `0` to
 * `100% - THUMB` and the fill ends at the thumb's centre, so the two are
 * aligned by construction rather than by two matching percentages.
 *
 * **Commits on release, not on move.** The caller writes this value to the
 * backend (`config.set key=reasoning`). A drag across seven tiers fires one
 * change per tier crossed, which is seven writes for one gesture, so `onCommit`
 * only runs on pointer up / key up. `onPreview` reports the in-flight index so
 * the label beside the track can follow the thumb while it moves.
 *
 * No glyphs, no host classes, no `innerHTML`: geometry in CSS, numbers via
 * inline `left` / `width`.
 */

import type { HermesPluginSdk } from "./sdk";

/** Thumb diameter in px. Shared by the CSS (`.hb-slider-thumb`) and the math
 * below — the fill has to stop at its centre, so the two cannot drift apart. */
export const SLIDER_THUMB_PX = 18;

export interface StepSliderProps {
  sdk: HermesPluginSdk;
  /** Ordered tiers; index is what both callbacks speak in. */
  levels: readonly string[];
  /** Committed index. */
  index: number;
  /**
   * Index under the thumb mid-drag, owned by the caller because the label
   * beside the track shows it too. `null` when no drag is in flight.
   */
  preview: number | null;
  /** Accessible name ("Reasoning effort"). */
  label: string;
  /** Spoken value ("High"), because the index means nothing on its own. */
  valueText: string;
  /** Thumb moved but nothing committed yet; `null` when the drag ends. */
  onPreview: (index: number | null) => void;
  /** Pointer/keyboard release: this is the value the caller should persist. */
  onCommit: (index: number) => void;
}

export function StepSlider(props: StepSliderProps) {
  const { sdk } = props;
  const { React } = sdk;
  const { useCallback, useRef, useState } = React;

  const trackRef = useRef<HTMLDivElement | null>(null);
  /** True between pointer down and up; the only thing that makes a move a drag.
   * State, not a ref: the thumb's press styling is a render output, and a ref
   * would leave `data-dragging` frozen on the first frame. */
  const [dragging, setDragging] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [focused, setFocused] = useState(false);

  const last = Math.max(0, props.levels.length - 1);
  const committed = Math.min(last, Math.max(0, props.index));
  const index = props.preview == null ? committed : Math.min(last, Math.max(0, props.preview));
  const pct = last === 0 ? 0 : index / last;

  /** Which tier a viewport x sits on, clamped to the track. */
  const indexAt = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el) return committed;
      const rect = el.getBoundingClientRect();
      const usable = Math.max(1, rect.width - SLIDER_THUMB_PX);
      const t = (clientX - rect.left - SLIDER_THUMB_PX / 2) / usable;
      return Math.min(last, Math.max(0, Math.round(t * last)));
    },
    [committed, last],
  );

  const commit = useCallback(
    (next: number) => {
      props.onPreview(null);
      if (next !== committed) props.onCommit(next);
    },
    [committed, props.onPreview, props.onCommit],
  );

  type Pointerish = {
    clientX: number;
    pointerId: number;
    pointerType?: string;
    button?: number;
    currentTarget: HTMLElement;
    preventDefault: () => void;
  };

  const onPointerDown = (event: Pointerish) => {
    // Left button only; a touch or pen has no button 1/2 to exclude.
    if (event.pointerType === "mouse" && typeof event.button === "number" && event.button !== 0) return;
    event.preventDefault();
    // Capture so a drag that leaves the 20px hit area keeps moving the thumb and
    // still delivers its pointerup — otherwise the value silently never commits.
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* capture is a nicety; the handlers below work without it */
    }
    setDragging(true);
    const next = indexAt(event.clientX);
    props.onPreview(next);
  };

  const onPointerMove = (event: Pointerish) => {
    if (!dragging) return;
    props.onPreview(indexAt(event.clientX));
  };

  const onPointerUp = (event: Pointerish) => {
    if (!dragging) return;
    setDragging(false);
    commit(indexAt(event.clientX));
  };

  const onPointerCancel = () => {
    if (!dragging) return;
    setDragging(false);
    commit(committed);
  };

  const onKeyDown = (event: { key: string; preventDefault: () => void }) => {
    const step = (delta: number) => {
      event.preventDefault();
      commit(Math.min(last, Math.max(0, index + delta)));
    };
    switch (event.key) {
      case "ArrowRight":
      case "ArrowUp":
        step(1);
        return;
      case "ArrowLeft":
      case "ArrowDown":
        step(-1);
        return;
      case "PageUp":
        step(3);
        return;
      case "PageDown":
        step(-3);
        return;
      case "Home":
        step(-last);
        return;
      case "End":
        step(last);
        return;
      default:
        return;
    }
  };

  const ring = (strength: number) =>
    `0 0 0 4px color-mix(in oklab, var(--color-primary) ${strength}%, transparent), 0 1px 3px rgba(0, 0, 0, 0.35)`;

  return React.createElement(
    "div",
    {
      className: "hb-slider",
      "data-hb": "reasoning-range",
      "data-state": props.levels[index] ?? "",
      "data-dragging": dragging ? "true" : "false",
      ref: trackRef,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onPointerEnter: () => setHovering(true),
      onPointerLeave: () => setHovering(false),
    },
    // The visual track. The wrapper is the hit area (20px tall) so the control
    // is grabbable without being visually heavy.
    React.createElement("div", { className: "hb-slider-track" }),
    React.createElement("div", {
      className: "hb-slider-fill",
      style: { width: `calc(${SLIDER_THUMB_PX / 2}px + (100% - ${SLIDER_THUMB_PX}px) * ${pct})` },
    }),
    React.createElement("div", {
      className: "hb-slider-thumb",
      "data-hb": "reasoning-thumb",
      role: "slider",
      tabIndex: 0,
      "aria-label": props.label,
      "aria-valuemin": 0,
      "aria-valuemax": last,
      "aria-valuenow": index,
      "aria-valuetext": props.valueText,
      "aria-orientation": "horizontal",
      style: {
        left: `calc((100% - ${SLIDER_THUMB_PX}px) * ${pct})`,
        boxShadow: focused || hovering ? ring(focused ? 24 : 16) : undefined,
      },
      onKeyDown,
      onFocus: () => setFocused(true),
      onBlur: () => setFocused(false),
    }),
  );
}