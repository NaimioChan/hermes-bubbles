/**
 * "Am I on a phone-sized screen?" — one answer for the components that have to
 * draw a DIFFERENT layout rather than just restyle one.
 *
 * Most of the phone adaptation is CSS: `style.css` owns a single
 * `@media (max-width: 768px)` block, and the same shipped bundle serves both.
 * But some of it cannot be CSS, because the two layouts are not the same
 * elements:
 *
 *   - the tab strip is REMOVED on a phone, and with it the only entry points to
 *     new-chat and history — those move into a drawer with its own open/closed
 *     state, which is React state, not a style;
 *   - the composer's model / reasoning chips are replaced by a menu button that
 *     opens the SAME picker, so the picker's position has to know.
 *
 * So this hook reports the breakpoint as state. It is the same number the media
 * query uses (`MOBILE_MAX_PX`), and the media query is the source of truth for
 * anything that CAN be done in CSS — keep the two in step, and prefer CSS.
 *
 * `matchMedia` rather than a resize handler: it fires once per crossing instead
 * of on every pixel, and it reads the same width the media query does.
 */

import type { HermesPluginSdk } from "./sdk";

/** Must equal the `max-width` of the responsive block in `style.css`. */
export const MOBILE_MAX_PX = 768;

export function useMobile(sdk: HermesPluginSdk): boolean {
  const { useState, useEffect } = sdk.hooks;
  const query = `(max-width: ${MOBILE_MAX_PX}px)`;

  const [mobile, setMobile] = useState<boolean>(() => {
    try {
      return window.matchMedia(query).matches;
    } catch {
      // No matchMedia (an ancient engine): the desktop layout is the safe
      // default — it is the one every control is designed for.
      return false;
    }
  });

  useEffect(() => {
    let media: MediaQueryList;
    try {
      media = window.matchMedia(query);
    } catch {
      return;
    }
    const sync = () => setMobile(media.matches);
    // Re-read on subscribe: the window may have been resized between the first
    // render and this effect (a phone rotating, a devtools resize).
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [query]);

  return mobile;
}
