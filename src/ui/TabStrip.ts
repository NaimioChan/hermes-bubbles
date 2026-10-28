/**
 * The tab strip across the top of the chat area.
 *
 * Open sessions live up here (one tab each); the history of stored sessions is a
 * panel on the right. Splitting the two is deliberate — "what I have open" and
 * "what exists" are different questions, and a single merged list makes it
 * impossible to tell whether clicking a row switches to it or opens a copy.
 *
 * The right-hand cluster is the same three round buttons the phone floats over
 * the transcript (refresh / new chat / "···"), so one visual language covers both
 * sizes; the desktop keeps its strip and simply hosts them there.
 */

import { messagesFor, type Locale } from "../core/i18n";
import { tabLabel, type SessionTab } from "../core/sessions";
import type { HermesPluginSdk } from "./sdk";
import { Icon } from "./icons";

export interface TabStripProps {
  sdk: HermesPluginSdk;
  locale: Locale;
  tabs: readonly SessionTab[];
  activeKey: string | null;
  runningKeys: readonly string[];
  /**
   * Tabs whose session has an approval / clarify card waiting.
   *
   * A socket receives every session's requests, so a question can arrive for a
   * session that is not on screen. Before this marker the only way to find out
   * was to switch tabs and notice a card that had been sitting there — or, worse,
   * to read the question in the wrong session, which is where it used to be
   * drawn. The dot says "this one needs an answer" without moving the reader.
   */
  waitingKeys: readonly string[];
  historyOpen: boolean;
  onFocus: (key: string) => void;
  onClose: (key: string) => void;
  onNew: () => void;
  /** Re-read this chat's transcript (not the browser page). */
  onRefreshChat: () => void;
  onToggleHistory: () => void;
}

export function TabStrip(props: TabStripProps) {
  const { sdk } = props;
  const { React } = sdk;
  const t = messagesFor(props.locale);

  return React.createElement(
    "div",
    {
      className: "flex shrink-0 items-stretch gap-1 px-2 py-1.5",
      style: { borderBottom: "1px solid var(--color-border)", minHeight: "2.5rem" },
    },

    // Scrolling tab list: many tabs must not push the buttons off screen.
    React.createElement(
      "div",
      { className: "hb-flex-fill flex items-center gap-1 overflow-x-auto hb-scroll" },
      props.tabs.length === 0
        ? React.createElement(
            "span",
            { className: "hb-text-micro px-2", style: { color: "var(--color-muted-foreground)" } },
            t.emptyTabs,
          )
        : props.tabs.map((tab) =>
            React.createElement(
              "button",
              {
                key: tab.key,
                type: "button",
                // Stable hook for the end-to-end script: tests must not depend on
                // the visible label, which is localized.
                "data-hb": "tab",
                "data-hb-key": tab.key,
                title: tabLabel(tab, t),
                className: "hb-tab group flex hb-max-w-22ch shrink-0 items-center gap-1.5 px-2.5 py-1 text-xs",
                style: {
                  background: tab.key === props.activeKey ? "var(--color-muted)" : "transparent",
                  color:
                    tab.key === props.activeKey
                      ? "var(--color-card-foreground)"
                      : "var(--color-muted-foreground)",
                  borderRadius: "calc(var(--radius) * 0.6)",
                  boxShadow: tab.key === props.activeKey ? "inset 0 0 0 1px var(--color-border)" : "none",
                },
                onClick: () => props.onFocus(tab.key),
              },
              props.runningKeys.includes(tab.key)
                ? React.createElement("span", { className: "hb-caret shrink-0", style: { color: "var(--color-primary)" } }, "●")
                : null,
              // "Needs an answer": a card is waiting in this tab. Static, not
              // animated — the running caret already owns motion, and a second
              // blinking dot would read as the same thing.
              props.waitingKeys.includes(tab.key)
                ? React.createElement(
                    "span",
                    {
                      className: "hb-wait-dot shrink-0",
                      title: t.waitingForAnswer,
                      "data-hb": "tab-waiting",
                      "aria-label": t.waitingForAnswer,
                    },
                    "?",
                  )
                : null,
              React.createElement("span", { className: "hb-truncate" }, tabLabel(tab, t)),
              React.createElement(
                "span",
                {
                  role: "button",
                  title: t.closeTab,
              "data-hb": "tab-close",
                  className: "hb-tab-close shrink-0 cursor-pointer px-0.5",
                  style: { color: "var(--color-muted-foreground)" },
                  onClick: (event: { stopPropagation: () => void }) => {
                    event.stopPropagation();
                    props.onClose(tab.key);
                  },
                },
                "×",
              ),
            ),
          ),
    ),

    // Actions, pinned right so they never scroll away. Same round buttons as the
    // phone's floating pair, with the same press motion — one visual language for
    // "refresh the chat" and "open the chat list" on both sizes. The word
    // "History" became the "···" here, and the notification switch moved into the
    // composer's "···" menu, where it is a labelled row instead of a glyph whose
    // meaning needed a tooltip.
    React.createElement(
      "div",
      { className: "flex shrink-0 items-center gap-1" },
      React.createElement(
        "button",
        {
          type: "button",
          title: t.refreshChat,
          "aria-label": t.refreshChat,
          "data-hb": "refresh-chat",
          className: "hb-strip-btn",
          onClick: () => void props.onRefreshChat(),
        },
        Icon(sdk, { name: "refresh", size: 16 }),
      ),
      React.createElement(
        "button",
        {
          type: "button",
          title: t.newChat,
          "aria-label": t.newChat,
          "data-hb": "tab-new",
          className: "hb-strip-btn",
          onClick: props.onNew,
        },
        Icon(sdk, { name: "plus", size: 17 }),
      ),
      React.createElement(
        "button",
        {
          type: "button",
          title: props.historyOpen ? t.collapse : t.history,
          "aria-label": props.historyOpen ? t.collapse : t.history,
          "data-hb": "history-toggle",
          "data-open": props.historyOpen ? "true" : "false",
          "aria-expanded": props.historyOpen,
          className: "hb-strip-btn",
          style: {
            color: props.historyOpen ? "var(--color-card-foreground)" : "var(--color-muted-foreground)",
            background: props.historyOpen ? "var(--color-muted)" : "transparent",
          },
          onClick: props.onToggleHistory,
        },
        Icon(sdk, { name: "dots", size: 18 }),
      ),
    ),
  );
}
