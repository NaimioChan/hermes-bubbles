/**
 * Reads the dashboard's current language and keeps it live.
 *
 * The DOM reads live here rather than in `core/i18n.ts`, which stays pure
 * (AGENTS.md 铁律 1). See that file for why there is no RPC for this.
 *
 * Two signals, because neither alone is enough:
 *
 *   - `localStorage['hermes-locale']` is the dashboard's own stored choice. A
 *     `storage` event fires when ANOTHER tab changes it, which is the case when
 *     the user switches language in a second tab.
 *   - `<html lang>` is what the dashboard mirrors its choice onto. A
 *     `MutationObserver` catches a change made in THIS tab, where no `storage`
 *     event fires. It also covers the dashboard switching by a path that does
 *     not touch localStorage.
 *
 * Re-reading on either signal means a switch is picked up without a reload.
 *
 * Hooks come from the SDK, never from an `react` import: the bundle ships
 * without React and takes the host's instance (AGENTS.md 铁律 3). Importing
 * `react` here fails the build, which is how this was caught.
 */

import { LOCALE_STORAGE_KEY, normalizeLocale, type Locale } from "../core/i18n";
import type { HermesPluginSdk } from "./sdk";

function readLocale(): Locale {
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored) return normalizeLocale(stored);
  } catch {
    // Storage can throw in a sandboxed frame; the document signal still works.
  }
  return normalizeLocale(document.documentElement.lang);
}

export function useLocale(sdk: HermesPluginSdk): Locale {
  const { useState, useEffect } = sdk.hooks;
  const [locale, setLocale] = useState<Locale>(() => {
    try {
      return readLocale();
    } catch {
      return normalizeLocale(null);
    }
  });

  useEffect(() => {
    let alive = true;
    const sync = () => {
      if (!alive) return;
      const next = readLocale();
      setLocale((current: Locale) => (current === next ? current : next));
    };

    // Another tab changed it.
    window.addEventListener("storage", sync);
    // This tab changed it (the dashboard rewrites <html lang>).
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });

    // Catch a change that landed between the initial render and this effect.
    sync();

    return () => {
      alive = false;
      window.removeEventListener("storage", sync);
      observer.disconnect();
    };
  }, []);

  return locale;
}
