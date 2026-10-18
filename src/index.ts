/**
 * Bundle entry point.
 *
 * The host loads this file as a plain `<script>` after exposing
 * `window.__HERMES_PLUGIN_SDK__` and `window.__HERMES_PLUGINS__`, then waits up
 * to 2 s for `register()` to be called with the manifest's plugin name.
 *
 * Everything that can fail is caught: an exception thrown out of this IIFE
 * leaves the dashboard with no chat page at all and only a console line, which
 * is exactly the kind of silent breakage that is hard to diagnose from a
 * screenshot.
 */

import { requireSdk } from "./ui/sdk";
import { ChatPage } from "./ui/ChatPage";
import { currentLocale } from "./ui/useLocale";
import { messagesFor } from "./core/i18n";

(function main() {
  const sdk = requireSdk();
  const registry = window.__HERMES_PLUGINS__;
  if (!registry) {
    console.error("hermes-bubbles: window.__HERMES_PLUGINS__ is missing — the dashboard is too old for plugins.");
    return;
  }

  const { React } = sdk;

  function Root() {
    try {
      return React.createElement(ChatPage, { sdk });
    } catch (error) {
      console.error("hermes-bubbles: render failed", error);
      return React.createElement(
        "div",
        { style: { padding: "1rem", color: "var(--color-destructive)" } },
        messagesFor(currentLocale()).renderFailed(
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  registry.register("hermes-bubbles", Root);
})();
