/**
 * The Plugin SDK surface, as this bundle consumes it.
 *
 * The host exposes React, UI primitives, and auth-aware fetchers on `window`.
 * Nothing here may import React at runtime — the plugin bundle ships without it
 * and takes the host's instance, so the two share one React (AGENTS.md 铁律 3).
 */

import type * as ReactNS from "react";

/**
 * The host types this map permissively (`Record<string, ComponentType<never>>`)
 * so plugins can render any primitive without the host's internal prop types.
 * Mirror that here rather than inventing a stricter shape the host would not
 * satisfy.
 */
export type SdkComponents = Record<string, ReactNS.ComponentType<never>>;

export interface HermesPluginSdk {
  sdkVersion: string;
  React: typeof ReactNS;
  /**
   * A **curated subset** of React's hooks — the host exposes
   * useState/useEffect/useCallback/useMemo/useRef/useContext/createContext and
   * two of its own, but not `useSyncExternalStore`. Prefer `sdk.React` for
   * anything not listed here; `React` is the full instance.
   */
  hooks: {
    useState: typeof ReactNS.useState;
    useEffect: typeof ReactNS.useEffect;
    useCallback: typeof ReactNS.useCallback;
    useMemo: typeof ReactNS.useMemo;
    useRef: typeof ReactNS.useRef;
    [key: string]: unknown;
  };
  components: SdkComponents;
  utils: {
    cn: (...classes: Array<string | false | null | undefined>) => string;
    timeAgo: (ts: number) => string;
    isoTimeAgo: (iso: string) => string;
  };
  fetchJSON: <T = unknown>(url: string, init?: RequestInit) => Promise<T>;
  buildWsUrl: (path: string, params?: Record<string, string>) => Promise<string>;
}

export interface PluginRegistry {
  register(name: string, component: ReactNS.ComponentType): void;
  registerSlot(name: string, slot: string, component: ReactNS.ComponentType): void;
}

declare global {
  interface Window {
    __HERMES_PLUGIN_SDK__?: HermesPluginSdk;
    __HERMES_PLUGINS__?: PluginRegistry;
  }
}

/** The SDK, or a thrown error the bundle's guard turns into a console message. */
export function requireSdk(): HermesPluginSdk {
  const sdk = typeof window !== "undefined" ? window.__HERMES_PLUGIN_SDK__ : undefined;
  if (!sdk || !sdk.React) {
    throw new Error("hermes-bubbles: plugin SDK not available (window.__HERMES_PLUGIN_SDK__ missing)");
  }
  return sdk;
}
