/**
 * The tab strip across the top of the chat area.
 *
 * Open sessions live up here (one tab each); the history of stored sessions is a
 * panel on the right. Splitting the two is deliberate — "what I have open" and
 * "what exists" are different questions, and a single merged list makes it
 * impossible to tell whether clicking a row switches to it or opens a copy.
 */

import { messagesFor, type Locale } from "../core/i18n";
import { tabLabel, type SessionTab } from "../core/sessions";
import type { HermesPluginSdk } from "./sdk";

export interface TabStripProps {
  sdk: HermesPluginSdk;
  locale: Locale;
  tabs: readonly SessionTab[];
  activeKey: string | null;
  runningKeys: readonly string[];
  historyOpen: boolean;
  /** Desktop notifications: on/off switch, and whether the browser blocks them. */
  notifyOn: boolean;
  notifyBlocked: boolean;
  onToggleNotify: () => void;
  onFocus: (key: string) => void;
  onClose: (key: string) => void;
  onNew: () => void;
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
                title: tabLabel(tab),
                className: "group flex hb-max-w-22ch shrink-0 items-center gap-1.5 px-2.5 py-1 text-xs",
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
              React.createElement("span", { className: "hb-truncate" }, tabLabel(tab)),
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

    // Actions, pinned right so they never scroll away.
    React.createElement(
      "div",
      { className: "flex shrink-0 items-center gap-1" },
      React.createElement(
        "button",
        {
          type: "button",
          title: props.notifyBlocked ? t.notifyBlockedTitle : props.notifyOn ? t.notifyOnTitle : t.notifyOffTitle,
          "data-hb": "notify-toggle",
          "data-on": props.notifyOn ? "true" : "false",
          className: "cursor-pointer px-2 py-1 text-xs leading-none",
          style: {
            color: props.notifyOn ? "var(--color-card-foreground)" : "var(--color-muted-foreground)",
            opacity: props.notifyBlocked ? 0.45 : 1,
          },
          onClick: props.onToggleNotify,
        },
        props.notifyOn ? "◉" : "◌",
      ),
      React.createElement(
        "button",
        {
          type: "button",
          title: t.newChat,
          "data-hb": "tab-new",
          className: "cursor-pointer px-2 py-1 text-sm leading-none",
          style: { color: "var(--color-muted-foreground)" },
          onClick: props.onNew,
        },
        "+",
      ),
      React.createElement(
        "button",
        {
          type: "button",
          title: props.historyOpen ? t.collapse : t.history,
          "data-hb": "history-toggle",
          className: "cursor-pointer px-2 py-1 text-xs",
          style: {
            color: props.historyOpen ? "var(--color-card-foreground)" : "var(--color-muted-foreground)",
            background: props.historyOpen ? "var(--color-muted)" : "transparent",
            borderRadius: "calc(var(--radius) * 0.6)",
          },
          onClick: props.onToggleHistory,
        },
        t.history,
      ),
    ),
  );
}
